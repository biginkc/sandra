-- Routing v2 cutover (e), TODO (a): ONE SQL copy of the canary / test-group check.
-- routing_v2_canary_eligible (PR-C, 20261030181000) is the single implementation (the SQL
-- twin of flags.ts isV2Eligible). PR-I's fn_routing_v2_property_eligible (20261030210000) and
-- PR-G's routing_v2_phone_action_eligible (20261030250000) had byte-equivalent logic; both are
-- re-created, same signature and volatility, as one-line delegates, so every caller is
-- unchanged. The equivalence is DB-tested against the old bodies and TS isV2Eligible.
-- Not merged here: the two "properties on this phone" definitions (see the PR body).
-- Rollback: supabase/rollbacks/20261030350000_routing_v2_one_canary_check.sql (old bodies).
begin;
set local lock_timeout = '5s';

create or replace function public.fn_routing_v2_property_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.routing_v2_canary_eligible(p_flags, p_property_id);
$$;

create or replace function public.routing_v2_phone_action_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select public.routing_v2_canary_eligible(p_flags, p_property_id);
$$;

revoke all on function public.fn_routing_v2_property_eligible(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_property_eligible(jsonb, uuid) to service_role;
revoke all on function public.routing_v2_phone_action_eligible(jsonb, uuid) from public, anon, authenticated;
commit;
