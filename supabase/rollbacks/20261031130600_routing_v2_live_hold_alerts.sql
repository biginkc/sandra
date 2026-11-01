-- Rollback for 20261031130600. Alerts-only rows already written stay (append-only evidence).
begin;
set local lock_timeout = '5s';
drop function if exists public.routing_v2_record_live_hold(uuid,uuid,jsonb);
commit;
