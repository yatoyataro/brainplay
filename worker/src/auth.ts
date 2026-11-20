import type { PlayerRole } from "../../src/core/types.ts";

export interface RoomTokenClaims {
  roomCode: string;
  playerId: string;
  role: PlayerRole;
  exp: number; // epoch seconds
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(str: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  try {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 16) {
    throw new Error("ROOM_TOKEN_SECRET is missing or too short (must be >= 16 chars)");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signRoomToken(claims: RoomTokenClaims, secret: string): Promise<string> {
  const key = await importHmacKey(secret);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(claims));
  const payloadB64 = toBase64Url(payloadBytes);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

export async function verifyRoomToken(
  token: string,
  secret: string,
  expectedRoomCode?: string
): Promise<RoomTokenClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (!sigBytes || !payloadBytes) return null;

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(payloadB64)
  );
  if (!valid) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as Partial<RoomTokenClaims>;
  if (
    typeof c.roomCode !== "string" ||
    typeof c.playerId !== "string" ||
    (c.role !== "host" && c.role !== "guest") ||
    typeof c.exp !== "number"
  ) {
    return null;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (c.exp < nowSec) return null;
  if (expectedRoomCode && c.roomCode !== expectedRoomCode) return null;
  return c as RoomTokenClaims;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length]!;
  }
  return out;
}
