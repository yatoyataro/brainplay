import type {
  ApiErrorPayload,
  ClientRoomHydration,
  PacingMode,
  RoundRevealPayload,
} from "./types.ts";

export type { ApiErrorPayload };

export interface CreateRoomResponse {
  roomCode: string;
  hostToken: string;
  playerToken: string;
  hydration: ClientRoomHydration;
}

export class ApiRequestError extends Error {
  status: number;
  payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error || `Request failed (${status})`);
    this.status = status;
    this.payload = payload;
  }
}

const TOKEN_STORAGE_PREFIX = "prb005_room_token_";
const IDEMP_STORAGE_PREFIX = "prb005_round_key_";

export function normalizeApiBase(raw?: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return "";
  return trimmed;
}

export function getApiBase(): string {
  return normalizeApiBase(import.meta.env?.VITE_API_BASE);
}

export function buildApiUrl(path: string, apiBase = getApiBase()): string {
  const base = normalizeApiBase(apiBase);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

export function getSavedRoomToken(roomCode: string): string | null {
  try {
    return localStorage.getItem(`${TOKEN_STORAGE_PREFIX}${roomCode.toUpperCase()}`);
  } catch {
    return null;
  }
}

export function saveRoomToken(roomCode: string, token: string): void {
  try {
    localStorage.setItem(`${TOKEN_STORAGE_PREFIX}${roomCode.toUpperCase()}`, token);
  } catch {
    // Ignore private-mode storage restrictions
  }
}

export function clearSavedRoomToken(roomCode: string): void {
  try {
    localStorage.removeItem(`${TOKEN_STORAGE_PREFIX}${roomCode.toUpperCase()}`);
  } catch {
    // Ignore private-mode storage restrictions
  }
}

export function getOrCreateRoundIdempotencyKey(roomCode: string, roundIndex: number): string {
  const key = `${IDEMP_STORAGE_PREFIX}${roomCode.toUpperCase()}_${roundIndex}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, created);
    return created;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiRequestError(0, {
      code: "NETWORK_ERROR",
      error: "Network request failed. Check your connection.",
    });
  }
}

async function handleJson<T>(res: Response): Promise<T> {
  const raw = await res.text();
  let data: (Partial<T> & Partial<ApiErrorPayload>) | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as Partial<T> & Partial<ApiErrorPayload>;
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const retryHeader = res.headers.get("Retry-After");
    const parsedRetry = retryHeader ? Number.parseInt(retryHeader, 10) : Number.NaN;
    const retryAfterSec =
      typeof data?.retryAfterSec === "number" && Number.isFinite(data.retryAfterSec)
        ? data.retryAfterSec
        : Number.isFinite(parsedRetry) && parsedRetry > 0
        ? parsedRetry
        : undefined;

    throw new ApiRequestError(res.status, {
      code: data?.code ?? "REQUEST_ERROR",
      error: data?.error ?? `HTTP ${res.status}`,
      fallback: data?.fallback,
      resetAtUtc: data?.resetAtUtc,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    });
  }

  if (data === null) {
    throw new ApiRequestError(res.status, {
      code: "INVALID_RESPONSE",
      error: "Server returned an unreadable response.",
    });
  }
  return data as T;
}

export async function apiCreateRoom(params: {
  trackId: string;
  pacingMode: PacingMode;
  maxPlayers: number;
  roundSeconds: number;
  questionCount?: 5 | 10 | 15;
  difficulty?: "standard" | "harder";
  hostName: string;
}): Promise<CreateRoomResponse> {
  const res = await safeFetch(buildApiUrl("/api/rooms"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await handleJson<CreateRoomResponse>(res);
  saveRoomToken(data.roomCode, data.playerToken);
  return data;
}

export async function apiJoinRoom(
  roomCode: string,
  params: { displayName?: string; playerToken?: string }
): Promise<{ playerToken: string; hydration: ClientRoomHydration }> {
  const res = await safeFetch(
    buildApiUrl(`/api/rooms/${encodeURIComponent(roomCode.toUpperCase())}/join`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
  const data = await handleJson<{ playerToken: string; hydration: ClientRoomHydration }>(res);
  saveRoomToken(roomCode, data.playerToken);
  return data;
}

export async function apiHydrateRoom(
  roomCode: string,
  token: string
): Promise<{ hydration: ClientRoomHydration }> {
  const res = await safeFetch(
    buildApiUrl(`/api/rooms/${encodeURIComponent(roomCode.toUpperCase())}/hydrate`),
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return handleJson<{ hydration: ClientRoomHydration }>(res);
}

export async function apiStartRound(
  roomCode: string,
  token: string
): Promise<{ hydration: ClientRoomHydration }> {
  const res = await safeFetch(
    buildApiUrl(`/api/rooms/${encodeURIComponent(roomCode.toUpperCase())}/start`),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return handleJson<{ hydration: ClientRoomHydration }>(res);
}

export async function apiMarkReady(
  roomCode: string,
  token: string,
  roundIndex: number
): Promise<{ advanced: boolean; hydration: ClientRoomHydration }> {
  const res = await safeFetch(
    buildApiUrl(`/api/rooms/${encodeURIComponent(roomCode.toUpperCase())}/ready`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ roundIndex }),
    }
  );
  return handleJson<{ advanced: boolean; hydration: ClientRoomHydration }>(res);
}

export async function apiLeaveRoom(code: string, token: string): Promise<void> {
  const res = await safeFetch(
    buildApiUrl(`/api/rooms/${encodeURIComponent(code.toUpperCase())}/leave`),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }
  );
  await handleJson<{ ok: boolean }>(res);
}

export async function apiSubmitAnswer(
  roomCode: string,
  token: string,
  body: { roundIndex: number; chosenIndex: number; idempotencyKey: string }
): Promise<{ alreadyRecorded: boolean; reveal: RoundRevealPayload | null; hydration: ClientRoomHydration }> {
  const res = await safeFetch(
    buildApiUrl(`/api/rooms/${encodeURIComponent(roomCode.toUpperCase())}/answer`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }
  );
  return handleJson(res);
}

export async function apiFlagCard(
  itemId: string,
  reasonCode: "typo" | "ambiguous" | "wrong_answer" | "offensive"
): Promise<void> {
  const res = await safeFetch(buildApiUrl("/api/flags"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, reasonCode }),
  });
  await handleJson(res);
}

export function buildRoomWsUrl(roomCode: string, token: string, apiBase = getApiBase()): string {
  const path = `/api/rooms/${encodeURIComponent(
    roomCode.toUpperCase()
  )}/ws?token=${encodeURIComponent(token)}`;
  const base = normalizeApiBase(apiBase);
  if (base) {
    return `${base.replace(/^http(s?):/i, "ws$1:")}${path}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}
