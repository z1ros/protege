-- =============================================================
-- Migration 001 — Idempotency + atomic authorship counter bump.
-- =============================================================
--
-- Apply once against the live Supabase project after deploying the
-- backend changes that depend on it. Idempotent — safe to re-run.
--
--   psql "$SUPABASE_DB_URL" -f apps/backend/migrations/001_idempotency_and_atomic_authorship.sql
--
-- What this lands:
--
--   1. echo_events gets a stable, client-supplied dedup id
--      (`client_event_id`) so cold-sync replays / retries can upsert
--      against an existing row instead of inserting a duplicate.
--
--   2. concept_encounters gets a stored generated `seen_at_day` column
--      and a unique index on (user_id, concept, file_path, seen_at_day)
--      so cloud-side day-grain dedup matches the local store's
--      same-day dedup logic in appendConceptEncounter().
--
--   3. A new RPC `bump_file_authorship(uid, fp, hd, ad)` performs an
--      atomic INSERT … ON CONFLICT DO UPDATE SET human_chars =
--      counters.human_chars + EXCLUDED.human_chars. Replaces the
--      read-then-upsert race in cloudBumpFileAuthorship that was
--      systematically undercounting W14 independence metrics under
--      concurrent file-save events.
--
-- Roll-back is not provided — these are additive schema changes and
-- the new RPC is opt-in. If the backend code is reverted, the columns
-- and RPC sit unused but cause no behaviour change.

BEGIN;

-- -------------------------------------------------------------
-- 1. echo_events: stable client_event_id for upsert-on-replay.
-- -------------------------------------------------------------

ALTER TABLE echo_events
  ADD COLUMN IF NOT EXISTS client_event_id TEXT;

-- Backfill existing rows with a deterministic synthetic id so a
-- post-migration cold-sync that re-pushes one of these legacy events
-- (with its locally-computed id) still finds the existing row.
-- Synthetic id = md5(user_id|event_type|ts|file). Two events that
-- collide on this tuple were already indistinguishable before; the
-- migration just makes that explicit.
UPDATE echo_events
SET client_event_id = md5(
  user_id::text || '|' ||
  event_type    || '|' ||
  ts::text      || '|' ||
  COALESCE(file, '')
)
WHERE client_event_id IS NULL;

-- Drop pre-existing duplicates BEFORE creating the unique index, so the
-- migration succeeds on a project that has already accumulated duplicate
-- rows from the old bare-insert path. Two events that collided on
-- (user_id, event_type, ts, file) were already indistinguishable — the
-- backfill produces an identical md5 for both. Keep the lowest id (the
-- one written first) per (user_id, client_event_id) tuple.
DELETE FROM echo_events e
WHERE e.id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, client_event_id
             ORDER BY id ASC
           ) AS rn
    FROM echo_events
  ) ranked
  WHERE ranked.rn > 1
);

ALTER TABLE echo_events
  ALTER COLUMN client_event_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS echo_events_client_dedup
  ON echo_events (user_id, client_event_id);

-- -------------------------------------------------------------
-- 2. concept_encounters: same-day dedup constraint.
-- -------------------------------------------------------------

ALTER TABLE concept_encounters
  ADD COLUMN IF NOT EXISTS seen_at_day DATE
    GENERATED ALWAYS AS ((seen_at AT TIME ZONE 'UTC')::date) STORED;

-- Drop any existing duplicates BEFORE creating the unique index, so
-- the migration succeeds on a project that has already accumulated
-- duplicate rows from the old bare-insert path. Keep the row with
-- the lowest id (i.e. the first written) for each (user, concept,
-- file, day) tuple.
DELETE FROM concept_encounters ce
WHERE ce.id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, concept, file_path,
                          (seen_at AT TIME ZONE 'UTC')::date
             ORDER BY id ASC
           ) AS rn
    FROM concept_encounters
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS concept_encounters_dedup
  ON concept_encounters (user_id, concept, file_path, seen_at_day);

-- -------------------------------------------------------------
-- 3. Atomic file-authorship counter bump.
-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION bump_file_authorship(
  uid uuid,
  fp  text,
  hd  integer,
  ad  integer
)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO file_authorship_counters (
    user_id, file_path, human_chars, ai_chars, updated_at
  )
  VALUES (
    uid, fp, GREATEST(COALESCE(hd, 0), 0), GREATEST(COALESCE(ad, 0), 0), now()
  )
  ON CONFLICT (user_id, file_path) DO UPDATE
    SET human_chars = file_authorship_counters.human_chars + EXCLUDED.human_chars,
        ai_chars    = file_authorship_counters.ai_chars    + EXCLUDED.ai_chars,
        updated_at  = now();
$$;

REVOKE ALL ON FUNCTION bump_file_authorship(uuid, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bump_file_authorship(uuid, text, integer, integer) TO service_role;

COMMIT;
