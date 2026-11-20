import { TIER_ORDER } from "./mastery.ts";
import type { LocalActiveDay, LocalMasteryItem } from "./types.ts";

export interface BackupPayloadV1 {
  schema_version: 1;
  exported_at: string;
  mastery: LocalMasteryItem[];
  active_days: LocalActiveDay[];
  checksum: string;
}

function fnv1a64Hex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

function canonicalBody(
  schemaVersion: 1,
  exportedAt: string,
  mastery: LocalMasteryItem[],
  activeDays: LocalActiveDay[]
): string {
  return JSON.stringify({
    schema_version: schemaVersion,
    exported_at: exportedAt,
    mastery,
    active_days: activeDays,
  });
}

export function createBackupPayload(
  mastery: LocalMasteryItem[],
  activeDays: LocalActiveDay[],
  exportedAt = new Date().toISOString()
): BackupPayloadV1 {
  const sortedMastery = [...mastery].sort((a, b) => a.item_id.localeCompare(b.item_id));
  const sortedDays = [...activeDays].sort((a, b) => a.local_date.localeCompare(b.local_date));
  const checksum = fnv1a64Hex(canonicalBody(1, exportedAt, sortedMastery, sortedDays));
  return {
    schema_version: 1,
    exported_at: exportedAt,
    mastery: sortedMastery,
    active_days: sortedDays,
    checksum,
  };
}

function toBase64Url(utf8: string): string {
  const bytes = new TextEncoder().encode(utf8);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(b64url: string): string {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function encodeSyncString(
  mastery: LocalMasteryItem[],
  activeDays: LocalActiveDay[],
  exportedAt = new Date().toISOString()
): string {
  const payload = createBackupPayload(mastery, activeDays, exportedAt);
  const body = JSON.stringify(payload);
  return `BP1.${toBase64Url(body)}`;
}

export type ParseBackupResult =
  | { ok: true; payload: BackupPayloadV1 }
  | { ok: false; error: string };

const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

export function parseAndVerifyBackup(rawInput: string): ParseBackupResult {
  if (rawInput.length > MAX_BACKUP_BYTES) {
    return { ok: false, error: "Backup input exceeds 2 MB size limit." };
  }
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: "Backup input is empty." };
  }

  let jsonText = trimmed;
  if (trimmed.startsWith("BP1.")) {
    const encoded = trimmed.slice(4);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
      return { ok: false, error: "Sync code contains invalid characters." };
    }
    try {
      jsonText = fromBase64Url(encoded);
    } catch {
      return { ok: false, error: "Sync code could not be decoded." };
    }
    if (jsonText.length > MAX_BACKUP_BYTES) {
      return { ok: false, error: "Backup payload exceeds 2 MB size limit." };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: "Backup JSON is malformed." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Backup payload must be an object." };
  }
  const obj = parsed as Partial<BackupPayloadV1>;
  if (obj.schema_version !== 1) {
    return { ok: false, error: `Unsupported backup schema version: ${String(obj.schema_version)}.` };
  }
  if (
    typeof obj.exported_at !== "string" ||
    !Array.isArray(obj.mastery) ||
    !Array.isArray(obj.active_days) ||
    typeof obj.checksum !== "string"
  ) {
    return { ok: false, error: "Backup is missing required fields." };
  }

  for (const m of obj.mastery) {
    if (
      !m ||
      typeof m !== "object" ||
      Array.isArray(m) ||
      typeof m.item_id !== "string" ||
      typeof m.subtrack_id !== "string" ||
      typeof m.tier !== "string" ||
      !Object.hasOwn(TIER_ORDER, m.tier) ||
      typeof m.streak_count !== "number" ||
      !Number.isFinite(m.streak_count) ||
      typeof m.next_due_date !== "string" ||
      typeof m.updated_at !== "string"
    ) {
      return { ok: false, error: "Backup contains invalid mastery entry." };
    }
  }

  for (const d of obj.active_days) {
    if (
      !d ||
      typeof d !== "object" ||
      Array.isArray(d) ||
      typeof d.local_date !== "string" ||
      typeof d.cards_completed !== "number" ||
      !Number.isFinite(d.cards_completed)
    ) {
      return { ok: false, error: "Backup contains invalid active-day entry." };
    }
  }

  const expected = fnv1a64Hex(
    canonicalBody(1, obj.exported_at, obj.mastery, obj.active_days)
  );
  if (expected !== obj.checksum) {
    return {
      ok: false,
      error: "Checksum verification failed. Existing local mastery was left untouched.",
    };
  }

  return { ok: true, payload: obj as BackupPayloadV1 };
}

/**
 * Deterministic merge using max(masteryTier) per BR-09.
 */
export function mergeMasteryState(
  existingMastery: LocalMasteryItem[],
  incomingMastery: LocalMasteryItem[],
  existingDays: LocalActiveDay[],
  incomingDays: LocalActiveDay[]
): { mastery: LocalMasteryItem[]; activeDays: LocalActiveDay[] } {
  const masteryMap = new Map<string, LocalMasteryItem>();
  for (const item of existingMastery) masteryMap.set(item.item_id, item);

  for (const inc of incomingMastery) {
    const cur = masteryMap.get(inc.item_id);
    if (!cur) {
      masteryMap.set(inc.item_id, inc);
      continue;
    }
    const curRank = TIER_ORDER[cur.tier];
    const incRank = TIER_ORDER[inc.tier];
    const winner =
      incRank > curRank || (incRank === curRank && inc.updated_at > cur.updated_at) ? inc : cur;
    masteryMap.set(inc.item_id, {
      ...winner,
      flagged_hidden: cur.flagged_hidden || inc.flagged_hidden,
    });
  }

  const dayMap = new Map<string, LocalActiveDay>();
  for (const day of existingDays) dayMap.set(day.local_date, day);
  for (const inc of incomingDays) {
    const cur = dayMap.get(inc.local_date);
    if (!cur) {
      dayMap.set(inc.local_date, inc);
      continue;
    }
    dayMap.set(inc.local_date, {
      local_date: cur.local_date,
      cards_completed: Math.max(cur.cards_completed, inc.cards_completed),
      daily_grid_summary: cur.daily_grid_summary ?? inc.daily_grid_summary,
      subtrack_id: cur.subtrack_id ?? inc.subtrack_id,
    });
  }

  return {
    mastery: Array.from(masteryMap.values()),
    activeDays: Array.from(dayMap.values()),
  };
}
