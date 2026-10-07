-- ============================================================================
-- Forward recovery for 20261008150000_norma_legacy_claim_disable (plan [G1] rollback).
-- Use ONLY if 20261008150100_norma_call_queue cannot land and the legacy runtime must dial again.
-- Restores public.fn_norma_claim_dispatch(uuid, integer default null) to its exact pre-queue
-- definition (copied byte-for-byte from 20261008090100_norma_retry_next_step_union_reviewed.sql
-- lines 617-638: body, SECURITY DEFINER, search_path, revoke/grant). Same signature, so it is a
-- plain CREATE OR REPLACE: owner is preserved and no dependency is touched. It writes no data.
-- Do NOT run this once 20261008150100 is applied; the queue assumes the legacy claim is disabled
-- (use 20261008150100_norma_call_queue.sql rollback first, then this file).
-- Forward-only: this is a new migration to ship, never a history edit.
-- ============================================================================
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refuse if the queue is installed: reviving the legacy claim next to the queue would double-dial.
do $$
begin
  if to_regclass('public.norma_queue_entries') is not null then
    raise exception 'NORMA_RECOVERY: queue objects present; roll back 20261008150100 first' using errcode = '55000';
  end if;
end $$;

create or replace function public.fn_norma_claim_dispatch(p_request_id uuid, p_expected_attempt integer default null)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.norma_call_requests
     set status = 'dispatching', dispatch_started_at = now()
   where id = p_request_id and status = 'requested'
     and ((p_expected_attempt is null and attempt = 1) or attempt = p_expected_attempt);
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;
revoke all on function public.fn_norma_claim_dispatch(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_norma_claim_dispatch(uuid, integer) to service_role;

commit;
