import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { hashRateLimitKey } from "../../worker/src/index.ts";
import { checkIpRateLimit } from "../../worker/src/d1.ts";
import serverIndex from "../../worker/src/generated/serverAnswerIndex.json";
import type { ClientRoomHydration } from "../../src/core/types.ts";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

beforeAll(async () => {
  const testEnv = env as unknown as TestEnv;
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
}, 30_000);

async function apiJson<T>(
  path: string,
  init: RequestInit = {},
  ip = "198.51.100.1"
): Promise<{ status: number; data: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", ip);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await SELF.fetch(`https://example.com${path}`, { ...init, headers });
  const data = (await res.json()) as T;
  return { status: res.status, data, headers: res.headers };
}

describe("PRB-005 Worker / Durable Object SQLite / D1 Runtime Verification", () => {
  it("TEST-005 & TEST-004: min 2-player start, anti-spoiler stripping, sync reveal, ready gate & idempotency", async () => {
    const created = await apiJson<{
      roomCode: string;
      playerToken: string;
      hydration: ClientRoomHydration;
    }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          hostName: "Devon",
        }),
      },
      "203.0.113.10"
    );

    expect(created.status).toBe(201);
    const { roomCode, playerToken: hostToken } = created.data;
    expect(created.data.hydration.players[0]?.color_index).toBe(0);

    // Minimum 2 players guard: cannot start with 1 player
    const soloStart = await apiJson<{ code: string }>(
      `/api/rooms/${roomCode}/start`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hostToken}` },
      },
      "203.0.113.10"
    );
    expect(soloStart.status).toBe(409);

    const joined = await apiJson<{ playerToken: string; hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/join`,
      {
        method: "POST",
        body: JSON.stringify({ displayName: "Devon" }), // Duplicate -> Devon #2
      },
      "203.0.113.11"
    );
    expect(joined.status).toBe(200);
    const guestP = joined.data.hydration.players.find((p) => p.display_name === "Devon #2")!;
    expect(guestP).toBeTruthy();
    expect(guestP.color_index).toBe(1);
    const guestToken = joined.data.playerToken;

    const started = await apiJson<{ hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/start`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hostToken}` },
      },
      "203.0.113.10"
    );
    expect(started.status).toBe(200);
    const q0 = started.data.hydration.current_question!;
    expect(q0).toBeTruthy();
    expect(q0.options_romanization?.length).toBe(4);

    // TEST-005: Verify correct_index & deterministic_note are strictly absent pre-reveal
    const rawJson = JSON.stringify(started.data);
    expect(rawJson).not.toContain("correct_index");
    expect(rawJson).not.toContain("deterministic_note");

    // Host submits answer first -> synchronized reveal waits for Guest (reveal === null)
    const rawEntry = (
      serverIndex as Record<string, { options_4: string[]; correct_index: number }>
    )[q0.item_id]!;
    const correctAnswerText = rawEntry.options_4[rawEntry.correct_index]!;
    const correctIdx = q0.options_4.indexOf(correctAnswerText);
    expect(correctIdx).toBeGreaterThanOrEqual(0);

    const firstSubmit = await apiJson<{
      alreadyRecorded: boolean;
      reveal: unknown;
      hydration: ClientRoomHydration;
    }>(
      `/api/rooms/${roomCode}/answer`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ roundIndex: 0, chosenIndex: correctIdx, idempotencyKey: "k-host-r0" }),
      },
      "203.0.113.10"
    );
    expect(firstSubmit.status).toBe(200);
    expect(firstSubmit.data.alreadyRecorded).toBe(false);
    expect(firstSubmit.data.reveal).toBeNull();
    expect(firstSubmit.data.hydration.round_phase).toBe("question");

    // Duplicate retry must NOT double-score
    const retrySubmit = await apiJson<{ alreadyRecorded: boolean; hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/answer`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ roundIndex: 0, chosenIndex: correctIdx, idempotencyKey: "k-host-r0" }),
      },
      "203.0.113.10"
    );
    expect(retrySubmit.status).toBe(200);
    expect(retrySubmit.data.alreadyRecorded).toBe(true);
    const hostPlayer = retrySubmit.data.hydration.players.find((p) => p.role === "host")!;
    expect(hostPlayer.score).toBe(100);

    // Reconnect via /join with playerToken hydrates exact state without adding duplicate player
    const reconnected = await apiJson<{ playerToken: string; hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/join`,
      {
        method: "POST",
        body: JSON.stringify({ playerToken: guestToken }),
      },
      "203.0.113.11"
    );
    expect(reconnected.status).toBe(200);
    expect(reconnected.data.hydration.players.length).toBe(2);
    expect(reconnected.data.hydration.current_question?.item_id).toBe(q0.item_id);

    // Guest submits to trigger synchronized round reveal
    const guestAnswer = await apiJson<{
      reveal: { correct_index: number; deterministic_note: string } | null;
      hydration: ClientRoomHydration;
    }>(
      `/api/rooms/${roomCode}/answer`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify({ roundIndex: 0, chosenIndex: correctIdx, idempotencyKey: "k-guest-r0" }),
      },
      "203.0.113.11"
    );
    expect(guestAnswer.status).toBe(200);
    expect(guestAnswer.data.reveal?.correct_index).toBe(correctIdx);
    expect(guestAnswer.data.reveal?.deterministic_note.length).toBeGreaterThan(5);
    expect(guestAnswer.data.hydration.round_phase).toBe("reveal");

    // Synchronized Ready Gate: Host ready alone does NOT advance
    const hostReady = await apiJson<{ advanced: boolean; hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/ready`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${hostToken}` },
        body: JSON.stringify({ roundIndex: 0 }),
      },
      "203.0.113.10"
    );
    expect(hostReady.status).toBe(200);
    expect(hostReady.data.advanced).toBe(false);
    expect(hostReady.data.hydration.current_round).toBe(0);

    // Guest ready advances everyone simultaneously to Round 1
    const guestReady = await apiJson<{ advanced: boolean; hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/ready`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${guestToken}` },
        body: JSON.stringify({ roundIndex: 0 }),
      },
      "203.0.113.11"
    );
    expect(guestReady.status).toBe(200);
    expect(guestReady.data.advanced).toBe(true);
    expect(guestReady.data.hydration.current_round).toBe(1);
    expect(guestReady.data.hydration.round_phase).toBe("question");
    expect(guestReady.data.hydration.current_question?.round_index).toBe(1);
  }, 30_000);

  it("TEST-003: 30-player room join, Anime Trivia seeding & 24h async blind standings", async () => {
    const asyncRoom = await apiJson<{
      roomCode: string;
      playerToken: string;
      hydration: ClientRoomHydration;
    }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "trivia-anime-characters",
          pacingMode: "async24h",
          maxPlayers: 35,
          roundSeconds: 25,
          questionCount: 10,
          difficulty: "harder",
          hostName: "Sam",
        }),
      },
      "203.0.113.20"
    );
    expect(asyncRoom.status).toBe(201);
    expect(asyncRoom.data.hydration.question_count).toBe(10);
    expect(asyncRoom.data.hydration.difficulty).toBe("harder");
    const asyncCode = asyncRoom.data.roomCode;
    const samToken = asyncRoom.data.playerToken;

    const guestJoins = await Promise.all(
      Array.from({ length: 29 }, (_, idx) =>
        apiJson<{ playerToken: string; hydration: ClientRoomHydration }>(
          `/api/rooms/${asyncCode}/join`,
          {
            method: "POST",
            body: JSON.stringify({ displayName: `Guest${idx + 1}` }),
          },
          `203.0.113.${30 + idx + 1}`
        )
      )
    );
    for (const g of guestJoins) {
      expect(g.status).toBe(200);
    }
    const guestTokens = guestJoins.map((g) => g.data.playerToken);

    for (let r = 0; r < 10; r++) {
      const hyd = await apiJson<{ hydration: ClientRoomHydration }>(
        `/api/rooms/${asyncCode}/hydrate`,
        { headers: { Authorization: `Bearer ${samToken}` } },
        "203.0.113.20"
      );
      const q = hyd.data.hydration.current_question!;
      expect(q.subtrack_id).toBe("trivia-anime-characters");
      expect(JSON.stringify(q)).not.toContain("correct_index");
      const ans = await apiJson(
        `/api/rooms/${asyncCode}/answer`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${samToken}` },
          body: JSON.stringify({ roundIndex: r, chosenIndex: 0, idempotencyKey: `sam-r${r}` }),
        },
        "203.0.113.20"
      );
      expect(ans.status).toBe(200);
    }

    const guest1Hyd = await apiJson<{ hydration: ClientRoomHydration }>(
      `/api/rooms/${asyncCode}/hydrate`,
      { headers: { Authorization: `Bearer ${guestTokens[0]!}` } },
      "203.0.113.31"
    );
    const samAsSeenByGuest1 = guest1Hyd.data.hydration.players.find((p) => p.display_name === "Sam")!;
    expect(samAsSeenByGuest1.completed_all_rounds).toBe(true);
    expect(samAsSeenByGuest1.score).toBe(0);
    expect(samAsSeenByGuest1.results.every((r) => r === "pending")).toBe(true);
  }, 60_000);

  it("DEC-005: 10-player 5-round live room w/ Ready Gate uses single-row DO SQLite snapshot", async () => {
    const live10 = await apiJson<{ roomCode: string; playerToken: string }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-en-ja",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 20,
          hostName: "Host10",
        }),
      },
      "203.0.113.80"
    );
    const lCode = live10.data.roomCode;
    const joins = await Promise.all(
      Array.from({ length: 9 }, (_, idx) =>
        apiJson<{ playerToken: string }>(
          `/api/rooms/${lCode}/join`,
          { method: "POST", body: JSON.stringify({ displayName: `P${idx + 1}` }) },
          `203.0.113.${81 + idx + 1}`
        )
      )
    );
    const tokens = [live10.data.playerToken, ...joins.map((j) => j.data.playerToken)];

    await apiJson(
      `/api/rooms/${lCode}/start`,
      { method: "POST", headers: { Authorization: `Bearer ${tokens[0]!}` } },
      "203.0.113.80"
    );

    for (let r = 0; r < 5; r++) {
      await Promise.all(
        tokens.map((tok, p) =>
          apiJson(
            `/api/rooms/${lCode}/answer`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${tok}` },
              body: JSON.stringify({ roundIndex: r, chosenIndex: 1, idempotencyKey: `l10-${r}-${p}` }),
            },
            `203.0.113.${80 + p}`
          )
        )
      );
      await Promise.all(
        tokens.map((tok, p) =>
          apiJson(
            `/api/rooms/${lCode}/ready`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${tok}` },
              body: JSON.stringify({ roundIndex: r }),
            },
            `203.0.113.${80 + p}`
          )
        )
      );
    }

    const metricsRes = await apiJson<{
      metrics: { room_state_row_count: number; sqlite_write_ops: number; status: string };
    }>(
      `/api/rooms/${lCode}/metrics`,
      { headers: { Authorization: `Bearer ${tokens[0]!}` } },
      "203.0.113.80"
    );
    expect(metricsRes.data.metrics.status).toBe("completed");
    expect(metricsRes.data.metrics.room_state_row_count).toBe(1);
    expect(metricsRes.data.metrics.sqlite_write_ops).toBeLessThanOrEqual(130);
  }, 60_000);

  it("trivia-anime 15-question standard room seeds 15 distinct items & shuffles choices anti-spoiler", async () => {
    const created = await apiJson<{
      roomCode: string;
      playerToken: string;
      hydration: ClientRoomHydration;
    }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "trivia-anime",
          pacingMode: "async24h",
          maxPlayers: 10,
          roundSeconds: 25,
          questionCount: 15,
          difficulty: "standard",
          hostName: "OtakuHost",
        }),
      },
      "203.0.113.120"
    );

    expect(created.status).toBe(201);
    expect(created.data.hydration.track_id).toBe("trivia-anime");
    expect(created.data.hydration.question_count).toBe(15);
    expect(created.data.hydration.difficulty).toBe("standard");

    const { roomCode, playerToken } = created.data;
    const seenItemIds = new Set<string>();
    let permutedRounds = 0;

    for (let r = 0; r < 15; r++) {
      const hyd = await apiJson<{ hydration: ClientRoomHydration }>(
        `/api/rooms/${roomCode}/hydrate`,
        { headers: { Authorization: `Bearer ${playerToken}` } },
        "203.0.113.120"
      );
      expect(hyd.status).toBe(200);
      const q = hyd.data.hydration.current_question!;
      expect(q).toBeTruthy();
      expect(q.round_index).toBe(r);
      expect(q.subtrack_id).toBe("trivia-anime");

      const rawQJson = JSON.stringify(q);
      expect(rawQJson).not.toContain("correct_index");
      expect(rawQJson).not.toContain("deterministic_note");

      seenItemIds.add(q.item_id);
      const rawEntry = (
        serverIndex as Record<string, { options_4: string[]; correct_index: number }>
      )[q.item_id]!;
      expect(new Set(q.options_4)).toEqual(new Set(rawEntry.options_4));
      if (q.options_4.join("|") !== rawEntry.options_4.join("|")) {
        permutedRounds++;
      }

      const correctText = rawEntry.options_4[rawEntry.correct_index]!;
      const chosenIndex = q.options_4.indexOf(correctText);
      expect(chosenIndex).toBeGreaterThanOrEqual(0);

      const ans = await apiJson<{
        reveal: { correct_index: number } | null;
        hydration: ClientRoomHydration;
      }>(
        `/api/rooms/${roomCode}/answer`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${playerToken}` },
          body: JSON.stringify({
            roundIndex: r,
            chosenIndex,
            idempotencyKey: `anime15-r${r}`,
          }),
        },
        "203.0.113.120"
      );
      expect(ans.status).toBe(200);
      expect(ans.data.reveal?.correct_index).toBe(chosenIndex);
    }

    expect(seenItemIds.size).toBe(15);
    expect(permutedRounds).toBeGreaterThan(0);

    const finalHyd = await apiJson<{ hydration: ClientRoomHydration }>(
      `/api/rooms/${roomCode}/hydrate`,
      { headers: { Authorization: `Bearer ${playerToken}` } },
      "203.0.113.120"
    );
    expect(finalHyd.data.hydration.current_question).toBeNull();
    expect(finalHyd.data.hydration.completed_reveals.length).toBe(15);
    expect(finalHyd.data.hydration.players[0]?.score).toBe(1500);
  }, 30_000);

  it("fresh rooms use independent CSPRNG shuffle_salt & round_option_orders without leaking them and grade accurately", async () => {
    const createRoom = async (trackId: string, ip: string) =>
      apiJson<{ roomCode: string; playerToken: string; hydration: ClientRoomHydration }>(
        "/api/rooms",
        {
          method: "POST",
          body: JSON.stringify({
            trackId,
            pacingMode: "async24h",
            maxPlayers: 5,
            roundSeconds: 25,
            questionCount: 5,
            difficulty: "standard",
            hostName: "EntropyTester",
          }),
        },
        ip
      );

    const roomCharA = await createRoom("trivia-anime-characters", "203.0.113.201");
    const roomCharB = await createRoom("trivia-anime-characters", "203.0.113.202");
    const roomAnime = await createRoom("trivia-anime", "203.0.113.203");

    expect(roomCharA.status).toBe(201);
    expect(roomCharB.status).toBe(201);
    expect(roomAnime.status).toBe(201);

    for (const res of [roomCharA, roomCharB, roomAnime]) {
      const serialized = JSON.stringify(res.data);
      expect(serialized).not.toContain("shuffle_salt");
      expect(serialized).not.toContain("round_option_orders");
      expect(serialized).not.toContain("correct_index");
    }

    // Two freshly created rooms on the same track should not hydrate identical question/option orders
    const qA0 = roomCharA.data.hydration.current_question!;
    const qB0 = roomCharB.data.hydration.current_question!;
    expect(
      qA0.item_id !== qB0.item_id || qA0.options_4.join("|") !== qB0.options_4.join("|")
    ).toBe(true);

    // Grade shuffled indices accurately on both trivia-anime-characters and trivia-anime
    for (const room of [roomCharA.data, roomAnime.data]) {
      const q = room.hydration.current_question!;
      const rawEntry = (
        serverIndex as Record<string, { options_4: string[]; correct_index: number }>
      )[q.item_id]!;
      const expectedAnswer = rawEntry.options_4[rawEntry.correct_index]!;
      const shuffledCorrectIdx = q.options_4.indexOf(expectedAnswer);
      expect(shuffledCorrectIdx).toBeGreaterThanOrEqual(0);

      const ans = await apiJson<{
        reveal: { correct_index: number } | null;
        hydration: ClientRoomHydration;
      }>(
        `/api/rooms/${room.roomCode}/answer`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${room.playerToken}` },
          body: JSON.stringify({
            roundIndex: 0,
            chosenIndex: shuffledCorrectIdx,
            idempotencyKey: `csprng-r0-${room.roomCode}`,
          }),
        },
        "203.0.113.204"
      );
      expect(ans.status).toBe(200);
      expect(ans.data.reveal?.correct_index).toBe(shuffledCorrectIdx);
      expect(ans.data.hydration.players[0]?.score).toBe(100);
    }
  }, 15_000);

  it("TEST-008: flag rate limit, room IP rate limit, and 85% daily quota shedding to Solo", async () => {
    const testEnv = env as unknown as TestEnv;
    const flagItemId = Object.keys(serverIndex)[0]!;
    for (let i = 0; i < 5; i++) {
      const okFlag = await apiJson(
        "/api/flags",
        { method: "POST", body: JSON.stringify({ itemId: flagItemId, reasonCode: "typo" }) },
        "198.51.100.77"
      );
      expect(okFlag.status).toBe(202);
    }
    const sixthFlag = await apiJson<{ code: string; retryAfterSec?: number }>(
      "/api/flags",
      { method: "POST", body: JSON.stringify({ itemId: flagItemId, reasonCode: "typo" }) },
      "198.51.100.77"
    );
    expect(sixthFlag.status).toBe(429);
    expect(sixthFlag.headers.get("Retry-After")).toBe("60");
    expect(sixthFlag.data.retryAfterSec).toBe(60);

    const utcDate = new Date().toISOString().slice(0, 10);
    await testEnv.DB.prepare(
      `INSERT INTO DAILY_QUOTA_COUNTER (utc_date, rooms_created, estimated_do_requests, estimated_do_writes)
       VALUES (?, 2600, 85000, 60000)
       ON CONFLICT(utc_date) DO UPDATE SET estimated_do_requests = 85000`
    )
      .bind(utcDate)
      .run();

    const shedRes = await apiJson<{ code: string; fallback: string }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-ko-en",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          hostName: "QuotaTest",
        }),
      },
      "198.51.100.99"
    );
    expect(shedRes.status).toBe(503);
    expect(shedRes.data.code).toBe("DAILY_QUOTA_REACHED");
    expect(shedRes.data.fallback).toBe("solo");

    // Reset daily quota counter so subsequent tests can create rooms cleanly
    await testEnv.DB.prepare(
      `UPDATE DAILY_QUOTA_COUNTER SET estimated_do_requests = 0, estimated_do_writes = 0 WHERE utc_date = ?`
    )
      .bind(utcDate)
      .run();
  }, 15_000);

  it("Live Sync leaveRoom: lobby host promotion, mid-question auto-reveal, mid-reveal auto-advance, and late-join 409 guards", async () => {
    // 1. Lobby leave & host promotion
    const lobbyRoom = await apiJson<{ roomCode: string; playerToken: string }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 2,
          roundSeconds: 25,
          hostName: "OrigHost",
        }),
      },
      "203.0.113.210"
    );
    expect(lobbyRoom.status).toBe(201);
    const code = lobbyRoom.data.roomCode;
    const hostTok = lobbyRoom.data.playerToken;

    const guestJoin = await apiJson<{ playerToken: string; hydration: ClientRoomHydration }>(
      `/api/rooms/${code}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "PromotedGuest" }) },
      "203.0.113.211"
    );
    expect(guestJoin.status).toBe(200);
    const guestTok = guestJoin.data.playerToken;

    // OrigHost leaves in lobby -> PromotedGuest becomes host, lobby omits OrigHost, and room cannot start with 1 active player
    const hostLeave = await apiJson<{ ok: boolean }>(
      `/api/rooms/${code}/leave`,
      { method: "POST", headers: { Authorization: `Bearer ${hostTok}` } },
      "203.0.113.210"
    );
    expect(hostLeave.status).toBe(200);

    const promotedHyd = await apiJson<{ hydration: ClientRoomHydration }>(
      `/api/rooms/${code}/hydrate`,
      { headers: { Authorization: `Bearer ${guestTok}` } },
      "203.0.113.211"
    );
    expect(promotedHyd.data.hydration.self_role).toBe("host");
    expect(promotedHyd.data.hydration.players.length).toBe(1);
    expect(promotedHyd.data.hydration.players[0]?.display_name).toBe("PromotedGuest");

    const soloStartAfterLeave = await apiJson<{ code: string }>(
      `/api/rooms/${code}/start`,
      { method: "POST", headers: { Authorization: `Bearer ${guestTok}` } },
      "203.0.113.211"
    );
    expect(soloStartAfterLeave.status).toBe(409);

    // Freed capacity allows 2 new guests? Max is 2, 1 active -> 1 more guest can join
    const thirdJoin = await apiJson<{ playerToken: string }>(
      `/api/rooms/${code}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "PlayerTwo" }) },
      "203.0.113.212"
    );
    expect(thirdJoin.status).toBe(200);

    // 2. Three-player active Live Sync: leave during question triggers immediate reveal; leave during reveal triggers advance
    const room3 = await apiJson<{ roomCode: string; playerToken: string }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          questionCount: 5,
          hostName: "P1",
        }),
      },
      "203.0.113.220"
    );
    const code3 = room3.data.roomCode;
    const p1Tok = room3.data.playerToken;
    const p2Join = await apiJson<{ playerToken: string }>(
      `/api/rooms/${code3}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "P2" }) },
      "203.0.113.221"
    );
    const p3Join = await apiJson<{ playerToken: string }>(
      `/api/rooms/${code3}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "P3" }) },
      "203.0.113.222"
    );
    const p2Tok = p2Join.data.playerToken;
    const p3Tok = p3Join.data.playerToken;

    await apiJson(
      `/api/rooms/${code3}/start`,
      { method: "POST", headers: { Authorization: `Bearer ${p1Tok}` } },
      "203.0.113.220"
    );

    // New non-reconnect guest rejected with 409 ROOM_ALREADY_STARTED
    const lateJoin = await apiJson<{ code: string }>(
      `/api/rooms/${code3}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "Latecomer" }) },
      "203.0.113.223"
    );
    expect(lateJoin.status).toBe(409);
    expect(lateJoin.data.code).toBe("ROOM_ALREADY_STARTED");

    // Existing player reconnect still works
    const p2Reconnect = await apiJson<{ playerToken: string }>(
      `/api/rooms/${code3}/join`,
      { method: "POST", body: JSON.stringify({ playerToken: p2Tok }) },
      "203.0.113.221"
    );
    expect(p2Reconnect.status).toBe(200);

    // P1 & P2 answer round 0, P3 leaves -> immediate reveal!
    await apiJson(
      `/api/rooms/${code3}/answer`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${p1Tok}` },
        body: JSON.stringify({ roundIndex: 0, chosenIndex: 0, idempotencyKey: "lr-p1-0" }),
      },
      "203.0.113.220"
    );
    await apiJson(
      `/api/rooms/${code3}/answer`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${p2Tok}` },
        body: JSON.stringify({ roundIndex: 0, chosenIndex: 1, idempotencyKey: "lr-p2-0" }),
      },
      "203.0.113.221"
    );
    const p3Leave = await apiJson<{ ok: boolean }>(
      `/api/rooms/${code3}/leave`,
      { method: "POST", headers: { Authorization: `Bearer ${p3Tok}` } },
      "203.0.113.222"
    );
    expect(p3Leave.status).toBe(200);

    const hydAfterQLeave = await apiJson<{ hydration: ClientRoomHydration }>(
      `/api/rooms/${code3}/hydrate`,
      { headers: { Authorization: `Bearer ${p1Tok}` } },
      "203.0.113.220"
    );
    expect(hydAfterQLeave.data.hydration.round_phase).toBe("reveal");
    const p3State = hydAfterQLeave.data.hydration.players.find((p) => p.display_name === "P3")!;
    expect(p3State.has_left).toBe(true);
    expect(p3State.results[0]).toBe("skipped");

    // P1 marks ready while P2 hasn't -> still in reveal; then P2 leaves -> P1 is the only remaining active player (already ready), so room advances to round 1!
    const p1Ready = await apiJson<{ advanced: boolean }>(
      `/api/rooms/${code3}/ready`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${p1Tok}` },
        body: JSON.stringify({ roundIndex: 0 }),
      },
      "203.0.113.220"
    );
    expect(p1Ready.data.advanced).toBe(false);

    await apiJson(
      `/api/rooms/${code3}/leave`,
      { method: "POST", headers: { Authorization: `Bearer ${p2Tok}` } },
      "203.0.113.221"
    );

    const hydAfterRLeave = await apiJson<{ hydration: ClientRoomHydration }>(
      `/api/rooms/${code3}/hydrate`,
      { headers: { Authorization: `Bearer ${p1Tok}` } },
      "203.0.113.220"
    );
    expect(hydAfterRLeave.data.hydration.current_round).toBe(1);
    expect(hydAfterRLeave.data.hydration.round_phase).toBe("question");

    // Last active player (P1) leaves -> room transitions to completed, new guest gets 409 ROOM_COMPLETED
    await apiJson(
      `/api/rooms/${code3}/leave`,
      { method: "POST", headers: { Authorization: `Bearer ${p1Tok}` } },
      "203.0.113.220"
    );
    const completedJoin = await apiJson<{ code: string }>(
      `/api/rooms/${code3}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "TooLate" }) },
      "203.0.113.224"
    );
    expect(completedJoin.status).toBe(409);
    expect(completedJoin.data.code).toBe("ROOM_COMPLETED");
  }, 30_000);

  it("Strict ALLOWED_ORIGIN blocks disallowed POST & WS upgrades (403 ORIGIN_FORBIDDEN) and D1 errors degrade to 503 solo fallback", async () => {
    const strictEnv = {
      ...(env as unknown as Env),
      ALLOWED_ORIGIN: "https://example.pages.dev",
    } as unknown as Env;

    // Disallowed POST Origin -> 403 ORIGIN_FORBIDDEN
    const badPostRes = await worker.fetch(
      new Request("https://api.example.com/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
          "CF-Connecting-IP": "198.51.100.150",
        },
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          hostName: "Evil",
        }),
      }),
      strictEnv
    );
    expect(badPostRes.status).toBe(403);
    expect(((await badPostRes.json()) as { code: string }).code).toBe("ORIGIN_FORBIDDEN");

    // Allowed POST Origin -> echoes allowed Origin in CORS headers
    const okPostRes = await worker.fetch(
      new Request("https://api.example.com/api/health", {
        method: "GET",
        headers: { Origin: "https://example.pages.dev" },
      }),
      strictEnv
    );
    expect(okPostRes.status).toBe(200);
    expect(okPostRes.headers.get("Access-Control-Allow-Origin")).toBe("https://example.pages.dev");

    // WebSocket upgrade missing Origin -> 403 ORIGIN_FORBIDDEN before reaching DO
    const wsMissingOrigin = await worker.fetch(
      new Request("https://api.example.com/api/rooms/ABCDEF/ws", {
        method: "GET",
        headers: { Upgrade: "websocket" },
      }),
      strictEnv
    );
    expect(wsMissingOrigin.status).toBe(403);
    expect(((await wsMissingOrigin.json()) as { code: string }).code).toBe("ORIGIN_FORBIDDEN");

    // WebSocket upgrade with disallowed Origin -> 403 ORIGIN_FORBIDDEN
    const wsBadOrigin = await worker.fetch(
      new Request("https://api.example.com/api/rooms/ABCDEF/ws", {
        method: "GET",
        headers: { Upgrade: "websocket", Origin: "https://evil.example" },
      }),
      strictEnv
    );
    expect(wsBadOrigin.status).toBe(403);
    expect(((await wsBadOrigin.json()) as { code: string }).code).toBe("ORIGIN_FORBIDDEN");

    // WebSocket upgrade with allowed Origin passes Origin check (reaches DO token check -> 401)
    const wsAllowedOrigin = await worker.fetch(
      new Request("https://api.example.com/api/rooms/ABCDEF/ws", {
        method: "GET",
        headers: { Upgrade: "websocket", Origin: "https://example.pages.dev" },
      }),
      strictEnv
    );
    expect(wsAllowedOrigin.status).toBe(401);

    // D1 failure on POST /api/rooms -> 503 SERVICE_UNAVAILABLE with solo fallback (not 500)
    const brokenDbEnv = {
      ...(env as unknown as Env),
      DB: {
        prepare() {
          throw new Error("D1 simulated outage");
        },
      } as unknown as D1Database,
    } as unknown as Env;

    const d1FailRes = await worker.fetch(
      new Request("https://example.com/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "198.51.100.151",
        },
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 10,
          roundSeconds: 25,
          hostName: "FallbackUser",
        }),
      }),
      brokenDbEnv
    );
    expect(d1FailRes.status).toBe(503);
    const d1FailData = (await d1FailRes.json()) as { code: string; fallback: string };
    expect(d1FailData.code).toBe("SERVICE_UNAVAILABLE");
    expect(d1FailData.fallback).toBe("solo");

    // D1 failure on GET /api/quota, POST /api/rooms/:code/join, and POST /api/flags -> 503 SERVICE_UNAVAILABLE
    const d1QuotaFail = await worker.fetch(new Request("https://example.com/api/quota"), brokenDbEnv);
    expect(d1QuotaFail.status).toBe(503);
    expect(((await d1QuotaFail.json()) as { code: string; fallback: string }).code).toBe("SERVICE_UNAVAILABLE");

    const d1JoinFail = await worker.fetch(
      new Request("https://example.com/api/rooms/ABCDEF/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.152" },
        body: JSON.stringify({ displayName: "FallbackJoiner" }),
      }),
      brokenDbEnv
    );
    expect(d1JoinFail.status).toBe(503);
    expect(((await d1JoinFail.json()) as { code: string; fallback: string }).fallback).toBe("solo");

    const flagItemId = Object.keys(serverIndex)[0]!;
    const d1FlagsFail = await worker.fetch(
      new Request("https://example.com/api/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.153" },
        body: JSON.stringify({ itemId: flagItemId, reasonCode: "typo" }),
      }),
      brokenDbEnv
    );
    expect(d1FlagsFail.status).toBe(503);
    expect(((await d1FlagsFail.json()) as { code: string; fallback: string }).code).toBe("SERVICE_UNAVAILABLE");
  }, 15_000);

  it("IP_RATE_LIMIT stores keyed/hashed bucket_key without raw IPs and purges expired rows on checkIpRateLimit", async () => {
    const testEnv = env as unknown as TestEnv;
    const rawIp = "198.51.100.244";

    // hashRateLimitKey uses HMAC-SHA-256 when secret is present, and SHA-256 fallback when absent
    const hmacKey = await hashRateLimitKey("test-secret-key-at-least-32-chars-long!", "rooms", rawIp);
    const shaKey = await hashRateLimitKey(undefined, "rooms", rawIp);
    expect(hmacKey).toMatch(/^rooms:[0-9a-f]{32}$/);
    expect(shaKey).toMatch(/^rooms:[0-9a-f]{32}$/);
    expect(hmacKey).not.toBe(shaKey);
    expect(hmacKey).not.toContain(rawIp);

    // Exercise /api/rooms, /api/rooms/:code/join, and /api/flags with rawIp
    const created = await apiJson<{ roomCode: string }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 4,
          roundSeconds: 25,
          hostName: "HashTester",
        }),
      },
      rawIp
    );
    expect(created.status).toBe(201);

    const joined = await apiJson(
      `/api/rooms/${created.data.roomCode}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "JoinHashTester" }) },
      rawIp
    );
    expect(joined.status).toBe(200);

    const flagged = await apiJson(
      "/api/flags",
      { method: "POST", body: JSON.stringify({ itemId: Object.keys(serverIndex)[0]!, reasonCode: "typo" }) },
      rawIp
    );
    expect(flagged.status).toBe(202);

    const rows = await testEnv.DB.prepare(`SELECT bucket_key FROM IP_RATE_LIMIT`).all<{ bucket_key: string }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(3);
    for (const row of rows.results) {
      expect(row.bucket_key).toMatch(/^(rooms|join|flags):[0-9a-f]{32,64}$/);
      expect(row.bucket_key).not.toContain(rawIp);
      expect(row.bucket_key).not.toContain("203.0.113.");
      expect(row.bucket_key).not.toContain("198.51.100.");
    }

    // Insert expired row and verify subsequent checkIpRateLimit purges it
    const expiredKey = "rooms:00000000000000000000000000000000";
    const nowMs = Date.now();
    await testEnv.DB.prepare(
      `INSERT OR REPLACE INTO IP_RATE_LIMIT (bucket_key, request_count, expires_at_ms) VALUES (?, 3, ?)`
    )
      .bind(expiredKey, nowMs - 5000)
      .run();

    const allowed = await checkIpRateLimit(
      testEnv.DB,
      "rooms:11111111111111111111111111111111",
      10,
      3600_000,
      nowMs
    );
    expect(allowed).toBe(true);

    const expiredCheck = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS c FROM IP_RATE_LIMIT WHERE bucket_key = ?`
    )
      .bind(expiredKey)
      .first<{ c: number }>();
    expect(expiredCheck?.c).toBe(0);
  }, 15_000);

  it("RoomActor boundary hardening: left live player cannot reconnect via joinRoom (403 ROOM_LEFT) & WS invalid submit_answer sends error frame", async () => {
    const created = await apiJson<{ roomCode: string; playerToken: string }>(
      "/api/rooms",
      {
        method: "POST",
        body: JSON.stringify({
          trackId: "phrases-en-ko",
          pacingMode: "live",
          maxPlayers: 4,
          roundSeconds: 25,
          hostName: "BoundaryHost",
        }),
      },
      "203.0.113.230"
    );
    expect(created.status).toBe(201);
    const code = created.data.roomCode;
    const hostTok = created.data.playerToken;

    const guestJoin = await apiJson<{ playerToken: string }>(
      `/api/rooms/${code}/join`,
      { method: "POST", body: JSON.stringify({ displayName: "LeavingGuest" }) },
      "203.0.113.231"
    );
    expect(guestJoin.status).toBe(200);
    const guestTok = guestJoin.data.playerToken;

    // Guest explicitly leaves live room
    const leaveRes = await apiJson<{ ok: boolean }>(
      `/api/rooms/${code}/leave`,
      { method: "POST", headers: { Authorization: `Bearer ${guestTok}` } },
      "203.0.113.231"
    );
    expect(leaveRes.status).toBe(200);

    // Left player's token must be rejected on /join with 403 ROOM_LEFT (cannot silently re-enter)
    const rejoinRes = await apiJson<{ code: string }>(
      `/api/rooms/${code}/join`,
      { method: "POST", body: JSON.stringify({ playerToken: guestTok }) },
      "203.0.113.231"
    );
    expect(rejoinRes.status).toBe(403);
    expect(rejoinRes.data.code).toBe("ROOM_LEFT");

    // WS submit_answer missing idempotencyKey returns clean error frame without crashing DO
    const wsRes = await SELF.fetch(`https://example.com/api/rooms/${code}/ws?token=${encodeURIComponent(hostTok)}`, {
      headers: { Upgrade: "websocket", Origin: "https://example.com" },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket!;
    ws.accept();

    const messages: Array<{ type: string; code?: string }> = [];
    const errorPromise = new Promise<{ type: string; code?: string }>((resolve) => {
      ws.addEventListener("message", (evt) => {
        const parsed = JSON.parse(typeof evt.data === "string" ? evt.data : "") as { type: string; code?: string };
        messages.push(parsed);
        if (parsed.type === "error") resolve(parsed);
      });
    });

    ws.send(JSON.stringify({ type: "submit_answer", roundIndex: 0, chosenIndex: 0 }));
    const errFrame = await errorPromise;
    expect(errFrame.type).toBe("error");
    expect(errFrame.code).toBe("SUBMIT_REJECTED");
    ws.close(1000, "done");
  }, 15_000);
});
