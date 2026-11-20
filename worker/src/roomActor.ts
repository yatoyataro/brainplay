import { DurableObject } from "cloudflare:workers";
import type {
  ClientRoomHydration,
  GameDifficulty,
  PacingMode,
  PlayerRole,
  PublicRoomQuestion,
  RoomPlayerState,
  RoomSnapshot,
  RoomSubmissionRecord,
  RoomWsClientEvent,
  RoomWsServerEvent,
  RoundRevealPayload,
  SessionLength,
} from "../../src/core/types.ts";
import { verifyRoomToken } from "./auth.ts";
import { disambiguateDisplayName } from "./sanitize.ts";
import {
  createSessionNonce,
  cryptoRandomInt,
  cryptoShuffleIndices,
} from "../../src/core/entropy.ts";
import rawAnswerIndex from "./generated/serverAnswerIndex.json";
import rawSubtrackIds from "./generated/subtrackItemIds.json";

interface ServerItemEntry {
  subtrack_id: string;
  difficulty: "beginner" | "intermediate" | "challenge";
  prompt: string;
  prompt_romanization?: string;
  options_4: string[];
  options_romanization?: string[];
  correct_index: number;
  deterministic_note: string;
  source_name: string;
  license_id: "CC0-1.0" | "CC-BY-2.0-FR" | "CC-BY-SA-4.0" | "PUBLIC-FACTUAL-API";
}

const SERVER_INDEX: Record<string, ServerItemEntry> = rawAnswerIndex as Record<
  string,
  ServerItemEntry
>;
const SUBTRACK_IDS = rawSubtrackIds as Record<string, string[]>;

interface WsAttachment {
  playerId: string;
  role: PlayerRole;
  msgWindowStartMs: number;
  msgCountInWindow: number;
}

interface ExtendedRoomSnapshot extends RoomSnapshot {
  sqlite_write_ops: number;
}

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const MAX_WS_MSGS_PER_MIN = 30;

