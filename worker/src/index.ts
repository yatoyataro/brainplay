import { generateRoomCode, signRoomToken, verifyRoomToken } from "./auth.ts";
import {
  checkIpRateLimit,
  getDailyQuotaStatus,
  recordCardFlag,
  recordRoomCreationOrShed,
  type FlagReason,
  type QuotaThresholds,
} from "./d1.ts";
import { RoomActor } from "./roomActor.ts";
import { isValidRoomCode, sanitizeDisplayName } from "./sanitize.ts";
import rawAnswerIndex from "./generated/serverAnswerIndex.json";
import rawSubtrackIds from "./generated/subtrackItemIds.json";
import type { PacingMode } from "../../src/core/types.ts";

export { RoomActor };

const VALID_SUBTRACKS = new Set(Object.keys(rawSubtrackIds as Record<string, string[]>));
const VALID_ITEMS = new Set(Object.keys(rawAnswerIndex as Record<string, unknown>));
const VALID_FLAG_REASONS = new Set<FlagReason>(["typo", "ambiguous", "wrong_answer", "offensive"]);
const FORTY_EIGHT_HOURS_SEC = 48 * 60 * 60;
const TEXT_ENCODER = new TextEncoder();

export async function hashRateLimitKey(
  secret: string | undefined,
  scope: string,
  clientIp: string
): Promise<string> {
  const payload = TEXT_ENCODER.encode(`${scope}:${clientIp}`);
  let digest: ArrayBuffer;
  if (secret && secret.length > 0) {
    const key = await crypto.subtle.importKey(
      "raw",
      TEXT_ENCODER.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    digest = await crypto.subtle.sign("HMAC", key, payload);
  } else {
    digest = await crypto.subtle.digest("SHA-256", payload);
  }
  const bytes = new Uint8Array(digest, 0, 16);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `${scope}:${hex}`;
}

function getQuotaThresholds(env: Env): QuotaThresholds {
  return {
    requestHardCap: Number(env.DAILY_REQUEST_HARD_CAP ?? "100000") || 100000,
    writeHardCap: Number(env.DAILY_WRITE_HARD_CAP ?? "100000") || 100000,
    shedRatio: Number(env.QUOTA_SHED_RATIO ?? "0.85") || 0.85,
  };
}

function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

function getAllowedOrigins(env: Env): string[] {
  const raw = ((env.ALLOWED_ORIGIN as string | undefined) ?? "*").trim();
  if (!raw || raw === "*") return ["*"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(
  request: Request,
  env: Env,
  options: { requireOriginHeader?: boolean } = {}
): boolean {
  const allowed = getAllowedOrigins(env);
  if (allowed.includes("*")) return true;

  const origin = request.headers.get("Origin");
  if (!origin) {
    return !options.requireOriginHeader;
  }

  const url = new URL(request.url);
  return origin === url.origin || allowed.includes(origin);
}

function corsHeaders(env: Env, request?: Request): Record<string, string> {
  const allowed = getAllowedOrigins(env);
  let allowOriginHeader = "*";
  const extra: Record<string, string> = {};

  if (!allowed.includes("*")) {
    const reqOrigin = request?.headers.get("Origin");
    const reqUrl = request ? new URL(request.url) : null;
    if (reqOrigin && ((reqUrl && reqOrigin === reqUrl.origin) || allowed.includes(reqOrigin))) {
      allowOriginHeader = reqOrigin;
    } else {
      allowOriginHeader = allowed[0] ?? "null";
    }
    extra.Vary = "Origin";
  }

  return {
    "Access-Control-Allow-Origin": allowOriginHeader,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extra,
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  env: Env,
  extraHeaders?: Record<string, string>,
  request?: Request
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request),
      ...extraHeaders,
    },
  });
}

function rateLimitedResponse(
  error: string,
  env: Env,
  request: Request,
  retryAfterSec = 60
): Response {
  return jsonResponse(
    { code: "RATE_LIMITED", error, retryAfterSec },
    429,
    env,
    { "Retry-After": String(retryAfterSec) },
    request
  );
}

function serviceUnavailableSoloResponse(env: Env, request: Request): Response {
  return jsonResponse(
    {
      code: "SERVICE_UNAVAILABLE",
      fallback: "solo",
      error:
        "Live room service is temporarily unavailable. Solo Daily & Practice remain 100% available offline/locally.",
    },
    503,
    env,
    undefined,
    request
  );
}

