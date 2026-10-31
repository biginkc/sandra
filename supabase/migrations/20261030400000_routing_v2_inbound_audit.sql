-- Routing v2 stress review (AUDIT): exactly one v2 audit row per inbound on a v2-live property.
-- An inbound that never reached the v2 engine (webhook keyword exit, a pre-gate skip, a held
-- lead) gets one routing_v2_live_decisions row with status 'not_routed' and the reason, written
-- after the live path finished. It is evidence only: every reader acts on status 'decided'.
-- Additive. Rollback: supabase/rollbacks/20261030400000_routing_v2_inbound_audit.sql
begin;
set local lock_timeout = '5s';
alter table public.routing_v2_live_decisions drop constraint if exists routing_v2_live_decisions_status_check;
alter table public.routing_v2_live_decisions add constraint routing_v2_live_decisions_status_check
  check (status in ('decided', 'failed', 'not_routed'));
commit;
