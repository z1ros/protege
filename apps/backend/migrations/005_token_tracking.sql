-- Migration 005 — token tracking on user_quotas
-- ----------------------------------------------------------------
-- Add prompt_tokens / completion_tokens / total_tokens columns to
-- user_quotas so we have per-day token visibility, not just $ estimate.
-- The $ estimate is still the enforcement signal (DAILY_USD_HARD_CAP);
-- tokens are stored alongside for analytics, billing audits, and the
-- Profile panel's optional token counter.
--
-- Why three columns instead of one: OpenAI's API returns
--   usage.prompt_tokens     — input cost basis (cheaper, $1.25/M on gpt-5)
--   usage.completion_tokens — output cost basis (more expensive, $10/M)
-- Stored separately because the per-million pricing differs ~8×, so a
-- single "total" hides which side of the conversation is dominant cost.
--
-- Performance: piggybacks on the existing addCostUsd UPSERT — no extra
-- round-trip per /chat turn. addCostUsd already does a read-modify-
-- upsert; we just include three more numeric columns in the same write.

ALTER TABLE user_quotas
  ADD COLUMN IF NOT EXISTS prompt_tokens     BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_quotas
  ADD COLUMN IF NOT EXISTS completion_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE user_quotas
  ADD COLUMN IF NOT EXISTS total_tokens      BIGINT NOT NULL DEFAULT 0;

-- BIGINT (not INTEGER) because heavy users could plausibly exceed
-- INTEGER's 2.1B ceiling over a long-running cumulative view; a single
-- chat turn is ~5K tokens, 360 turns/day × 1 year × 1 user = ~660M
-- tokens. INTEGER would last ~3 years. BIGINT is futureproof.