function getRoundOptionOrder(
  roomCode: string,
  createdAt: string,
  roundIndex: number
): [number, number, number, number] {
  const key = `${roomCode}:${createdAt}:${roundIndex}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const perm: [number, number, number, number] = [0, 1, 2, 3];
  for (let k = 3; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [perm[k], perm[j]] = [perm[j]!, perm[k]!];
  }
  return perm;
}

type OptionPerm = [0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3];

function isValidOptionPerm(perm: unknown): perm is OptionPerm {
  if (!Array.isArray(perm) || perm.length !== 4) return false;
  const seen = new Set<number>();
  for (const v of perm) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 3 || seen.has(v)) {
      return false;
    }
    seen.add(v);
  }
  return seen.size === 4;
}

function getOptionPermForRound(
  snap: Pick<ExtendedRoomSnapshot, "round_option_orders" | "shuffle_salt" | "room_code" | "created_at">,
  roundIndex: number
): [number, number, number, number] {
  const stored = snap.round_option_orders?.[roundIndex];
  if (isValidOptionPerm(stored)) {
    return stored;
  }
  return getRoundOptionOrder(snap.shuffle_salt ?? snap.room_code, snap.created_at, roundIndex);
}

export class RoomActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          snapshot_json TEXT NOT NULL
        );
      `);
    });
  }

  private loadSnapshot(): ExtendedRoomSnapshot | null {
    const rows = this.ctx.storage.sql
      .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM room_state WHERE id = 1")
      .toArray();
    if (rows.length === 0 || !rows[0]?.snapshot_json) return null;
    const snap = JSON.parse(rows[0].snapshot_json) as ExtendedRoomSnapshot;
    if (Date.now() >= Date.parse(snap.expires_at)) {
      return null;
    }
    return snap;
  }

  private saveSnapshot(snap: ExtendedRoomSnapshot): void {
    snap.sqlite_write_ops = (snap.sqlite_write_ops ?? 0) + 1;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO room_state (id, snapshot_json) VALUES (1, ?)",
      JSON.stringify(snap)
    );
  }

  private getConnectedPlayerIds(): Set<string> {
    const connected = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att?.playerId) connected.add(att.playerId);
    }
    return connected;
  }

  private pickSeededItems(
    trackId: string,
    count: SessionLength,
    difficulty: GameDifficulty
  ): string[] {
    const rawPool = SUBTRACK_IDS[trackId];
    if (!rawPool || rawPool.length < count) {
      throw new Error(`Track ${trackId} does not have at least ${count} items`);
    }
    const harderPool =
      difficulty === "harder"
        ? rawPool.filter((id) => {
            const diff = SERVER_INDEX[id]?.difficulty;
            return diff === "challenge" || diff === "intermediate";
          })
        : rawPool;
    const pool = harderPool.length >= count ? harderPool : rawPool;

    const chosen: string[] = [];
    const used = new Set<number>();
    while (chosen.length < count) {
      const idx = cryptoRandomInt(pool.length);
      if (!used.has(idx)) {
        used.add(idx);
        chosen.push(pool[idx]!);
      }
    }
    return chosen;
  }

  private toPublicQuestion(
    snap: Pick<ExtendedRoomSnapshot, "round_option_orders" | "shuffle_salt" | "room_code" | "created_at">,
    roundIndex: number,
    itemId: string
  ): PublicRoomQuestion {
    const entry = SERVER_INDEX[itemId];
    if (!entry) {
      throw new Error(`Missing server item ${itemId}`);
    }
    // Shuffled consistently per room & round so players cannot memorize fixed choice slots
    const perm = getOptionPermForRound(snap, roundIndex);
    // Anti-spoiler contract (TEST-005): strictly omit correct_index and deterministic_note
    const optRom =
      entry.options_romanization && entry.options_romanization.length === 4
        ? ([
            entry.options_romanization[perm[0]]!,
            entry.options_romanization[perm[1]]!,
            entry.options_romanization[perm[2]]!,
            entry.options_romanization[perm[3]]!,
          ] as [string, string, string, string])
        : undefined;

    return {
      round_index: roundIndex,
      item_id: itemId,
      subtrack_id: entry.subtrack_id,
      difficulty: entry.difficulty,
      prompt: entry.prompt,
      ...(entry.prompt_romanization ? { prompt_romanization: entry.prompt_romanization } : {}),
      options_4: [
        entry.options_4[perm[0]]!,
        entry.options_4[perm[1]]!,
        entry.options_4[perm[2]]!,
        entry.options_4[perm[3]]!,
      ],
      ...(optRom ? { options_romanization: optRom } : {}),
      source_name: entry.source_name,
      license_id: entry.license_id,
    };
  }

  private buildRevealPayload(snap: ExtendedRoomSnapshot, roundIndex: number): RoundRevealPayload {
    const itemId = snap.seeded_item_ids[roundIndex]!;
    const entry = SERVER_INDEX[itemId]!;
    const perm = getOptionPermForRound(snap, roundIndex);
    const mappedCorrect = perm.indexOf(entry.correct_index) as 0 | 1 | 2 | 3;
    const subsByPlayer = new Map<string, RoomSubmissionRecord>();
    for (const s of snap.submissions) {
      if (s.round_index === roundIndex) subsByPlayer.set(s.player_id, s);
    }
    return {
      round_index: roundIndex,
      correct_index: mappedCorrect,
      deterministic_note: entry.deterministic_note,
      player_results: snap.players.map((p) => {
        const sub = subsByPlayer.get(p.player_id);
        return {
          player_id: p.player_id,
          display_name: p.display_name,
          color_index: p.color_index ?? 0,
          chosen_index: sub ? sub.chosen_index : null,
          is_correct: sub ? sub.is_correct : false,
          points_awarded: sub ? sub.points_awarded : 0,
          total_score: p.score,
        };
      }),
    };
  }

  private toClientHydration(snap: ExtendedRoomSnapshot, selfPlayerId: string): ClientRoomHydration {
    const self = snap.players.find((p) => p.player_id === selfPlayerId);
    if (!self) {
      throw new Error("Player not in room");
    }

    const totalRounds = snap.seeded_item_ids.length;
    const lastRoundIdx = Math.max(0, totalRounds - 1);
    const isAsync = snap.pacing_mode === "async24h";
    const selfDone = self.last_completed_round >= lastRoundIdx;
    const connectedIds = this.getConnectedPlayerIds();
    const readySet = new Set(snap.ready_player_ids ?? []);

    let currentQuestion: PublicRoomQuestion | null = null;
    const completedReveals: RoundRevealPayload[] = [];

    if (isAsync) {
      const nextRound = self.last_completed_round + 1;
      if (nextRound <= lastRoundIdx && snap.status !== "expired") {
        currentQuestion = this.toPublicQuestion(snap, nextRound, snap.seeded_item_ids[nextRound]!);
      }
      for (let r = 0; r <= self.last_completed_round; r++) {
        completedReveals.push(this.buildRevealPayload(snap, r));
      }
    } else {
      if (snap.status === "active" && snap.round_phase === "question") {
        currentQuestion = this.toPublicQuestion(
          snap,
          snap.current_round,
          snap.seeded_item_ids[snap.current_round]!
        );
      }
      const revealLimit =
        snap.round_phase === "completed"
          ? lastRoundIdx
          : snap.round_phase === "reveal"
          ? snap.current_round
          : snap.current_round - 1;
      for (let r = 0; r <= revealLimit; r++) {
        completedReveals.push(this.buildRevealPayload(snap, r));
      }
    }

    return {
      room_code: snap.room_code,
      track_id: snap.track_id,
      pacing_mode: snap.pacing_mode,
      max_players: snap.max_players,
      round_seconds: snap.round_seconds,
      question_count: totalRounds,
      difficulty: snap.difficulty ?? "standard",
      status: snap.status,
      round_phase: snap.round_phase,
      current_round: isAsync ? Math.min(lastRoundIdx, self.last_completed_round + 1) : snap.current_round,
      round_deadline_at: isAsync ? null : snap.round_deadline_at,
      expires_at: snap.expires_at,
      self_player_id: self.player_id,
      self_role: self.role,
      players: (snap.status === "lobby" ? snap.players.filter((p) => !p.has_left) : snap.players).map((p) => {
        const hidePeerDetails = isAsync && !selfDone && p.player_id !== self.player_id;
        return {
          player_id: p.player_id,
          display_name: p.display_name,
          role: p.role,
          color_index: p.color_index ?? 0,
          score: hidePeerDetails ? 0 : p.score,
          is_connected: connectedIds.has(p.player_id),
          answered_current_round: isAsync
            ? p.last_completed_round >= Math.min(lastRoundIdx, self.last_completed_round + 1)
            : snap.submissions.some(
                (s) => s.player_id === p.player_id && s.round_index === snap.current_round
              ),
          ready_for_next: readySet.has(p.player_id),
          completed_all_rounds: p.last_completed_round >= lastRoundIdx,
          ...(snap.status !== "lobby" ? { has_left: Boolean(p.has_left) } : {}),
          results: hidePeerDetails
            ? Array<"pending">(totalRounds).fill("pending")
            : p.results,
        };
      }),
      current_question: currentQuestion,
      completed_reveals: completedReveals,
    };
  }

  private broadcast(buildEvent: (playerId: string) => RoomWsServerEvent | null): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att) continue;
      const evt = buildEvent(att.playerId);
      if (!evt) continue;
      try {
        ws.send(JSON.stringify(evt));
      } catch {
        // Ignore closed socket; webSocketClose cleans up
      }
    }
  }

  async createRoom(params: {
    roomCode: string;
    trackId: string;
    pacingMode: PacingMode;
    maxPlayers: number;
    roundSeconds: number;
    questionCount?: SessionLength;
    difficulty?: GameDifficulty;
    hostPlayerId: string;
    hostName: string;
  }): Promise<ClientRoomHydration> {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + FORTY_EIGHT_HOURS_MS).toISOString();
    const questionCount: SessionLength = params.questionCount ?? 5;
    const difficulty: GameDifficulty = params.difficulty ?? "standard";
    const seededItemIds = this.pickSeededItems(params.trackId, questionCount, difficulty);
    const shuffleSalt = createSessionNonce();
    const roundOptionOrders: OptionPerm[] = Array.from(
      { length: questionCount },
      () => cryptoShuffleIndices(4) as OptionPerm
    );

    const hostPlayer: RoomPlayerState = {
      player_id: params.hostPlayerId,
      display_name: params.hostName,
      role: "host",
      color_index: 0,
      score: 0,
      last_completed_round: -1,
      joined_at: createdAt,
      results: Array<"pending">(questionCount).fill("pending"),
    };

    const snap: ExtendedRoomSnapshot = {
      room_code: params.roomCode,
      track_id: params.trackId,
      pacing_mode: params.pacingMode,
      max_players: params.maxPlayers,
      round_seconds: params.roundSeconds,
      question_count: questionCount,
      difficulty,
      status: params.pacingMode === "async24h" ? "active" : "lobby",
      round_phase: params.pacingMode === "async24h" ? "question" : "lobby",
      current_round: 0,
      seeded_item_ids: seededItemIds,
      shuffle_salt: shuffleSalt,
      round_option_orders: roundOptionOrders,
      round_deadline_at: null,
      ready_player_ids: [],
      created_at: createdAt,
      expires_at: expiresAt,
      players: [hostPlayer],
      submissions: [],
      sqlite_write_ops: 0,
    };

    snap.sqlite_write_ops += 1;
    this.saveSnapshot(snap);
    await this.ctx.storage.setAlarm(now + FORTY_EIGHT_HOURS_MS);
    return this.toClientHydration(snap, hostPlayer.player_id);
  }

  async joinRoom(params: {
    displayName?: string;
    reconnectPlayerId?: string;
  }): Promise<
    | { ok: true; playerId: string; role: PlayerRole; hydration: ClientRoomHydration }
    | { ok: false; status: number; code: string; error: string }
  > {
    const snap = this.loadSnapshot();
    if (!snap) {
      return { ok: false, status: 410, code: "ROOM_EXPIRED", error: "Room not found or expired." };
    }

    if (params.reconnectPlayerId) {
      const found = snap.players.find((p) => p.player_id === params.reconnectPlayerId);
      if (found) {
        if (found.has_left) {
          return {
            ok: false,
            status: 403,
            code: "ROOM_LEFT",
            error: "You already left this live room.",
          };
        }
        return {
          ok: true,
          playerId: found.player_id,
          role: found.role,
          hydration: this.toClientHydration(snap, found.player_id),
        };
      }
    }

    if (!params.displayName) {
      return { ok: false, status: 400, code: "NAME_REQUIRED", error: "Display name is required." };
    }
    if (snap.status === "completed") {
      return { ok: false, status: 409, code: "ROOM_COMPLETED", error: "This room has already finished." };
    }
    if (snap.pacing_mode === "live" && snap.status === "active") {
      return {
        ok: false,
        status: 409,
        code: "ROOM_ALREADY_STARTED",
        error: "This Live Sync game has already started.",
      };
    }
    const activeCount = snap.players.filter((p) => !p.has_left).length;
    if (activeCount >= snap.max_players) {
      return { ok: false, status: 409, code: "ROOM_FULL", error: "Room has reached max capacity." };
    }

    const finalName = disambiguateDisplayName(
      params.displayName,
      snap.players.map((p) => p.display_name)
    );
    const newPlayer: RoomPlayerState = {
      player_id: crypto.randomUUID(),
      display_name: finalName,
      role: "guest",
      color_index: snap.players.length % 8,
      score: 0,
      last_completed_round: -1,
      joined_at: new Date().toISOString(),
      results: Array<"pending">(snap.seeded_item_ids.length).fill("pending"),
    };
    snap.players.push(newPlayer);
    this.saveSnapshot(snap);

    this.broadcast((pid) => ({
      type: "room_state",
      hydration: this.toClientHydration(snap, pid),
    }));

    return {
      ok: true,
      playerId: newPlayer.player_id,
      role: "guest",
      hydration: this.toClientHydration(snap, newPlayer.player_id),
    };
  }

  async getHydration(playerId: string): Promise<ClientRoomHydration | null> {
    const snap = this.loadSnapshot();
    if (!snap) return null;
    if (!snap.players.some((p) => p.player_id === playerId)) return null;
    return this.toClientHydration(snap, playerId);
  }

  async startRound(
    playerId: string
  ): Promise<{ ok: true; hydration: ClientRoomHydration } | { ok: false; status: number; error: string }> {
    const snap = this.loadSnapshot();
    if (!snap) return { ok: false, status: 410, error: "Room not found or expired." };
    const player = snap.players.find((p) => p.player_id === playerId);
    if (!player || player.has_left || player.role !== "host") {
      return { ok: false, status: 403, error: "Only the room host can start the game." };
    }
    if (snap.pacing_mode !== "live") {
      return { ok: false, status: 400, error: "Async rooms do not require host round starts." };
    }
    if (snap.round_phase === "completed" || snap.status === "completed") {
      return { ok: false, status: 409, error: "Room is already completed." };
    }
    const activePlayers = snap.players.filter((p) => !p.has_left);
    if (snap.round_phase === "lobby" && activePlayers.length < 2) {
      return {
        ok: false,
        status: 409,
        error:
          "At least 2 players are required to start a Live Sync game. Playing alone? Try Solo Daily or Practice!",
      };
    }

    if (snap.round_phase === "question" && snap.status === "active") {
      return { ok: true, hydration: this.toClientHydration(snap, playerId) };
    }
    if (snap.round_phase === "reveal") {
      return {
        ok: false,
        status: 409,
        error: "Waiting for all players to click Ready for next round.",
      };
    }

    const nowMs = Date.now();
    const deadlineMs = nowMs + snap.round_seconds * 1000;
    snap.status = "active";
    snap.round_phase = "question";
    snap.ready_player_ids = [];
    snap.round_deadline_at = new Date(deadlineMs).toISOString();

    snap.sqlite_write_ops += 1;
    this.saveSnapshot(snap);
    await this.ctx.storage.setAlarm(Math.min(deadlineMs, Date.parse(snap.expires_at)));

    const question = this.toPublicQuestion(
      snap,
      snap.current_round,
      snap.seeded_item_ids[snap.current_round]!
    );
    this.broadcast(() => ({
      type: "round_started",
      question,
      deadlineEpochMs: deadlineMs,
    }));

    return { ok: true, hydration: this.toClientHydration(snap, playerId) };
  }

  private async advanceFromReveal(snap: ExtendedRoomSnapshot): Promise<void> {
    snap.ready_player_ids = [];
    if (snap.current_round >= snap.seeded_item_ids.length - 1) {
      snap.status = "completed";
      snap.round_phase = "completed";
      snap.round_deadline_at = null;
      this.saveSnapshot(snap);
      this.broadcast((pid) => ({
        type: "room_completed",
        hydration: this.toClientHydration(snap, pid),
      }));
      return;
    }

    snap.current_round += 1;
    const nowMs = Date.now();
    const deadlineMs = nowMs + snap.round_seconds * 1000;
    snap.status = "active";
    snap.round_phase = "question";
    snap.round_deadline_at = new Date(deadlineMs).toISOString();

    snap.sqlite_write_ops += 1;
    this.saveSnapshot(snap);
    await this.ctx.storage.setAlarm(Math.min(deadlineMs, Date.parse(snap.expires_at)));

    const question = this.toPublicQuestion(
      snap,
      snap.current_round,
      snap.seeded_item_ids[snap.current_round]!
    );
    this.broadcast(() => ({
      type: "round_started",
      question,
      deadlineEpochMs: deadlineMs,
    }));
  }

  /**
   * Synchronized Ready Gate for Live Sync (replaces single-host "Start Card #"):
   * advances everyone simultaneously to the next round (or final standings) once
   * all active players in the room click "Ready for next round".
   */
  async markPlayerReady(params: {
    playerId: string;
    roundIndex: number;
  }): Promise<{ ok: true; advanced: boolean; hydration: ClientRoomHydration } | { ok: false; status: number; error: string }> {
    const snap = this.loadSnapshot();
    if (!snap) return { ok: false, status: 410, error: "Room not found or expired." };
    const player = snap.players.find((p) => p.player_id === params.playerId);
    if (!player || player.has_left) return { ok: false, status: 403, error: "Not a member of this room." };
    if (snap.pacing_mode !== "live") {
      return { ok: false, status: 400, error: "Ready gate is only used in Live Sync mode." };
    }
    if (snap.round_phase === "question" || snap.round_phase === "completed") {
      return { ok: true, advanced: true, hydration: this.toClientHydration(snap, params.playerId) };
    }
    if (snap.round_phase !== "reveal" || params.roundIndex !== snap.current_round) {
      return { ok: false, status: 409, error: "Room is not waiting for ready on that round." };
    }

    const readySet = new Set(snap.ready_player_ids ?? []);
    readySet.add(params.playerId);
    snap.ready_player_ids = Array.from(readySet);

    const activePlayers = snap.players.filter((p) => !p.has_left);
    const allReady = activePlayers.every((p) => readySet.has(p.player_id));
    if (!allReady) {
      this.saveSnapshot(snap);
      this.broadcast((pid) => ({
        type: "room_state",
        hydration: this.toClientHydration(snap, pid),
      }));
      return { ok: true, advanced: false, hydration: this.toClientHydration(snap, params.playerId) };
    }

    await this.advanceFromReveal(snap);
    return { ok: true, advanced: true, hydration: this.toClientHydration(snap, params.playerId) };
  }

  async leaveRoom(playerId: string): Promise<{ ok: boolean; status?: number }> {
    const snap = this.loadSnapshot();
    if (!snap) return { ok: false, status: 410 };
    const player = snap.players.find((p) => p.player_id === playerId);
    if (!player) return { ok: false, status: 403 };

    if (snap.pacing_mode === "async24h") {
      return { ok: true };
    }

    if (player.has_left) {
      return { ok: true };
    }

    player.has_left = true;
    player.left_at = new Date().toISOString();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (att?.playerId === playerId) {
        try {
          ws.close(1000, "Player left");
        } catch {
          // Ignore already closed socket
        }
      }
    }

    const activePlayers = snap.players.filter((p) => !p.has_left);
    if (player.role === "host" && activePlayers.length > 0) {
      activePlayers[0]!.role = "host";
      player.role = "guest";
    }

    if (snap.status === "lobby" || snap.status === "completed") {
      this.saveSnapshot(snap);
      this.broadcast((pid) => ({
        type: "room_state",
        hydration: this.toClientHydration(snap, pid),
      }));
      return { ok: true };
    }

    if (snap.status === "active") {
      if (activePlayers.length === 0) {
        snap.status = "completed";
        snap.round_phase = "completed";
        snap.round_deadline_at = null;
        this.saveSnapshot(snap);
        await this.ctx.storage.setAlarm(Date.parse(snap.expires_at));
        return { ok: true };
      }

      if (snap.round_phase === "question") {
        if (player.results[snap.current_round] === "pending") {
          player.results[snap.current_round] = "skipped";
          player.last_completed_round = Math.max(player.last_completed_round, snap.current_round);
        }
        const answeredIds = new Set(
          snap.submissions
            .filter((s) => s.round_index === snap.current_round)
            .map((s) => s.player_id)
        );
        if (activePlayers.every((p) => answeredIds.has(p.player_id))) {
          await this.finishLiveRound(snap);
        } else {
          this.saveSnapshot(snap);
          this.broadcast((pid) => ({
            type: "room_state",
            hydration: this.toClientHydration(snap, pid),
          }));
        }
        return { ok: true };
      }

      if (snap.round_phase === "reveal") {
        const readySet = new Set(snap.ready_player_ids ?? []);
        if (activePlayers.every((p) => readySet.has(p.player_id))) {
          await this.advanceFromReveal(snap);
        } else {
          this.saveSnapshot(snap);
          this.broadcast((pid) => ({
            type: "room_state",
            hydration: this.toClientHydration(snap, pid),
          }));
        }
        return { ok: true };
      }
    }

    return { ok: true };
  }

  async submitAnswer(params: {
    playerId: string;
    roundIndex: number;
    chosenIndex: number;
    idempotencyKey: string;
  }): Promise<
    | {
        ok: true;
        alreadyRecorded: boolean;
        reveal?: RoundRevealPayload;
        hydration: ClientRoomHydration;
      }
    | { ok: false; status: number; error: string }
  > {
    const snap = this.loadSnapshot();
    if (!snap) return { ok: false, status: 410, error: "Room not found or expired." };
    const player = snap.players.find((p) => p.player_id === params.playerId);
    if (!player || player.has_left) return { ok: false, status: 403, error: "Not a member of this room." };

    if (!Number.isInteger(params.chosenIndex) || params.chosenIndex < 0 || params.chosenIndex > 3) {
      return { ok: false, status: 400, error: "Invalid option index." };
    }
    if (!params.idempotencyKey || params.idempotencyKey.length > 80) {
      return { ok: false, status: 400, error: "Missing idempotencyKey." };
    }

    const dupByKey = snap.submissions.find(
      (s) => s.idempotency_key === params.idempotencyKey && s.player_id === params.playerId
    );
    if (dupByKey) {
      const reveal =
        snap.pacing_mode === "async24h" || snap.round_phase !== "question"
          ? this.buildRevealPayload(snap, dupByKey.round_index)
          : undefined;
      return {
        ok: true,
        alreadyRecorded: true,
        reveal,
        hydration: this.toClientHydration(snap, params.playerId),
      };
    }

    const lastRoundIdx = snap.seeded_item_ids.length - 1;

    if (snap.pacing_mode === "async24h") {
      const expectedRound = player.last_completed_round + 1;
      if (params.roundIndex !== expectedRound || expectedRound > lastRoundIdx) {
        return { ok: false, status: 409, error: "Round out of sequence for async play." };
      }

      const itemId = snap.seeded_item_ids[expectedRound]!;
      const entry = SERVER_INDEX[itemId]!;
      const perm = getOptionPermForRound(snap, expectedRound);
      const isCorrect = perm[params.chosenIndex] === entry.correct_index;
      const points = isCorrect ? 100 : 0;

      snap.submissions.push({
        idempotency_key: params.idempotencyKey,
        player_id: player.player_id,
        round_index: expectedRound,
        chosen_index: params.chosenIndex,
        is_correct: isCorrect,
        points_awarded: points,
        submitted_at: new Date().toISOString(),
      });
      player.score += points;
      player.last_completed_round = expectedRound;
      player.results[expectedRound] = isCorrect ? "correct" : "wrong";
      this.saveSnapshot(snap);

      const reveal = this.buildRevealPayload(snap, expectedRound);
      return {
        ok: true,
        alreadyRecorded: false,
        reveal,
        hydration: this.toClientHydration(snap, params.playerId),
      };
    }

    // Live Sync mode
    if (snap.status !== "active" || snap.round_phase !== "question") {
      return { ok: false, status: 409, error: "No active live question right now." };
    }
    if (params.roundIndex !== snap.current_round) {
      return { ok: false, status: 409, error: "Submission does not match current round." };
    }

    const dupByRound = snap.submissions.find(
      (s) => s.player_id === params.playerId && s.round_index === params.roundIndex
    );
    if (dupByRound) {
      return {
        ok: true,
        alreadyRecorded: true,
        hydration: this.toClientHydration(snap, params.playerId),
      };
    }

    const itemId = snap.seeded_item_ids[params.roundIndex]!;
    const entry = SERVER_INDEX[itemId]!;
    const perm = getOptionPermForRound(snap, params.roundIndex);
    const isCorrect = perm[params.chosenIndex] === entry.correct_index;
    const points = isCorrect ? 100 : 0;

    snap.submissions.push({
      idempotency_key: params.idempotencyKey,
      player_id: player.player_id,
      round_index: params.roundIndex,
      chosen_index: params.chosenIndex,
      is_correct: isCorrect,
      points_awarded: points,
      submitted_at: new Date().toISOString(),
    });
    player.score += points;
    player.last_completed_round = Math.max(player.last_completed_round, params.roundIndex);
    player.results[params.roundIndex] = isCorrect ? "correct" : "wrong";

    const answeredIds = new Set(
      snap.submissions.filter((s) => s.round_index === snap.current_round).map((s) => s.player_id)
    );
    const activePlayers = snap.players.filter((p) => !p.has_left);
    const allAnswered = activePlayers.every((p) => answeredIds.has(p.player_id));

    if (allAnswered) {
      await this.finishLiveRound(snap);
    } else {
      this.saveSnapshot(snap);
      this.broadcast(() => ({
        type: "player_progress",
        playerId: player.player_id,
        roundIndex: params.roundIndex,
        answered: true,
      }));
    }

    return {
      ok: true,
      alreadyRecorded: false,
      reveal: allAnswered ? this.buildRevealPayload(snap, params.roundIndex) : undefined,
      hydration: this.toClientHydration(snap, params.playerId),
    };
  }

  private async finishLiveRound(snap: ExtendedRoomSnapshot): Promise<void> {
    const r = snap.current_round;
    const answeredIds = new Set(
      snap.submissions.filter((s) => s.round_index === r).map((s) => s.player_id)
    );
    for (const p of snap.players) {
      if (!p.has_left && !answeredIds.has(p.player_id) && p.results[r] === "pending") {
        p.results[r] = "skipped";
        p.last_completed_round = Math.max(p.last_completed_round, r);
      }
    }

    snap.round_deadline_at = null;
    snap.ready_player_ids = [];
    snap.round_phase = "reveal";
    snap.sqlite_write_ops += 1;
    this.saveSnapshot(snap);
    await this.ctx.storage.setAlarm(Date.parse(snap.expires_at));

    const reveal = this.buildRevealPayload(snap, r);
    const nextRoundIndex = r >= snap.seeded_item_ids.length - 1 ? null : r + 1;
    this.broadcast(() => ({
      type: "round_revealed",
      reveal,
      nextRoundIndex,
    }));
  }

  async getMetrics(): Promise<{
    room_state_row_count: number;
    sqlite_write_ops: number;
    player_count: number;
    submission_count: number;
    status: string;
  } | null> {
    const rowCount = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM room_state")
      .one().c;
    const snap = this.loadSnapshot();
    if (!snap) {
      return {
        room_state_row_count: rowCount,
        sqlite_write_ops: 0,
        player_count: 0,
        submission_count: 0,
        status: "expired_or_empty",
      };
    }
    return {
      room_state_row_count: rowCount,
      sqlite_write_ops: snap.sqlite_write_ops,
      player_count: snap.players.length,
      submission_count: snap.submissions.length,
      status: snap.status,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const token = url.searchParams.get("token") ?? "";
    const claims = await verifyRoomToken(token, this.env.ROOM_TOKEN_SECRET);
    if (!claims) {
      return new Response("Unauthorized", { status: 401 });
    }

    const snap = this.loadSnapshot();
    if (!snap || snap.room_code !== claims.roomCode) {
      return new Response("Room expired or not found", { status: 410 });
    }
    const player = snap.players.find((p) => p.player_id === claims.playerId);
    if (!player || player.has_left) {
      return new Response("Player not in room", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const attachment: WsAttachment = {
      playerId: claims.playerId,
      role: claims.role,
      msgWindowStartMs: Date.now(),
      msgCountInWindow: 0,
    };
    server.serializeAttachment(attachment);

    // Send hydration snapshot to joining socket and notify peers of online status
    const initial: RoomWsServerEvent = {
      type: "room_state",
      hydration: this.toClientHydration(snap, claims.playerId),
    };
    server.send(JSON.stringify(initial));
    this.broadcast((pid) =>
      pid === claims.playerId
        ? null
        : { type: "room_state", hydration: this.toClientHydration(snap, pid) }
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) {
      ws.close(1008, "Missing session");
      return;
    }

    const now = Date.now();
    if (now - att.msgWindowStartMs >= 60_000) {
      att.msgWindowStartMs = now;
      att.msgCountInWindow = 1;
    } else {
      att.msgCountInWindow += 1;
      if (att.msgCountInWindow > MAX_WS_MSGS_PER_MIN) {
        ws.serializeAttachment(att);
        ws.send(
          JSON.stringify({
            type: "error",
            code: "RATE_LIMITED",
            message: "Too many messages per minute.",
          } satisfies RoomWsServerEvent)
        );
        return;
      }
    }
    ws.serializeAttachment(att);

    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text.length > 4096) {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "PAYLOAD_TOO_LARGE",
          message: "Message exceeds 4KB limit.",
        } satisfies RoomWsServerEvent)
      );
      return;
    }

    let parsed: RoomWsClientEvent;
    try {
      const rawParsed: unknown = JSON.parse(text);
      if (!rawParsed || typeof rawParsed !== "object") {
        throw new Error("Non-object WS frame");
      }
      parsed = rawParsed as RoomWsClientEvent;
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          code: "BAD_JSON",
          message: "Malformed WebSocket JSON.",
        } satisfies RoomWsServerEvent)
      );
      return;
    }

    if (parsed.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" } satisfies RoomWsServerEvent));
      return;
    }

    if (parsed.type === "leave_room") {
      await this.leaveRoom(att.playerId);
      return;
    }

    if (parsed.type === "host_start_round") {
      const res = await this.startRound(att.playerId);
      if (!res.ok) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "START_REJECTED",
            message: res.error,
          } satisfies RoomWsServerEvent)
        );
      }
      return;
    }

    if (parsed.type === "player_ready") {
      if (typeof parsed.roundIndex !== "number") {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "READY_REJECTED",
            message: "Missing or invalid roundIndex.",
          } satisfies RoomWsServerEvent)
        );
        return;
      }
      const res = await this.markPlayerReady({
        playerId: att.playerId,
        roundIndex: parsed.roundIndex,
      });
      if (!res.ok) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "READY_REJECTED",
            message: res.error,
          } satisfies RoomWsServerEvent)
        );
      }
      return;
    }

    if (parsed.type === "submit_answer") {
      if (
        typeof parsed.roundIndex !== "number" ||
        typeof parsed.chosenIndex !== "number" ||
        typeof parsed.idempotencyKey !== "string"
      ) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "SUBMIT_REJECTED",
            message: "Missing or invalid answer fields.",
          } satisfies RoomWsServerEvent)
        );
        return;
      }
      const res = await this.submitAnswer({
        playerId: att.playerId,
        roundIndex: parsed.roundIndex,
        chosenIndex: parsed.chosenIndex,
        idempotencyKey: parsed.idempotencyKey,
      });
      if (!res.ok) {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "SUBMIT_REJECTED",
            message: res.error,
          } satisfies RoomWsServerEvent)
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "room_state",
            hydration: res.hydration,
          } satisfies RoomWsServerEvent)
        );
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed
    }
    const snap = this.loadSnapshot();
    if (snap) {
      this.broadcast((pid) => ({
        type: "room_state",
        hydration: this.toClientHydration(snap, pid),
      }));
    }
  }

  override async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM room_state WHERE id = 1")
      .toArray();
    if (rows.length === 0 || !rows[0]?.snapshot_json) return;

    const snap = JSON.parse(rows[0].snapshot_json) as ExtendedRoomSnapshot;
    const now = Date.now();

    if (now >= Date.parse(snap.expires_at)) {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "Room expired after 48h");
        } catch {
          // Ignore
        }
      }
      await this.ctx.storage.deleteAll();
      return;
    }

    if (
      snap.pacing_mode === "live" &&
      snap.status === "active" &&
      snap.round_phase === "question" &&
      snap.round_deadline_at &&
      now >= Date.parse(snap.round_deadline_at)
    ) {
      await this.finishLiveRound(snap);
    }
  }
}
