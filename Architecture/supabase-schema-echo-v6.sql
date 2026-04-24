-- ============================================================
-- Protege v6 — Echo durability layer
--
-- Adds the 8 Echo-era tables + extends `concepts` with 4 columns
-- so Supabase can be the source of truth for Echo data while the
-- local .protege-store.json keeps acting as a read-through cache.
--
-- Safe to re-run: every CREATE / ALTER / INDEX is guarded with
-- IF NOT EXISTS; the whole script is wrapped in a single txn so
-- partial failures roll back cleanly.
--
-- This file is applied MANUALLY by the operator (Supabase SQL
-- editor, `psql`, or `supabase db push`). Rv6.A does not apply
-- it programmatically.
--
-- Rollback (documented separately, not inline): DROP the 8 new
-- tables and ALTER TABLE concepts DROP COLUMN the 4 new columns.
-- ============================================================

BEGIN;

-- ----------------------------------------------------------------
-- Extensions to the existing `concepts` table (additive; idempotent)
-- ----------------------------------------------------------------
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS has_been_authored BOOLEAN DEFAULT false;
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS first_authored_at TIMESTAMPTZ;
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS authorship_ratio NUMERIC;

-- ----------------------------------------------------------------
-- Raw Echo event log. Partitioned-friendly; indexed by (user_id, ts DESC).
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS echo_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  ts BIGINT NOT NULL,
  file TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Daily behaviour aggregates. PK (user_id, date) enables idempotent upserts.
CREATE TABLE IF NOT EXISTS behavior_daily_rollups (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  active_minutes INT DEFAULT 0,
  total_minutes INT DEFAULT 0,
  sessions_count INT DEFAULT 0,
  session_minutes INT DEFAULT 0,
  hour_histogram INT[] DEFAULT ARRAY_FILL(0, ARRAY[24]),
  lines_added INT DEFAULT 0,
  lines_removed INT DEFAULT 0,
  lines_net INT DEFAULT 0,
  files_touched TEXT[] DEFAULT ARRAY[]::TEXT[],
  file_hops INT DEFAULT 0,
  archetype_hint TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, date)
);

-- User-owned known/not_known status per concept (one row per user+concept).
CREATE TABLE IF NOT EXISTS concept_statuses (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unset','known','not_known')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, concept)
);

-- File-open / save driven concept sightings, stamped with authorship ratio.
CREATE TABLE IF NOT EXISTS concept_encounters (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  concept TEXT NOT NULL,
  file_path TEXT NOT NULL,
  language TEXT,
  seen_at TIMESTAMPTZ NOT NULL,
  authorship_ratio_at_time NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-file human-vs-AI char counters; drives the authorship ratio.
CREATE TABLE IF NOT EXISTS file_authorship_counters (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  human_chars INT DEFAULT 0,
  ai_chars INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, file_path)
);

-- Line-level rewrite counters for the "hot spots" surfacing.
CREATE TABLE IF NOT EXISTS line_rewrite_counters (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line_fingerprint TEXT NOT NULL,
  rewrite_count INT DEFAULT 0,
  last_content TEXT,
  last_rewrite_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, file_path, line_fingerprint)
);

-- Per-commit narrative rollup (active minutes, paste/undo counts, AI accepts).
CREATE TABLE IF NOT EXISTS commit_stories (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  commit_ts TIMESTAMPTZ NOT NULL,
  message TEXT NOT NULL,
  active_minutes INT DEFAULT 0,
  undo_count INT DEFAULT 0,
  paste_count INT DEFAULT 0,
  ai_accept_count INT DEFAULT 0,
  files_touched TEXT[] DEFAULT ARRAY[]::TEXT[],
  peak_focus_min INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, commit_sha)
);

-- W17 substrate: per-workspace concept index populated by the scanner.
CREATE TABLE IF NOT EXISTS repo_concept_index (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_root TEXT NOT NULL,
  concept TEXT NOT NULL,
  language TEXT,
  file_count INT DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, workspace_root, concept)
);

