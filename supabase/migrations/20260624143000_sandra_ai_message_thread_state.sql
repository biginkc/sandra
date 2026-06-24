-- Thread-level current state for Sandra's SMS AI responder.
-- Forward-only: no historical backfill and no immutable run log in v1.

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
      );
  end if;
end $$;

create index if not exists idx_message_threads_ai_responder_status
  on public.message_threads (ai_responder_status)
  where ai_responder_status is not null;
