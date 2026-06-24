-- Thread-level current state for Sandra's SMS AI responder.
-- Forward-only: no historical backfill and no immutable run log in v1.

set lock_timeout = '5s';
set statement_timeout = '30s';

alter table public.message_threads
  add column if not exists ai_responder_status text,
  add column if not exists ai_responder_reason text,
  add column if not exists ai_responder_status_at timestamptz,
  add column if not exists ai_last_delivery_status text,
  add column if not exists ai_last_delivery_error text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'message_threads_ai_responder_status_check'
      and conrelid = 'public.message_threads'::regclass
  ) then
    alter table public.message_threads
      add constraint message_threads_ai_responder_status_check
      check (
        ai_responder_status is null
        or ai_responder_status in ('handled', 'escalated')
      ) not valid;
  end if;
end $$;

alter table public.message_threads
  validate constraint message_threads_ai_responder_status_check;

create index if not exists idx_message_threads_ai_responder_status
  on public.message_threads (ai_responder_status)
  where ai_responder_status is not null;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_threads'
  ) then
    execute 'alter publication supabase_realtime add table public.message_threads';
  end if;
end $$;
