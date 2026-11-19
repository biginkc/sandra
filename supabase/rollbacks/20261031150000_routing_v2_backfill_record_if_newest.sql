-- Rollback of 20261031150000: drops the backfill-only recorder (nothing else depends on it).
begin;
set local lock_timeout = '5s';
drop function if exists public.routing_v2_backfill_record_live_decision(jsonb, text);
commit;
