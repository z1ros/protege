-- =============================================================
-- Migration 002 — Generalized concept-tip cache.
-- =============================================================
--
-- Apply once against the live Supabase project. Idempotent — safe
-- to re-run.
--
--   psql "$SUPABASE_DB_URL" -f apps/backend/migrations/002_concept_tips.sql
--
-- What this lands:
--
--   concept_tips: a globally-shared cache for the "Did you know?"
--   CodeLens. Keyed by (language, concept_name, prompt_version).
--
--   - Tip text is generalized (not personalized), so a single row
--     serves every user. New users hit cached rows from day one.
--
--   - prompt_version is a monotonic int controlled by the backend
--     constant in routes/conceptTips.ts. Bumping it invalidates the
--     cache without touching the table — old rows stay resident
--     (cheap) but become invisible to lookups.
--
--   - hits + last_hit_at are best-effort analytics; readers MAY
--     skip updating them. Writers always insert; conflicts no-op.
--
-- Security:
--
--   - RLS enabled.
--   - Only service_role gets read/write; PostgREST anon never sees
--     this table. All access must funnel through the backend route,
--     which validates concept_name against a charset/length pattern
--     and language against an allowlist before hitting the LLM or
--     the table.
--
-- Roll-back is not provided — additive table only. Drop the table
-- by hand if you ever need to.
--
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS concept_tips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  language        TEXT NOT NULL,
  concept_name    TEXT NOT NULL,
  prompt_version  INTEGER NOT NULL DEFAULT 1,
  tip             TEXT NOT NULL,
  model           TEXT NOT NULL,
  tokens_in       INTEGER DEFAULT 0,
  tokens_out      INTEGER DEFAULT 0,
  hits            INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  last_hit_at     TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT concept_tips_lang_concept_ver_key
    UNIQUE (language, concept_name, prompt_version),
  CONSTRAINT concept_tips_tip_len CHECK (char_length(tip) BETWEEN 1 AND 1000),
  CONSTRAINT concept_tips_concept_len CHECK (char_length(concept_name) BETWEEN 1 AND 64),
  CONSTRAINT concept_tips_lang_len CHECK (char_length(language) BETWEEN 1 AND 32)
);

CREATE INDEX IF NOT EXISTS concept_tips_lookup
  ON concept_tips (language, concept_name, prompt_version);

-- Lock the table down: only the service role reads/writes; the backend
-- is the only path. Anon/authenticated PostgREST callers see nothing.
ALTER TABLE concept_tips ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON concept_tips FROM PUBLIC;
REVOKE ALL ON concept_tips FROM anon;
REVOKE ALL ON concept_tips FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON concept_tips TO service_role;

COMMIT;
