-- 20261008143500_dead_letter_resolution.sql
-- Messages v2: durable resolution of send_timeout dead letters.
--
-- The late-send sweeper (stale-run cron) cannot persist a cursor, so pass A
-- restarted at the oldest send_timeout row every run, resolved rows included.
-- Resolution is now recorded IN THE ROW: reconcileLateSendForInbound stamps
-- resolved_at on the original send_timeout row when the sent_late marker is
-- written, and the sweeper reads only unresolved rows.
--
-- service_role gets UPDATE on resolved_at ONLY (column-level grant); the body,
-- reason and every other column stay immutable for it.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.ai_reply_dead_letters
  add column if not exists resolved_at timestamptz;
comment on column public.ai_reply_dead_letters.resolved_at is
  'Set when a send_timeout row has been reconciled (its sent_late marker exists). Null = still to be examined by the late-send sweeper.';

-- Backfill: timeouts that already have a sent_late marker are resolved.
update public.ai_reply_dead_letters t
set resolved_at = now()
where t.reason = 'send_timeout'
  and t.resolved_at is null
  and t.inbound_message_id is not null
  and exists (
    select 1 from public.ai_reply_dead_letters m
    where m.reason = 'sent_late' and m.inbound_message_id = t.inbound_message_id
  );

create index if not exists idx_ai_reply_dead_letters_unresolved_timeout
  on public.ai_reply_dead_letters (created_at, id)
  where reason = 'send_timeout' and resolved_at is null;

grant update (resolved_at) on table public.ai_reply_dead_letters to service_role;

commit;
