-- =============================================================
-- Migration 003 — Beta sync tables: user_quotas, notes, chat_messages.
-- =============================================================
--
-- Apply once against the live Supabase project. Idempotent — safe
-- to re-run.
--
--   psql "$SUPABASE_DB_URL" -f apps/backend/migrations/003_beta_sync_tables.sql
--
-- Or copy/paste into the Supabase SQL editor at
--   https://supabase.com/dashboard/project/<project_ref>/sql/new
--
-- What this lands:
--
--   user_quotas    — per-user daily counters + cost estimate, used by
--                    the beta-tier rate limiter and the Profile usage
--                    panel. Per-route counters (scan/teach/tts/stt/
--                    verify/classify) plus user-facing rollups
--                    (tool_calls, voice_minutes, chat_minutes) and a
--                    USD estimate. Resets implicitly at 00:00 UTC by
--                    way of a new (user_id, day) row.
--
--   notes          — per-user notes synced from the extension. Local
--                    globalState is the offline cache; this is the
--                    source of truth on activate.
--
--   chat_messages  — append-only chat history per user. Lets a user
--                    move between machines and keep the conversation.
--                    Pruning lives client-side (cap 500); cloud keeps
--                    the full archive.
--
--   user_quotas_weekly — view rolling up daily quota rows by ISO week
--                        for telemetry dashboards.
--
-- Security:
--
--   - RLS enabled on all three tables.
--   - service_role gets full read/write (the backend authenticates
--     with the service key and is the only writer).
--   - anon and authenticated PostgREST callers see nothing — every
--     read MUST funnel through the backend's githubAuth() middleware.
--
-- Roll-back is not provided — additive only. Drop a table by hand if
-- you ever need to.
--
-- =============================================================

BEGIN;

-- ---------------------------------------------------------------
-- user_quotas
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_quotas (
  user_id            TEXT NOT NULL,
  day                DATE NOT NULL DEFAULT current_date,
  -- Per-route counters (cost protection — internal, not surfaced).
  scan_calls         INTEGER NOT NULL DEFAULT 0,
  teach_calls        INTEGER NOT NULL DEFAULT 0,
  tts_calls          INTEGER NOT NULL DEFAULT 0,
  stt_calls          INTEGER NOT NULL DEFAULT 0,
  verify_calls       INTEGER NOT NULL DEFAULT 0,
  classify_calls     INTEGER NOT NULL DEFAULT 0,
  -- User-facing rollups (shown in Profile panel).
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  voice_minutes      NUMERIC(10, 2) NOT NULL DEFAULT 0,
  chat_minutes       NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- Sum of per-call $ estimates. Trips the daily hard cap.
  total_usd_estimate NUMERIC(10, 6) NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- ALTERs: in case an older v0 table exists without the user-facing
-- columns. CREATE TABLE IF NOT EXISTS won't add new columns to an
-- existing table; these will.
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS tool_calls    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS voice_minutes NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE user_quotas ADD COLUMN IF NOT EXISTS chat_minutes  NUMERIC(10, 2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_user_quotas_user_day
  ON user_quotas (user_id, day);

ALTER TABLE user_quotas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_quotas FROM PUBLIC;
REVOKE ALL ON user_quotas FROM anon;
REVOKE ALL ON user_quotas FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_quotas TO service_role;

-- Weekly rollup view for telemetry dashboards.
CREATE OR REPLACE VIEW user_quotas_weekly AS
SELECT
  user_id,
  date_trunc('week', day)::date AS week,
  SUM(scan_calls)         AS scan_calls,
  SUM(teach_calls)        AS teach_calls,
  SUM(tts_calls)          AS tts_calls,
  SUM(stt_calls)          AS stt_calls,
  SUM(verify_calls)       AS verify_calls,
  SUM(classify_calls)     AS classify_calls,
  SUM(tool_calls)         AS tool_calls,
  SUM(voice_minutes)      AS voice_minutes,
  SUM(chat_minutes)       AS chat_minutes,
  SUM(total_usd_estimate) AS total_usd_estimate
FROM user_quotas
GROUP BY user_id, week;

REVOKE ALL ON user_quotas_weekly FROM PUBLIC;
REVOKE ALL ON user_quotas_weekly FROM anon;
REVOKE ALL ON user_quotas_weekly FROM authenticated;
GRANT SELECT ON user_quotas_weekly TO service_role;

-- ---------------------------------------------------------------
-- notes
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT 'Untitled',
  body       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_user_updated
  ON notes (user_id, updated_at DESC);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notes FROM PUBLIC;
REVOKE ALL ON notes FROM anon;
REVOKE ALL ON notes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO service_role;

-- ---------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
  ON chat_messages (user_id, created_at);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON chat_messages FROM PUBLIC;
REVOKE ALL ON chat_messages FROM anon;
REVOKE ALL ON chat_messages FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO service_role;

COMMIT;
