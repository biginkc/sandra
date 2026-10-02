-- ============================================================================
-- Migration: norma_m2_review_fixes
-- Created: 2026-10-02
-- Purpose: Milestone 2 review fixes.
--   * fn_norma_mark_dispatch_rejected gains an optional expected status so a
--     "close only if still requested" caller cannot reject a row that a
--     concurrent dispatcher already moved to dispatching.
--   * norma_call_requests.next_check_at: the reconciliation sweep orders and
--     filters by it so stuck rows cannot starve fresh ones. Changing only this
--     column does not touch updated_at (the idle clock).
-- Service-role only, as before.
-- ============================================================================

begin;

alter table public.norma_call_requests
  add column if not exists next_check_at timestamptz not null default now();

drop index if exists public.norma_call_requests_open_updated_idx;
create index if not exists norma_call_requests_open_check_idx
  on public.norma_call_requests (next_check_at)
  where status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review');

create or replace function public.norma_call_requests_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'NORMA_TRANSITION: a request must be inserted as requested'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.property_id is distinct from old.property_id
     or new.phone_e164 is distinct from old.phone_e164
     or new.idempotency_key is distinct from old.idempotency_key
     or new.created_at is distinct from old.created_at then
    raise exception 'NORMA_IMMUTABLE: request identity cannot change'
      using errcode = '23514';
  end if;

  if old.bland_call_id is not null and new.bland_call_id is distinct from old.bland_call_id then
    raise exception 'NORMA_IMMUTABLE: bland_call_id cannot be overwritten'
      using errcode = '23514';
  end if;

  if old.status = 'completed' then
    if new.status <> 'completed'
       or new.outcome is distinct from old.outcome
       or new.completed_at is distinct from old.completed_at then
      raise exception 'NORMA_TRANSITION: a completed request is final'
        using errcode = '23514';
    end if;
  elsif new.status is distinct from old.status then
    if not (
      (old.status = 'requested' and new.status in ('dispatching', 'dispatch_rejected'))
      or (old.status = 'dispatching' and new.status in
            ('dispatched', 'dispatch_rejected', 'dispatch_unknown', 'completed', 'needs_review'))
      or (old.status = 'dispatched' and new.status in ('completed', 'needs_review'))
      or (old.status = 'dispatch_unknown' and new.status in
            ('dispatched', 'dispatch_rejected', 'completed', 'needs_review'))
      or (old.status = 'needs_review' and new.status in ('completed', 'dispatch_rejected'))
    ) then
      raise exception 'NORMA_TRANSITION: % -> % is not allowed', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  -- A scheduling-only change (the reconciliation sweep pushing next_check_at
  -- out) must not look like activity: updated_at is the request's idle clock.
  if new.status is not distinct from old.status
     and new.next_check_at is distinct from old.next_check_at
     and (to_jsonb(new) - 'next_check_at' - 'updated_at') = (to_jsonb(old) - 'next_check_at' - 'updated_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;

  new.updated_at := now();
  return new;
end;
$$;


drop function if exists public.fn_norma_mark_dispatch_rejected(uuid, text);
create or replace function public.fn_norma_mark_dispatch_rejected(p_request_id uuid, p_reason text, p_expected_status text default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'not_found'; end if;
  -- Callers that mean "only if still requested" (closed gate, expiry) pass the
  -- status they expect; a row another worker already claimed is left alone.
  if p_expected_status is not null and r.status <> p_expected_status then
    return r.status;
  end if;
  if r.status = 'dispatch_rejected' then return 'dispatch_rejected'; end if;
  if r.status not in ('requested', 'dispatching', 'dispatch_unknown', 'needs_review')
     or r.bland_call_id is not null then
    return r.status;
  end if;
  update public.norma_call_requests
     set status = 'dispatch_rejected', dispatch_error = left(p_reason, 1000)
   where id = r.id;
  update public.tasks
     set status = 'cancelled', updated_at = now()
   where org_id = r.org_id and source_key = 'norma_call:' || r.id::text
     and status in ('open', 'snoozed');
  perform public.fn_norma_release_pauses(r.id);
  return 'dispatch_rejected';
end;
$$;

revoke all on function public.fn_norma_mark_dispatch_rejected(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_norma_mark_dispatch_rejected(uuid, text, text) to service_role;

commit;
