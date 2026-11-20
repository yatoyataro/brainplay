-- Cloudflare D1 Schema for PRB-005 (Zero-PII Metadata Only)
-- Supports REQ-008 (CARD_FLAG_AGGREGATE) and REQ-010 (DAILY_QUOTA_COUNTER)

CREATE TABLE IF NOT EXISTS CARD_FLAG_AGGREGATE (
  item_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('typo', 'ambiguous', 'wrong_answer', 'offensive')),
  flag_count INTEGER NOT NULL DEFAULT 1,
  last_flagged_at TEXT NOT NULL,
  PRIMARY KEY (item_id, reason_code)
);

CREATE TABLE IF NOT EXISTS DAILY_QUOTA_COUNTER (
  utc_date TEXT PRIMARY KEY,
  rooms_created INTEGER NOT NULL DEFAULT 0,
  estimated_do_requests INTEGER NOT NULL DEFAULT 0,
  estimated_do_writes INTEGER NOT NULL DEFAULT 0,
  flags_logged INTEGER NOT NULL DEFAULT 0,
  quota_shed_events INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS IP_RATE_LIMIT (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 1,
  expires_at_ms INTEGER NOT NULL
);
