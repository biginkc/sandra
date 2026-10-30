-- Rollback for 20261030180000_routing_v2_dealmachine_value_cache.
-- Drops the PR-E cache, spend ledger / rate limiter and their functions. Losing the cache only means the
-- next price check re-asks DealMachine; the ledger is accounting only (export it first if
-- the spend history must be kept).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists public.fn_dealmachine_value_claim(uuid, uuid, integer);
drop function if exists public.fn_dealmachine_value_settle(uuid, uuid, text, numeric, integer, text, integer);
drop function if exists public.fn_provider_attempt_start(text, uuid, uuid, integer);
drop function if exists public.fn_provider_attempt_settle(uuid, integer, numeric);
drop table if exists public.dealmachine_value_cache;
drop table if exists public.provider_spend_ledger;

commit;
