-- Rollback for 20261030330000. Delivered / cancelled outbox rows keep their status; the added
-- columns are dropped only when no row carries a receipt or an unknown outcome.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.routing_v2_outbox where provider_receipt is not null or delivery_state is not null) then
    raise exception 'routing v2 outbox delivery evidence exists; refusing rollback';
  end if;
end $$;
drop function if exists public.routing_v2_alert_delivery_gate(uuid,text);
drop function if exists public.routing_v2_due_outbox_replies(integer,uuid);
drop function if exists public.routing_v2_reconcile_outbox(integer);
drop function if exists public.routing_v2_release_stale_outbox_claims(integer);
drop function if exists public.routing_v2_mark_outbox_unknown(uuid,text);
drop function if exists public.routing_v2_mark_outbox_not_sent(uuid,text);
drop function if exists public.routing_v2_mark_outbox_sent(uuid,text);
drop index if exists public.routing_v2_outbox_due_idx;
alter table public.routing_v2_outbox drop constraint if exists routing_v2_outbox_delivery_state_check;
alter table public.routing_v2_outbox drop column if exists delivery_note, drop column if exists delivery_state, drop column if exists provider_receipt;
commit;
