-- ============================================================================
-- Migration 1 of 2 (plan [G1]): database-first legacy shutdown.
-- fn_norma_claim_dispatch(uuid, integer default null) keeps its exact signature and grants but can
-- never claim a request again: it returns false and writes nothing. From this commit no legacy
-- execution can claim a request; every send goes through fn_norma_claim_dispatch_v2 +
-- fn_norma_mark_sending (migration 2). Rolling back to a legacy runtime is refused by the database
-- until a forward-recovery migration restores the claim.
-- TEMPORARY VERSION PREFIX: Root retimestamps this file.
-- ============================================================================
begin;

create or replace function public.fn_norma_claim_dispatch(p_request_id uuid, p_expected_attempt integer default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  return false;
end;
$$;
revoke all on function public.fn_norma_claim_dispatch(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_norma_claim_dispatch(uuid, integer) to service_role;

commit;
