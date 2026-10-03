-- ============================================================================
-- Migration: norma_mark_reviewed
-- Created: 2026-10-02
-- Purpose: a Norma call whose result is unclear parks in `needs_review`, which
-- is an OPEN status: it holds the lead's drip and fences every new request for
-- that lead, and nothing moved it out. The lead stayed stuck. This adds the
-- one human exit: a rep marks the call reviewed.
--
-- Design (smallest safe):
--   * needs_review -> completed, the transition the guard trigger already
--     allows. No guard / state-machine change.
--   * outcome 'reviewed' (new). `unknown` cannot be kept: the existing
--     norma_call_requests_completed_outcome_check forbids a completed request
--     with outcome unknown, and loosening it would make "completed" ambiguous
--     everywhere. 'reviewed' means "a person looked; Norma's own result is not
--     recorded". The webhook / reconcile path (fn_norma_complete_call) still
--     validates its own outcome list, so Bland can never produce 'reviewed'.
--     The reason the call was parked stays in dispatch_error; the original
--     outcome (unknown, or none) is in the lead event payload.
--   * reviewed_by / reviewed_at record who and when. Both are set together with
--     the outcome (check constraint), and only by this function.
--   * Same lock order as every other Norma function: request row -> enrollments
--     -> contact -> property (fn_norma_lock_lead).
--   * The open "needs review" task for the request is completed (completed_by =
--     the rep). On a do-not-contact lead the task guard raises DNC_LOCKED; that
--     is swallowed exactly as in fn_norma_complete_call / mark_needs_review, so
--     the request still completes and the task is left as it is.
--   * Drips stay PAUSED: nothing is resumed. The rep now owns the follow-up.
--     The request's own pause rows are marked released ('kept_paused_reviewed')
--     so fn_norma_release_pauses can never resume them later; softphone pauses
--     and drips created in the check-then-write gap are turned into norma_call
--     pauses, exactly as a completion with a non-no_answer outcome does.
--   * No Slack notification (nothing was learned from the call) and no dial:
--     this function touches no provider and calls no dispatch code.
--   * Authorisation: the caller passes the session user id; that user must be an
--     active member of the request's org. Any member may mark it. A replay
--     (request already reviewed) is a no-op that returns success.
--   * After this, the one-open-request index no longer covers the row, so a new
--     "Have Norma call" is allowed again, subject to normal eligibility.
-- Service-role only (the session-authenticated server action calls it with the
-- admin client), like every fn_norma_* RPC. Fails closed on any missing input.
-- Rollback: drop function public.fn_norma_mark_reviewed(uuid, uuid, uuid); then
-- (only once no request has outcome 'reviewed') restore the outcome check without
-- 'reviewed' and drop the two reviewed_* columns and the reviewed check.
-- ============================================================================

begin;

alter table public.norma_call_requests
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

alter table public.norma_call_requests
  drop constraint if exists norma_call_requests_outcome_check,
  add constraint norma_call_requests_outcome_check
    check (outcome is null or outcome in (
      'no_answer', 'callback_requested', 'reached_no_callback',
      'not_interested', 'wrong_number', 'unknown', 'reviewed'
    )),
  drop constraint if exists norma_call_requests_reviewed_check,
  add constraint norma_call_requests_reviewed_check
    check (coalesce(outcome = 'reviewed', false) = (reviewed_at is not null));

