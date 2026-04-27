-- ==========================================================
-- Protege Supabase Seed — creates all tables, views, indexes,
-- and RPC functions needed by the backend.
--
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL).
-- Safe to re-run — uses IF NOT EXISTS everywhere.
-- ==========================================================

-- ===== TABLES =====

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  github_id text unique not null,
  login text not null,
  email text,
  avatar_url text,
  longest_streak int default 0,
  save_days text[] default '{}',
  daily_iq jsonb default '[]',
  velocity_log jsonb default '[]',
  pillar_snapshots jsonb default '[]',
  unlocked_milestones text[] default '{}',
  unlocked_milestone_at jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists concepts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  concept_name text not null,
  times_used int default 1,
  distinct_files text[] default '{}',
  quality_flags int default 0,
  best_context_score float default 1.0,
  first_seen_at timestamptz default now(),
  last_used_at timestamptz default now(),
  unique(user_id, concept_name)
);

create table if not exists gains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  concept text not null,
  cluster text not null,
  delta_iq float not null,
  file text,
  kind text default 'concept',
  created_at timestamptz default now()
);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  type text not null check (type in ('fact', 'skill', 'preference', 'struggle', 'session')),
  content text not null,
  created_at timestamptz default now()
);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  message_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

-- ===== INDEXES =====

create index if not exists idx_concepts_user on concepts(user_id);
create index if not exists idx_concepts_name on concepts(user_id, concept_name);
create index if not exists idx_gains_user on gains(user_id);
create index if not exists idx_gains_created on gains(user_id, created_at desc);
create index if not exists idx_memories_user on memories(user_id);
create index if not exists idx_chat_user on chat_messages(user_id, created_at desc);
create index if not exists idx_users_github on users(github_id);

-- ===== VIEWS =====

create or replace view leaderboard as
  select
    u.login,
    u.avatar_url,
    count(c.id)::int as total_concepts,
    u.longest_streak
  from users u
  left join concepts c on c.user_id = u.id
  group by u.id
  order by count(c.id) desc;

-- ===== RPC FUNCTIONS =====

-- Count users with fewer concepts than a given target (for percentile calc)
create or replace function count_users_with_fewer_concepts(target_count int)
returns int
language sql
stable
as $$
  select count(*)::int
  from (
    select user_id, count(*) as cnt
    from concepts
    group by user_id
    having count(*) < target_count
  ) sub;
$$;

-- Get a user's total concept count (helper for leaderboard)
create or replace function get_user_concept_count(uid uuid)
returns int
language sql
stable
as $$
  select count(*)::int from concepts where user_id = uid;
$$;

-- ===== ROW LEVEL SECURITY =====

-- Enable RLS on all tables
alter table users enable row level security;
alter table concepts enable row level security;
alter table gains enable row level security;
alter table memories enable row level security;
alter table chat_messages enable row level security;

-- Service role (used by the backend) can do everything. The `to service_role`
-- clause is what actually gates this — without it, the policy applies to the
-- default `public` role and any anon-key caller satisfies it via PostgREST.
-- If you add anon/authenticated access later, add more restrictive policies
-- keyed on `auth.uid()` with `to authenticated`.

drop policy if exists "service_role_users" on users;
create policy "service_role_users" on users for all to service_role using (true) with check (true);

drop policy if exists "service_role_concepts" on concepts;
create policy "service_role_concepts" on concepts for all to service_role using (true) with check (true);

drop policy if exists "service_role_gains" on gains;
create policy "service_role_gains" on gains for all to service_role using (true) with check (true);

drop policy if exists "service_role_memories" on memories;
create policy "service_role_memories" on memories for all to service_role using (true) with check (true);

drop policy if exists "service_role_chat" on chat_messages;
create policy "service_role_chat" on chat_messages for all to service_role using (true) with check (true);

-- ===== TRIGGER: auto-update updated_at =====

create or replace function update_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_updated_at on users;
create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

-- ===== DONE =====
-- Paste your Supabase URL + service key into apps/backend/.env:
--
--   SUPABASE_URL=https://YOUR-PROJECT.supabase.co
--   SUPABASE_SERVICE_KEY=eyJhbGciOi...
--
-- Then restart the backend. It auto-detects and connects.
