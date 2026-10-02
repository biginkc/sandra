-- ============================================================================
-- Migration: norma_create_request_serialize
-- Created: 2026-10-02
-- Purpose: found by the stress gate (button hammer). Simultaneous
-- fn_norma_create_request calls for one lead deadlocked: every caller took the
-- property row FOR SHARE, the winner's enrollment-pause step then needed that
-- row FOR NO KEY UPDATE (guard_locked_property_sequence_enrollment), and the
-- losers sat on the one-open-request unique index waiting for the winner. The
-- database killed victims, so a double click returned errors after a stall of
-- seconds. Callers for the same lead are now serialised with a transaction
-- advisory lock taken before any row lock, so the losers simply see the open
-- request and answer already_open. The one-open-request index still decides
-- correctness. Signature, grants and behaviour are otherwise unchanged.
-- Rollback: re-apply the previous fn_norma_create_request (20261002020000; no later migration redefined it before this one); no schema objects are added here.
-- ============================================================================

begin;

create or replace function public.fn_norma_create_request(
  p_property_id uuid,
  p_contact_id uuid,
  p_phone_e164 text,
  p_requested_by uuid,
  p_rep_context text,
  p_callback_assignee_id uuid
)
returns table (outcome text, request_id uuid, idempotency_key uuid, block_reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_ok boolean;
  v_reason text;
  v_id uuid;
  v_key uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- One creator per lead at a time. Without this, simultaneous requests all
  -- took the property FOR SHARE lock below, and the winner's pause step (which
  -- needs the same row FOR NO KEY UPDATE through the enrollment guard trigger)
  -- then deadlocked against the losers waiting on the one-open-request index.
  -- Waiters now queue here holding no row lock, then find the open request.
  perform pg_advisory_xact_lock(hashtextextended('norma_create_request:' || p_property_id::text, 0));

  -- Hold off concurrent DNC / disposition writers while we decide.
  select p.org_id into v_org
    from public.properties p
   where p.id = p_property_id and p.deleted_at is null
     for share;
  if v_org is null then
    return query select 'blocked'::text, null::uuid, null::uuid, 'property_not_found'::text;
    return;
  end if;

  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_requested_by and m.org_id = v_org
       and m.access_status = 'active' and m.deletion_prepared_at is null
       and (m.access_expires_at is null or m.access_expires_at > now())
  ) then
    return query select 'blocked'::text, null::uuid, null::uuid, 'requester_not_member'::text;
    return;
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_callback_assignee_id and m.org_id = v_org
       and m.access_status = 'active' and m.deletion_prepared_at is null
       and (m.access_expires_at is null or m.access_expires_at > now())
  ) then
    return query select 'blocked'::text, null::uuid, null::uuid, 'assignee_not_member'::text;
    return;
  end if;

  select el.eligible, el.block_reason into v_ok, v_reason
    from public.fn_norma_eligibility(p_property_id, p_contact_id, p_phone_e164) el;
  if not coalesce(v_ok, false) then
    return query select 'blocked'::text, null::uuid, null::uuid, coalesce(v_reason, 'eligibility_check_failed');
    return;
  end if;

  begin
    insert into public.norma_call_requests
      (org_id, property_id, contact_id, phone_e164, requested_by, rep_context, callback_assignee_id)
    values
      (v_org, p_property_id, p_contact_id, p_phone_e164, p_requested_by,
       left(nullif(btrim(p_rep_context), ''), 2000), p_callback_assignee_id)
    returning id, norma_call_requests.idempotency_key into v_id, v_key;
  exception when unique_violation then
    select r.id into v_id
      from public.norma_call_requests r
     where r.property_id = p_property_id
       and r.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review');
    return query select 'already_open'::text, v_id, null::uuid, null::text;
    return;
  end;

  perform public.fn_norma_pause_for_request(v_id);

  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
  values (v_org, p_property_id, 'user', p_requested_by, 'norma_call_requested',
          jsonb_build_object('request_id', v_id, 'phone_e164', p_phone_e164,
                             'has_context', nullif(btrim(p_rep_context), '') is not null),
          'norma_call_requests.requested', v_id)
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return query select 'created'::text, v_id, v_key, null::text;
end;
$$;

revoke all on function public.fn_norma_create_request(uuid, uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.fn_norma_create_request(uuid, uuid, text, uuid, text, uuid) to service_role;

commit;
