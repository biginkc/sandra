-- Rollback for 20261030230000_routing_v2_outbox_delivery_recheck.sql (routing v2 PR-F).
-- Removes the takeover fence trigger, the delivery re-check function and the authorized_at
-- column. Outbox rows already cancelled by either stay cancelled (safe direction).
begin;
set local lock_timeout = '5s';
drop trigger if exists trg_routing_v2_takeover_fence on public.properties;
drop function if exists public.routing_v2_takeover_fence();
drop function if exists public.routing_v2_authorize_outbox_send(uuid);
alter table public.routing_v2_outbox drop column if exists authorized_at;
commit;
