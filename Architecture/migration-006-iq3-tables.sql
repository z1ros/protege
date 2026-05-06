-- migration-006-iq3-tables.sql
-- Code IQ v3 storage. All tables prefixed iq3_*. Additive on echo schema.

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

-- Materialized cohort percentiles per (field, headline). Rebuilt nightly.
create table if not exists iq3_cohort_stats (
  field            text not null,
  -- Bucketed headline (rounded to nearest 25); cumulative percentile within field
  headline_bucket  integer not null,
  percentile       numeric(5,2) not null,
  computed_at      timestamptz not null default now(),
  primary key (field, headline_bucket)
);

-- Optional row-level security: enable later when auth lands.
-- alter table iq3_user_state     enable row level security;
-- alter table iq3_pillar_history enable row level security;
-- alter table iq3_self_ratings   enable row level security;