-- ----------------------------------------------------------------
-- Indexes (minimal + targeted; composite PKs cover point lookups for free)
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_echo_events_user_ts
  ON echo_events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_echo_events_user_type_ts
  ON echo_events (user_id, event_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_concept_encounters_user_seen
  ON concept_encounters (user_id, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_commit_stories_user_commit_ts
  ON commit_stories (user_id, commit_ts DESC);
CREATE INDEX IF NOT EXISTS idx_line_rewrite_counters_user_last_rewrite
  ON line_rewrite_counters (user_id, last_rewrite_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_authorship_counters_user_updated
  ON file_authorship_counters (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_repo_concept_index_user_last_seen
  ON repo_concept_index (user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_daily_rollups_user_date
  ON behavior_daily_rollups (user_id, date DESC);

-- ----------------------------------------------------------------
-- Row-Level Security — every new table is user-isolated.
-- Policies use DROP+CREATE (not `CREATE POLICY IF NOT EXISTS`) to
-- stay compatible with Postgres versions that don't support the
-- IF NOT EXISTS clause on policies.
-- ----------------------------------------------------------------
ALTER TABLE echo_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "echo_events_user_isolation" ON echo_events;
CREATE POLICY "echo_events_user_isolation" ON echo_events
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE behavior_daily_rollups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "behavior_daily_rollups_user_isolation" ON behavior_daily_rollups;
CREATE POLICY "behavior_daily_rollups_user_isolation" ON behavior_daily_rollups
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE concept_statuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "concept_statuses_user_isolation" ON concept_statuses;
CREATE POLICY "concept_statuses_user_isolation" ON concept_statuses
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE concept_encounters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "concept_encounters_user_isolation" ON concept_encounters;
CREATE POLICY "concept_encounters_user_isolation" ON concept_encounters
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE file_authorship_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "file_authorship_counters_user_isolation" ON file_authorship_counters;
CREATE POLICY "file_authorship_counters_user_isolation" ON file_authorship_counters
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE line_rewrite_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "line_rewrite_counters_user_isolation" ON line_rewrite_counters;
CREATE POLICY "line_rewrite_counters_user_isolation" ON line_rewrite_counters
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE commit_stories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "commit_stories_user_isolation" ON commit_stories;
CREATE POLICY "commit_stories_user_isolation" ON commit_stories
  FOR ALL USING (user_id = auth.uid());

ALTER TABLE repo_concept_index ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "repo_concept_index_user_isolation" ON repo_concept_index;
CREATE POLICY "repo_concept_index_user_isolation" ON repo_concept_index
  FOR ALL USING (user_id = auth.uid());

-- ----------------------------------------------------------------
-- Retention cleanup — single PL/pgSQL function the operator can
-- schedule via Supabase pg_cron or an Edge Function:
--
--   SELECT echo_cleanup_retention();
--
-- Caps match the local-store caps so Supabase never carries more
-- than the source of truth. `echo_events` is also age-bounded to
-- 45 days (its dominant-cost table) in addition to the per-user
-- 50k cap the backend already enforces on the hot path.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION echo_cleanup_retention()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff_ms BIGINT;
BEGIN
  -- echo_events: age-bounded at 45 days.
  cutoff_ms := (EXTRACT(EPOCH FROM (NOW() - INTERVAL '45 days')) * 1000)::BIGINT;
  DELETE FROM echo_events WHERE ts < cutoff_ms;

  -- concept_encounters: keep 5000 most-recent per user.
  DELETE FROM concept_encounters ce
  WHERE ce.id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY seen_at DESC) AS rn
      FROM concept_encounters
    ) ranked
    WHERE ranked.rn > 5000
  );

  -- behavior_daily_rollups: keep 120 most-recent per user.
  DELETE FROM behavior_daily_rollups r
  WHERE (r.user_id, r.date) IN (
    SELECT user_id, date FROM (
      SELECT user_id, date,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY date DESC) AS rn
      FROM behavior_daily_rollups
    ) ranked
    WHERE ranked.rn > 120
  );

  -- commit_stories: keep 200 most-recent per user (by commit_ts).
  DELETE FROM commit_stories s
  WHERE (s.user_id, s.commit_sha) IN (
    SELECT user_id, commit_sha FROM (
      SELECT user_id, commit_sha,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY commit_ts DESC) AS rn
      FROM commit_stories
    ) ranked
    WHERE ranked.rn > 200
  );

  -- repo_concept_index: LRU-trim to 10000 rows per user (by last_seen_at).
  DELETE FROM repo_concept_index i
  WHERE (i.user_id, i.workspace_root, i.concept) IN (
    SELECT user_id, workspace_root, concept FROM (
      SELECT user_id, workspace_root, concept,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY last_seen_at DESC) AS rn
      FROM repo_concept_index
    ) ranked
    WHERE ranked.rn > 10000
  );

  -- file_authorship_counters: LRU-trim to 500 rows per user (by updated_at).
  DELETE FROM file_authorship_counters f
  WHERE (f.user_id, f.file_path) IN (
    SELECT user_id, file_path FROM (
      SELECT user_id, file_path,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY updated_at DESC) AS rn
      FROM file_authorship_counters
    ) ranked
    WHERE ranked.rn > 500
  );
END;
$$;

COMMIT;
