export type FlagReason = "typo" | "ambiguous" | "wrong_answer" | "offensive";

export interface DailyQuotaStatus {
  utc_date: string;
  rooms_created: number;
  estimated_do_requests: number;
  estimated_do_writes: number;
  flags_logged: number;
  quota_shed_events: number;
  shedding_active: boolean;
  reset_at_utc: string;
}

export interface QuotaThresholds {
  requestHardCap: number;
  writeHardCap: number;
  shedRatio: number;
}

// Conservative estimated DO budget per room under DEC-005 (used for proactive 85% shedding)
const EST_DO_REQS_PER_ROOM = 32;
const EST_DO_WRITES_PER_ROOM = 75;

export function getUtcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function getNextUtcMidnightIso(now = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString();
}

export async function getDailyQuotaStatus(
  db: D1Database,
  thresholds: QuotaThresholds,
  now = new Date()
): Promise<DailyQuotaStatus> {
  const utcDate = getUtcDateKey(now);
  const row = await db
    .prepare(
      `SELECT utc_date, rooms_created, estimated_do_requests, estimated_do_writes, flags_logged, quota_shed_events
       FROM DAILY_QUOTA_COUNTER WHERE utc_date = ?`
    )
    .bind(utcDate)
    .first<{
      utc_date: string;
      rooms_created: number;
      estimated_do_requests: number;
      estimated_do_writes: number;
      flags_logged: number;
      quota_shed_events: number;
    }>();

  const reqCap = Math.floor(thresholds.requestHardCap * thresholds.shedRatio);
  const writeCap = Math.floor(thresholds.writeHardCap * thresholds.shedRatio);

  const reqs = row?.estimated_do_requests ?? 0;
  const writes = row?.estimated_do_writes ?? 0;

  return {
    utc_date: utcDate,
    rooms_created: row?.rooms_created ?? 0,
    estimated_do_requests: reqs,
    estimated_do_writes: writes,
    flags_logged: row?.flags_logged ?? 0,
    quota_shed_events: row?.quota_shed_events ?? 0,
    shedding_active: reqs >= reqCap || writes >= writeCap,
    reset_at_utc: getNextUtcMidnightIso(now),
  };
}

export async function recordRoomCreationOrShed(
  db: D1Database,
  thresholds: QuotaThresholds,
  now = new Date()
): Promise<{ allowed: boolean; status: DailyQuotaStatus }> {
  const status = await getDailyQuotaStatus(db, thresholds, now);
  const utcDate = status.utc_date;

  if (status.shedding_active) {
    await db
      .prepare(
        `INSERT INTO DAILY_QUOTA_COUNTER (utc_date, quota_shed_events) VALUES (?, 1)
         ON CONFLICT(utc_date) DO UPDATE SET quota_shed_events = quota_shed_events + 1`
      )
      .bind(utcDate)
      .run();
    return {
      allowed: false,
      status: { ...status, quota_shed_events: status.quota_shed_events + 1 },
    };
  }

  await db
    .prepare(
      `INSERT INTO DAILY_QUOTA_COUNTER (utc_date, rooms_created, estimated_do_requests, estimated_do_writes)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(utc_date) DO UPDATE SET
         rooms_created = rooms_created + 1,
         estimated_do_requests = estimated_do_requests + excluded.estimated_do_requests,
         estimated_do_writes = estimated_do_writes + excluded.estimated_do_writes`
    )
    .bind(utcDate, EST_DO_REQS_PER_ROOM, EST_DO_WRITES_PER_ROOM)
    .run();

  return {
    allowed: true,
    status: {
      ...status,
      rooms_created: status.rooms_created + 1,
      estimated_do_requests: status.estimated_do_requests + EST_DO_REQS_PER_ROOM,
      estimated_do_writes: status.estimated_do_writes + EST_DO_WRITES_PER_ROOM,
    },
  };
}

export async function checkIpRateLimit(
  db: D1Database,
  bucketKey: string,
  maxRequests: number,
  windowMs: number,
  nowMs = Date.now()
): Promise<boolean> {
  await db
    .prepare(`DELETE FROM IP_RATE_LIMIT WHERE expires_at_ms <= ?`)
    .bind(nowMs)
    .run();

  const existing = await db
    .prepare(`SELECT request_count, expires_at_ms FROM IP_RATE_LIMIT WHERE bucket_key = ?`)
    .bind(bucketKey)
    .first<{ request_count: number; expires_at_ms: number }>();

  if (!existing || existing.expires_at_ms <= nowMs) {
    await db
      .prepare(
        `INSERT INTO IP_RATE_LIMIT (bucket_key, request_count, expires_at_ms) VALUES (?, 1, ?)
         ON CONFLICT(bucket_key) DO UPDATE SET request_count = 1, expires_at_ms = excluded.expires_at_ms`
      )
      .bind(bucketKey, nowMs + windowMs)
      .run();
    return true;
  }

  if (existing.request_count >= maxRequests) {
    return false;
  }

  await db
    .prepare(`UPDATE IP_RATE_LIMIT SET request_count = request_count + 1 WHERE bucket_key = ?`)
    .bind(bucketKey)
    .run();
  return true;
}

export async function recordCardFlag(
  db: D1Database,
  itemId: string,
  reasonCode: FlagReason,
  now = new Date()
): Promise<void> {
  const iso = now.toISOString();
  const utcDate = iso.slice(0, 10);
  await db.batch([
    db
      .prepare(
        `INSERT INTO CARD_FLAG_AGGREGATE (item_id, reason_code, flag_count, last_flagged_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(item_id, reason_code) DO UPDATE SET
           flag_count = flag_count + 1,
           last_flagged_at = excluded.last_flagged_at`
      )
      .bind(itemId, reasonCode, iso),
    db
      .prepare(
        `INSERT INTO DAILY_QUOTA_COUNTER (utc_date, flags_logged) VALUES (?, 1)
         ON CONFLICT(utc_date) DO UPDATE SET flags_logged = flags_logged + 1`
      )
      .bind(utcDate),
  ]);
}