async function parseBoundedJson(request: Request, maxBytes = 8192): Promise<unknown> {
  const raw = await request.text();
  if (raw.length > maxBytes) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  return JSON.parse(raw);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") && !isAllowedOrigin(request, env)) {
        return jsonResponse(
          { code: "ORIGIN_FORBIDDEN", error: "Origin not allowed." },
          403,
          env,
          undefined,
          request
        );
      }
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const isMutating =
      request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "PATCH" ||
      request.method === "DELETE";

    if (isMutating && !isAllowedOrigin(request, env)) {
      return jsonResponse(
        { code: "ORIGIN_FORBIDDEN", error: "Origin not allowed." },
        403,
        env,
        undefined,
        request
      );
    }

    try {
      if (request.method === "GET" && path === "/api/health") {
        return jsonResponse({ ok: true, service: "prb005-edge-router" }, 200, env, undefined, request);
      }

      if (request.method === "GET" && path === "/api/quota") {
        try {
          const status = await getDailyQuotaStatus(env.DB, getQuotaThresholds(env));
          return jsonResponse(status, 200, env, undefined, request);
        } catch {
          return serviceUnavailableSoloResponse(env, request);
        }
      }

      if (request.method === "POST" && path === "/api/rooms") {
        const ip = getClientIp(request);
        let allowedRate = true;
        try {
          const rateKey = await hashRateLimitKey(env.ROOM_TOKEN_SECRET, "rooms", ip);
          allowedRate = await checkIpRateLimit(env.DB, rateKey, 10, 3600_000);
        } catch {
          return serviceUnavailableSoloResponse(env, request);
        }
        if (!allowedRate) {
          return rateLimitedResponse(
            "Room creation rate limit reached (max 10/hour). Solo Daily & Practice remain open.",
            env,
            request
          );
        }

        const body = (await parseBoundedJson(request)) as {
          trackId?: unknown;
          pacingMode?: unknown;
          maxPlayers?: unknown;
          roundSeconds?: unknown;
          questionCount?: unknown;
          difficulty?: unknown;
          hostName?: unknown;
        };

        if (typeof body.trackId !== "string" || !VALID_SUBTRACKS.has(body.trackId)) {
          return jsonResponse({ code: "INVALID_TRACK", error: "Unknown trackId." }, 400, env, undefined, request);
        }
        const pacingMode: PacingMode =
          body.pacingMode === "async24h" ? "async24h" : body.pacingMode === "live" ? "live" : (null as never);
        if (!pacingMode) {
          return jsonResponse({ code: "INVALID_PACING", error: "pacingMode must be live or async24h." }, 400, env, undefined, request);
        }

        const maxPlayers = typeof body.maxPlayers === "number" ? Math.trunc(body.maxPlayers) : 30;
        if (maxPlayers < 2 || maxPlayers > 50) {
          return jsonResponse({ code: "INVALID_CAPACITY", error: "maxPlayers must be between 2 and 50." }, 400, env, undefined, request);
        }

        const difficulty =
          body.difficulty === "harder" ? "harder" : body.difficulty === "standard" || body.difficulty === undefined ? "standard" : (null as never);
        if (!difficulty) {
          return jsonResponse({ code: "INVALID_DIFFICULTY", error: "difficulty must be standard or harder." }, 400, env, undefined, request);
        }

        const rawCount = body.questionCount === undefined ? 5 : Number(body.questionCount);
        if (rawCount !== 5 && rawCount !== 10 && rawCount !== 15) {
          return jsonResponse({ code: "INVALID_LENGTH", error: "questionCount must be 5, 10, or 15." }, 400, env, undefined, request);
        }
        const questionCount = rawCount as 5 | 10 | 15;

        const roundSeconds =
          typeof body.roundSeconds === "number"
            ? Math.trunc(body.roundSeconds)
            : difficulty === "harder"
            ? 15
            : 25;
        if (roundSeconds < 15 || roundSeconds > 45) {
          return jsonResponse({ code: "INVALID_TIMER", error: "roundSeconds must be 15..45." }, 400, env, undefined, request);
        }

        const nameCheck = sanitizeDisplayName(body.hostName);
        if (!nameCheck.ok) {
          return jsonResponse({ code: "INVALID_NAME", error: nameCheck.error }, 400, env, undefined, request);
        }

        let quotaCheck: Awaited<ReturnType<typeof recordRoomCreationOrShed>>;
        try {
          quotaCheck = await recordRoomCreationOrShed(env.DB, getQuotaThresholds(env));
        } catch {
          return serviceUnavailableSoloResponse(env, request);
        }
        if (!quotaCheck.allowed) {
          return jsonResponse(
            {
              code: "DAILY_QUOTA_REACHED",
              fallback: "solo",
              resetAtUtc: quotaCheck.status.reset_at_utc,
              error:
                "Live rooms are at today's free-tier safety capacity. Solo Daily & Practice remain 100% available offline/locally.",
            },
            503,
            env,
            undefined,
            request
          );
        }

        const roomCode = generateRoomCode();
        const hostPlayerId = crypto.randomUUID();
        const stub = env.ROOM_ACTOR.get(env.ROOM_ACTOR.idFromName(roomCode));
        const hydration = await stub.createRoom({
          roomCode,
          trackId: body.trackId,
          pacingMode,
          maxPlayers,
          roundSeconds,
          questionCount,
          difficulty,
          hostPlayerId,
          hostName: nameCheck.value,
        });

        const exp = Math.floor(Date.now() / 1000) + FORTY_EIGHT_HOURS_SEC;
        const playerToken = await signRoomToken(
          { roomCode, playerId: hostPlayerId, role: "host", exp },
          env.ROOM_TOKEN_SECRET
        );

        return jsonResponse(
          { roomCode, hostToken: playerToken, playerToken, hydration },
          201,
          env,
          undefined,
          request
        );
      }

      const roomMatch = path.match(/^\/api\/rooms\/([A-Za-z0-9]+)(?:\/(join|hydrate|answer|start|ready|leave|ws|metrics))?$/);
      if (roomMatch) {
        const roomCode = roomMatch[1]!.toUpperCase();
        const action = roomMatch[2] ?? "";
        if (!isValidRoomCode(roomCode)) {
          return jsonResponse({ code: "INVALID_ROOM_CODE", error: "Invalid room code format." }, 400, env, undefined, request);
        }

        if (
          (action === "ws" || request.headers.get("Upgrade")?.toLowerCase() === "websocket") &&
          !isAllowedOrigin(request, env, { requireOriginHeader: true })
        ) {
          return jsonResponse(
            { code: "ORIGIN_FORBIDDEN", error: "Origin not allowed." },
            403,
            env,
            undefined,
            request
          );
        }

        const stub = env.ROOM_ACTOR.get(env.ROOM_ACTOR.idFromName(roomCode));

        if (request.method === "GET" && action === "ws") {
          return stub.fetch(request);
        }

        if (request.method === "POST" && action === "join") {
          const ip = getClientIp(request);
          let allowedRate = true;
          try {
            const rateKey = await hashRateLimitKey(env.ROOM_TOKEN_SECRET, "join", ip);
            allowedRate = await checkIpRateLimit(env.DB, rateKey, 60, 3600_000);
          } catch {
            return serviceUnavailableSoloResponse(env, request);
          }
          if (!allowedRate) {
            return rateLimitedResponse("Too many join requests.", env, request);
          }
          const body = (await parseBoundedJson(request)) as {
            displayName?: unknown;
            playerToken?: unknown;
          };

          let reconnectPlayerId: string | undefined;
          let cleanName: string | undefined;

          if (typeof body.playerToken === "string" && body.playerToken.length > 0) {
            const claims = await verifyRoomToken(body.playerToken, env.ROOM_TOKEN_SECRET, roomCode);
            if (claims) {
              reconnectPlayerId = claims.playerId;
            }
          }

          if (!reconnectPlayerId) {
            const check = sanitizeDisplayName(body.displayName);
            if (!check.ok) {
              return jsonResponse({ code: "INVALID_NAME", error: check.error }, 400, env, undefined, request);
            }
            cleanName = check.value;
          }

          const res = await stub.joinRoom({
            displayName: cleanName,
            reconnectPlayerId,
          });
          if (!res.ok) {
            return jsonResponse({ code: res.code, error: res.error }, res.status, env, undefined, request);
          }

          const exp = Math.floor(Date.now() / 1000) + FORTY_EIGHT_HOURS_SEC;
          const playerToken = await signRoomToken(
            { roomCode, playerId: res.playerId, role: res.role, exp },
            env.ROOM_TOKEN_SECRET
          );
          return jsonResponse({ playerToken, hydration: res.hydration }, 200, env, undefined, request);
        }

        // Token-authenticated room endpoints
        const authHeader = request.headers.get("Authorization") ?? "";
        const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
        const claims = await verifyRoomToken(bearer, env.ROOM_TOKEN_SECRET, roomCode);
        if (!claims) {
          return jsonResponse({ code: "UNAUTHORIZED", error: "Valid room token required." }, 401, env, undefined, request);
        }

        if (request.method === "GET" && action === "hydrate") {
          const hydration = await stub.getHydration(claims.playerId);
          if (!hydration) {
            return jsonResponse({ code: "ROOM_EXPIRED", error: "Room not found or expired." }, 410, env, undefined, request);
          }
          return jsonResponse({ hydration }, 200, env, undefined, request);
        }

        if (request.method === "POST" && action === "start") {
          const res = await stub.startRound(claims.playerId);
          if (!res.ok) {
            return jsonResponse({ code: "START_REJECTED", error: res.error }, res.status, env, undefined, request);
          }
          return jsonResponse({ hydration: res.hydration }, 200, env, undefined, request);
        }

        if (request.method === "POST" && action === "ready") {
          const body = (await parseBoundedJson(request)) as { roundIndex?: unknown };
          if (typeof body.roundIndex !== "number") {
            return jsonResponse({ code: "INVALID_BODY", error: "Missing roundIndex." }, 400, env, undefined, request);
          }
          const res = await stub.markPlayerReady({
            playerId: claims.playerId,
            roundIndex: body.roundIndex,
          });
          if (!res.ok) {
            return jsonResponse({ code: "READY_REJECTED", error: res.error }, res.status, env, undefined, request);
          }
          return jsonResponse({ advanced: res.advanced, hydration: res.hydration }, 200, env, undefined, request);
        }

        if (request.method === "POST" && action === "leave") {
          const res = await stub.leaveRoom(claims.playerId);
          if (!res.ok) {
            return jsonResponse(
              { code: "LEAVE_REJECTED", error: "Could not leave room." },
              res.status ?? 400,
              env,
              undefined,
              request
            );
          }
          return jsonResponse({ ok: true }, 200, env, undefined, request);
        }

        if (request.method === "POST" && action === "answer") {
          const body = (await parseBoundedJson(request)) as {
            roundIndex?: unknown;
            chosenIndex?: unknown;
            idempotencyKey?: unknown;
          };
          if (
            typeof body.roundIndex !== "number" ||
            typeof body.chosenIndex !== "number" ||
            typeof body.idempotencyKey !== "string"
          ) {
            return jsonResponse({ code: "INVALID_BODY", error: "Missing answer fields." }, 400, env, undefined, request);
          }
          const res = await stub.submitAnswer({
            playerId: claims.playerId,
            roundIndex: body.roundIndex,
            chosenIndex: body.chosenIndex,
            idempotencyKey: body.idempotencyKey,
          });
          if (!res.ok) {
            return jsonResponse({ code: "SUBMIT_REJECTED", error: res.error }, res.status, env, undefined, request);
          }
          return jsonResponse(
            {
              alreadyRecorded: res.alreadyRecorded,
              reveal: res.reveal ?? null,
              hydration: res.hydration,
            },
            200,
            env,
            undefined,
            request
          );
        }

        if (request.method === "GET" && action === "metrics") {
          if (claims.role !== "host") {
            return jsonResponse({ code: "FORBIDDEN", error: "Host role required." }, 403, env, undefined, request);
          }
          const metrics = await stub.getMetrics();
          return jsonResponse({ metrics }, 200, env, undefined, request);
        }
      }

      if (request.method === "POST" && path === "/api/flags") {
        const ip = getClientIp(request);
        let allowedRate = true;
        try {
          const rateKey = await hashRateLimitKey(env.ROOM_TOKEN_SECRET, "flags", ip);
          allowedRate = await checkIpRateLimit(env.DB, rateKey, 5, 86_400_000);
        } catch {
          return serviceUnavailableSoloResponse(env, request);
        }
        if (!allowedRate) {
          return rateLimitedResponse("Daily card flag limit reached (max 5/day).", env, request);
        }
        const body = (await parseBoundedJson(request)) as {
          itemId?: unknown;
          reasonCode?: unknown;
        };
        if (typeof body.itemId !== "string" || !VALID_ITEMS.has(body.itemId)) {
          return jsonResponse({ code: "INVALID_ITEM", error: "Unknown itemId." }, 400, env, undefined, request);
        }
        if (
          typeof body.reasonCode !== "string" ||
          !VALID_FLAG_REASONS.has(body.reasonCode as FlagReason)
        ) {
          return jsonResponse({ code: "INVALID_REASON", error: "Invalid reasonCode." }, 400, env, undefined, request);
        }
        try {
          await recordCardFlag(env.DB, body.itemId, body.reasonCode as FlagReason);
        } catch {
          return serviceUnavailableSoloResponse(env, request);
        }
        return jsonResponse({ ok: true, accepted: true }, 202, env, undefined, request);
      }

      return jsonResponse({ code: "NOT_FOUND", error: "Endpoint not found." }, 404, env, undefined, request);
    } catch (err) {
      if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
        return jsonResponse({ code: "PAYLOAD_TOO_LARGE", error: "Request body too large." }, 413, env, undefined, request);
      }
      if (err instanceof SyntaxError) {
        return jsonResponse({ code: "BAD_JSON", error: "Malformed JSON body." }, 400, env, undefined, request);
      }
      console.error(
        JSON.stringify({
          message: "unhandled worker error",
          path,
          error: err instanceof Error ? err.message : String(err),
        })
      );
      return jsonResponse({ code: "INTERNAL_ERROR", error: "Internal server error." }, 500, env, undefined, request);
    }
  },
} satisfies ExportedHandler<Env>;
