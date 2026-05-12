-- 006_chat_sessions.sql
-- Introduces per-conversation sessions for chat history.
-- Idempotent: safe to re-run.

create table if not exists chat_sessions (
  id              text primary key,
  user_id         text not null,
  title           text not null default 'New chat',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  message_count   integer not null default 0
);

create index if not exists idx_chat_sessions_user_last
  on chat_sessions (user_id, last_message_at desc);

-- 1. Add the column to chat_messages, nullable for now so backfill can run.
alter table chat_messages
  add column if not exists session_id text;

-- 2. Backfill: create a single `legacy-<user_id>` session per distinct
--    user_id in chat_messages, anchored to the earliest message and
--    advanced to the latest. Then point all NULL session_id rows at it.
insert into chat_sessions (id, user_id, title, created_at, updated_at, last_message_at, message_count)
select
  'legacy-' || user_id           as id,
  user_id,
  'Conversations before sessions' as title,
  min(created_at)                 as created_at,
  max(created_at)                 as updated_at,
  max(created_at)                 as last_message_at,
  count(*)                        as message_count
from chat_messages
where session_id is null
group by user_id
on conflict (id) do nothing;

update chat_messages
   set session_id = 'legacy-' || user_id
 where session_id is null;

-- 3. Now enforce NOT NULL + FK + index. Each step is guarded so this
--    file is safe to re-run.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'chat_messages'
      and column_name  = 'session_id'
      and is_nullable  = 'YES'
  ) then
    alter table chat_messages
      alter column session_id set not null;
  end if;
end$$;

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'chat_messages'
      and constraint_name = 'chat_messages_session_id_fkey'
  ) then
    alter table chat_messages
      add constraint chat_messages_session_id_fkey
      foreign key (session_id) references chat_sessions (id) on delete cascade;
  end if;
end$$;

create index if not exists idx_chat_messages_session_created
  on chat_messages (session_id, created_at);

-- 4. RLS lockdown — service_role only, same pattern as chat_messages.
alter table chat_sessions enable row level security;
revoke all on chat_sessions from public;
revoke all on chat_sessions from anon;
revoke all on chat_sessions from authenticated;
grant select, insert, update, delete on chat_sessions to service_role;

-- 5. Atomic session bump on new-message write. Increments count and slides
--    last_message_at / updated_at forward (never backward, in case of
--    out-of-order writes from offline-resync).
create or replace function bump_chat_session(
  p_session_id text,
  p_user_id    text,
  p_at         timestamptz
) returns void
language plpgsql
as $$
begin
  update chat_sessions
     set last_message_at = greatest(last_message_at, p_at),
         updated_at      = greatest(updated_at, p_at),
         message_count   = message_count + 1
   where id = p_session_id
     and user_id = p_user_id;
end;
$$;
