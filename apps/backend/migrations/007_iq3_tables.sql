-- 007_iq3_tables.sql
-- Code IQ v3 storage. All tables prefixed iq3_*. Additive on echo schema.
-- Idempotent: safe to re-run.
--
-- Moved from Architecture/migration-006-iq3-tables.sql; renumbered to 007
-- (006 is already chat_sessions). The old file was outside the migrations
-- directory so the runner never executed it — leaving prod without iq3_*
-- tables. Do not re-introduce a file at the old path.

-- HMM state per user. One row per user.
create table if not exists iq3_user_state (
  user_id        text primary key,
  traits         jsonb not null,                       -- Record<TraitId, {low,mid,high}>
  field_vector   jsonb not null,                       -- Record<FieldId, number>
  event_count    integer not null default 0,
  ai_event_count integer not null default 0,
  schema_version smallint not null default 1,
  updated_at     timestamptz not null default now()
);

create index if not exists iq3_user_state_updated_at_idx
  on iq3_user_state (updated_at);

-- Per-day snapshot of pillar scores. One row per user per day.
-- Used for trajectory charts in the Story tab (Phase C); harvested in Phase A
-- so the data is already there when Phase C ships.
create table if not exists iq3_pillar_history (
  user_id        text not null,
  snapshot_date  date not null,
  headline       integer not null,                     -- 0..1000+
  ci_half_width  integer not null,
  pillars        jsonb not null,                       -- Record<PillarId, {score, ciHalfWidth, ciCoverage, pending}>
  rank           text not null,                        -- learner|junior|mid|senior
  dominant_field text not null,                        -- field id
  primary key (user_id, snapshot_date)
);

create index if not exists iq3_pillar_history_user_idx
  on iq3_pillar_history (user_id, snapshot_date desc);

-- Periodic self-rating survey responses.
create table if not exists iq3_self_ratings (
  id        uuid primary key default gen_random_uuid(),
  user_id   text not null,
  rating    smallint not null check (rating between 1 and 10),
  rated_at  timestamptz not null default now(),
  note      text
);

create index if not exists iq3_self_ratings_user_idx
  on iq3_self_ratings (user_id, rated_at desc);

-- Anonymous "found something weird?" feedback on Code IQ scoring.
-- Endpoint is auth-gated against spam, but the row deliberately stores
-- only the trimmed text + a server timestamp — no user_id, so a flag
-- cannot be tied back to the caller's GitHub identity.
create table if not exists iq3_feedback (
  id            uuid primary key default gen_random_uuid(),
  text          text not null check (length(text) between 1 and 1000),
  submitted_at  timestamptz not null default now()
);

create index if not exists iq3_feedback_submitted_idx
  on iq3_feedback (submitted_at desc);

-- Materialized cohort percentiles per (field, headline). Rebuilt nightly.
create table if not exists iq3_cohort_stats (
  field            text not null,
  -- Bucketed headline (rounded to nearest 25); cumulative percentile within field
  headline_bucket  integer not null,
  percentile       numeric(5,2) not null,
  computed_at      timestamptz not null default now(),
  primary key (field, headline_bucket)
);

-- RLS lockdown. Backend talks to Supabase via service_role, which
-- bypasses RLS. Anon-key holders (the extension ships one) must NOT
-- be able to read or write iq3 state — these tables contain a per-user
-- behavioral fingerprint that is by-design private.
alter table iq3_user_state     enable row level security;
alter table iq3_pillar_history enable row level security;
alter table iq3_self_ratings   enable row level security;
alter table iq3_feedback       enable row level security;
alter table iq3_cohort_stats   enable row level security;

revoke all on iq3_user_state     from public, anon, authenticated;
revoke all on iq3_pillar_history from public, anon, authenticated;
revoke all on iq3_self_ratings   from public, anon, authenticated;
revoke all on iq3_feedback       from public, anon, authenticated;
revoke all on iq3_cohort_stats   from public, anon, authenticated;

grant select, insert, update, delete on iq3_user_state     to service_role;
grant select, insert, update, delete on iq3_pillar_history to service_role;
grant select, insert, update, delete on iq3_self_ratings   to service_role;
grant select, insert, update, delete on iq3_feedback       to service_role;
grant select, insert, update, delete on iq3_cohort_stats   to service_role;