create or replace function public.fn_norma_mark_reviewed(
  p_request_id uuid,
  p_property_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_org uuid;
  v_prop_id uuid;
  v_locked boolean;
  v_prev_outcome text;
  v_task uuid;
  v_converted integer := 0;
  v_gap integer := 0;
  v_gap_seqs uuid[] := '{}'::uuid[];
  v_kept integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null or p_property_id is null or p_user_id is null then
    return jsonb_build_object('result', 'not_authorized');
  end if;

  -- Cheap unlocked read to authorise BEFORE taking any row lock, so a caller
  -- who is not allowed here cannot queue behind (or stall) a live request.
  select q.org_id, q.property_id into v_org, v_prop_id
    from public.norma_call_requests q where q.id = p_request_id;
  if v_org is null or v_prop_id is distinct from p_property_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id = p_user_id and m.org_id = v_org
       and m.access_status = 'active' and m.deletion_prepared_at is null
       and (m.access_expires_at is null or m.access_expires_at > now())
  ) then
    return jsonb_build_object('result', 'not_authorized');
  end if;

  -- Lock order (see fn_norma_lock_lead): request -> enrollments -> contact -> property.
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- A double click or a replay: already done, nothing to do, still a success.
  if r.status = 'completed' and r.outcome = 'reviewed' then
    return jsonb_build_object('result', 'already_reviewed', 'status', 'completed');
  end if;
  if r.status <> 'needs_review' then
    return jsonb_build_object('result', 'invalid_state', 'status', r.status);
  end if;

  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  select pr.is_dnc_locked into v_locked from public.properties pr where pr.id = r.property_id;
  v_prev_outcome := r.outcome;

  update public.norma_call_requests
     set status = 'completed', outcome = 'reviewed', completed_at = now(),
         reviewed_by = p_user_id, reviewed_at = now()
   where id = r.id;

  -- Disown the request's pauses: they stay paused, but nothing of Norma's may
  -- resume them later. The rep owns the follow-up.
  update public.norma_enrollment_pauses
     set released_at = now(), release_result = 'kept_paused_reviewed'
   where request_id = r.id and released_at is null;

  if not coalesce(v_locked, true) then
    -- Same conversions as a completion that keeps the drip paused: a softphone
    -- pause that was not ours must not resume by itself, and a drip created in
    -- the check-then-write gap must not run.
    update public.sequence_enrollments e
       set pause_reason = 'norma_call', updated_at = now()
     where e.property_id = r.property_id and e.status = 'paused'
       and e.pause_reason = 'call_in_progress';
    get diagnostics v_converted = row_count;
    with gap as (
      update public.sequence_enrollments e
         set status = 'paused', pause_reason = 'norma_call', updated_at = now()
       where e.property_id = r.property_id and e.status = 'active'
      returning e.id, e.sequence_id
    )
    select count(*)::integer, coalesce(array_agg(distinct gap.sequence_id), '{}'::uuid[])
      into v_gap, v_gap_seqs
      from gap;
    if v_gap > 0 then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
      values (r.org_id, r.property_id, 'system', 'sequence_paused',
              jsonb_build_object('count', v_gap, 'sequence_ids', to_jsonb(v_gap_seqs),
                                 'reason', 'norma_call', 'permanent', false));
    end if;
  end if;
  select count(*)::integer into v_kept
    from public.sequence_enrollments e
   where e.property_id = r.property_id and e.status = 'paused' and e.pause_reason = 'norma_call';

  -- Close the open review task. A do-not-contact lead's tasks are read-only: the
  -- guard raises DNC_LOCKED, the review still lands and the task is left as is.
  begin
    update public.tasks
       set status = 'completed', completed_at = now(), completed_by = p_user_id, updated_at = now()
     where org_id = r.org_id and source_key = 'norma_call:' || r.id::text
       and status in ('open', 'snoozed')
    returning id into v_task;
  exception when others then
    if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
    v_task := null;
  end;

  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
  values (r.org_id, r.property_id, 'user', p_user_id, 'norma_call_reviewed',
          jsonb_build_object('request_id', r.id, 'previous_outcome', v_prev_outcome,
                             'task_closed', v_task is not null, 'drips_kept_paused', v_kept),
          'norma_call_requests.reviewed', r.id)
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object('result', 'reviewed', 'status', 'completed',
                            'task_closed', v_task is not null, 'drips_kept_paused', v_kept);
end;
$$;

revoke all on function public.fn_norma_mark_reviewed(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_norma_mark_reviewed(uuid, uuid, uuid) to service_role;

commit;
