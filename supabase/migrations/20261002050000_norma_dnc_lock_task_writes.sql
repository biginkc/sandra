-- ============================================================================
-- Migration: norma_dnc_lock_task_writes
-- Created: 2026-10-02
-- Purpose: found by the stress gate. A do-not-contact lock makes tasks on the
-- lead read-only (tasks_reject_dnc_locked_contact raises DNC_LOCKED). If a lock
-- landed while a Norma call was in flight, completing the call (callback,
-- reached, wrong number) and escalating an unresolved one to needs_review both
-- raised, so the webhook answered 500 forever and the request never settled.
-- The call result is still recorded and the request still settles; only the
-- task writes are skipped on a locked lead (nobody should call it back).
-- Re-creates fn_norma_complete_call, fn_norma_mark_needs_review and
-- fn_norma_mark_dispatch_rejected; signatures, grants and every other
-- behaviour are unchanged. Service-role only.
-- ============================================================================

begin;

create or replace function public.fn_norma_complete_call(
  p_request_id uuid,
  p_call_id text,
  p_outcome text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_payload jsonb := case when jsonb_typeof(p_payload) = 'object' then p_payload else '{}'::jsonb end;
  v_summary text := left(nullif(btrim(v_payload ->> 'summary'), ''), 4000);
  v_qual jsonb := case when jsonb_typeof(v_payload -> 'qualification') = 'object'
                       then v_payload -> 'qualification' else '{}'::jsonb end;
  v_cb_raw text := left(nullif(btrim(v_payload ->> 'callback_raw'), ''), 1000);
  v_cb_tz text := left(nullif(btrim(v_payload ->> 'callback_timezone'), ''), 100);
  v_cb_at timestamptz;
  v_prop record;
  v_task_key text;
  v_task_id uuid;
  v_task_type text;
  v_task_title text;
  v_task_due timestamptz;
  v_task_desc text;
  v_dispo_before text;
  v_dispo_target text;
  v_dispo_changed boolean := false;
  v_converted integer := 0;
  v_gap integer := 0;
  v_gap_seqs uuid[] := '{}'::uuid[];
  v_released integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in (
       'no_answer', 'callback_requested', 'reached_no_callback',
       'not_interested', 'wrong_number', 'unknown') then
    raise exception 'invalid norma outcome' using errcode = '22023';
  end if;
  if p_call_id is null or btrim(p_call_id) = '' then
    return jsonb_build_object('result', 'call_id_required');
  end if;

  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if r.bland_call_id is not null and r.bland_call_id <> p_call_id then
    return jsonb_build_object('result', 'call_id_mismatch', 'status', r.status);
  end if;
  if r.status = 'completed' then
    return jsonb_build_object('result', 'replayed', 'status', 'completed', 'outcome', r.outcome);
  end if;
  if r.status not in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return jsonb_build_object('result', 'invalid_state', 'status', r.status);
  end if;

  begin
    v_cb_at := (v_payload ->> 'callback_requested_for')::timestamptz;
  exception when others then
    v_cb_at := null;
  end;

  v_task_key := 'norma_call:' || r.id::text;

  -- ---- unknown: park for a human, keep every hold ------------------------
  if p_outcome = 'unknown' then
    if r.status = 'needs_review' and r.outcome = 'unknown' then
      return jsonb_build_object('result', 'replayed', 'status', 'needs_review', 'outcome', 'unknown');
    end if;
    begin
      update public.norma_call_requests
         set bland_call_id = p_call_id, outcome = 'unknown',
             qualification = v_qual, summary = coalesce(v_summary, summary),
             dispatched_at = coalesce(dispatched_at, now())
       where id = r.id;
    exception when unique_violation then
      return jsonb_build_object('result', 'call_id_conflict', 'status', r.status);
    end;
    perform public.fn_norma_mark_needs_review(r.id, 'Bland result did not map to a known outcome');
    return jsonb_build_object('result', 'applied', 'status', 'needs_review', 'outcome', 'unknown');
  end if;

  -- ---- known outcome ------------------------------------------------------
  begin
    update public.norma_call_requests
       set status = 'completed', completed_at = now(), outcome = p_outcome,
           bland_call_id = p_call_id,
           callback_requested_for = case when p_outcome = 'callback_requested' then v_cb_at end,
           callback_timezone = case when p_outcome = 'callback_requested' then v_cb_tz end,
           callback_raw = case when p_outcome = 'callback_requested' then v_cb_raw end,
           qualification = v_qual, summary = v_summary,
           dispatched_at = coalesce(dispatched_at, now())
     where id = r.id;
  exception when unique_violation then
    return jsonb_build_object('result', 'call_id_conflict', 'status', r.status);
  end;

  select pr.is_dnc_locked, pr.outreach_dispo, pr.homeowner_contact_id
    into v_prop from public.properties pr where pr.id = r.property_id;

  -- Disposition writes. Never touch a DNC-locked lead or downgrade a stronger
  -- terminal disposition.
  -- (wrong_number deliberately writes no property disposition: only that phone
  -- number is wrong, not the lead.)
  if p_outcome = 'not_interested' and not coalesce(v_prop.is_dnc_locked, true) then
    v_dispo_target := p_outcome;
    v_dispo_before := v_prop.outreach_dispo;
    update public.properties pr
       set outreach_dispo = v_dispo_target, follow_up_at = null, updated_at = now()
     where pr.id = r.property_id
       and not pr.is_dnc_locked
       and (pr.outreach_dispo is null
            or pr.outreach_dispo <> all (array['dnc', 'opted_out', 'bad_number', 'wrong_number']))
       and not exists (
         select 1 from public.contacts c
          where c.id = pr.homeowner_contact_id and c.do_not_contact);
    v_dispo_changed := found;
    if v_dispo_changed and v_dispo_before is distinct from v_dispo_target then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
      values (r.org_id, r.property_id, 'system', 'dispo_set',
              jsonb_build_object('from', v_dispo_before, 'to', v_dispo_target,
                                 'trigger', 'norma_call', 'request_id', r.id,
                                 'phone_e164', r.phone_e164),
              'norma_call_requests.dispo', r.id)
      on conflict (source_type, source_id) where source_id is not null do nothing;
    end if;
  end if;

  -- Pause handling (the request is no longer open, so the hold is gone).
  if p_outcome = 'no_answer' then
    v_released := public.fn_norma_release_pauses(r.id);
  elsif not coalesce(v_prop.is_dnc_locked, true) then
    -- Outcomes that keep the drip paused: a softphone pause that was not ours
    -- is converted so it cannot resume later.
    update public.sequence_enrollments e
       set pause_reason = 'norma_call', updated_at = now()
     where e.property_id = r.property_id and e.status = 'paused'
       and e.pause_reason = 'call_in_progress';
    get diagnostics v_converted = row_count;
    -- A drip created in the check-then-write gap (enrol after the request
    -- opened) must not run later either.
    with gap as (
      update public.sequence_enrollments e
         set status = 'paused', pause_reason = 'norma_call', updated_at = now()
       where e.property_id = r.property_id and e.status = 'active'
      returning e.id, e.sequence_id
    )
    select count(*)::integer, coalesce(array_agg(distinct gap.sequence_id), '{}'::uuid[])
      into v_gap, v_gap_seqs
      from gap;
    -- Same "sequence paused" timeline event the request-time pause writes.
    if v_gap > 0 then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
      values (r.org_id, r.property_id, 'system', 'sequence_paused',
              jsonb_build_object('count', v_gap, 'sequence_ids', to_jsonb(v_gap_seqs),
                                 'reason', 'norma_call', 'permanent', false));
    end if;
  end if;

  -- Task: exactly one per request, only for outcomes that need one.
  if p_outcome in ('callback_requested', 'reached_no_callback', 'wrong_number') then
    if p_outcome = 'callback_requested' then
      v_task_type := 'callback';
      v_task_title := 'Call back seller (requested via Norma, time unconfirmed)';
      v_task_due := coalesce(v_cb_at, now());
      v_task_desc := concat_ws(E'\n',
        case when v_cb_raw is not null then 'Seller said: ' || v_cb_raw end,
        case when v_cb_tz is not null then 'Timezone: ' || v_cb_tz end,
        v_summary);
    elsif p_outcome = 'reached_no_callback' then
      v_task_type := 'callback';
      v_task_title := 'Call back seller (Norma reached them, no callback time given)';
      v_task_due := now();
      v_task_desc := v_summary;
    else
      v_task_type := 'custom';
      v_task_title := 'Norma dialled a wrong number: check the contact phones';
      v_task_due := now();
      v_task_desc := concat_ws(E'\n', 'Number dialled: ' || r.phone_e164, v_summary);
    end if;

    -- A do-not-contact lead's tasks are read-only, and a callback to it is not
    -- wanted: the call result is still recorded, only the task is skipped.
    begin
      insert into public.tasks
        (org_id, assignee_id, related_property_id, contact_id, type, title, due_at, created_by,
         description, source_key)
      values
        (r.org_id, r.callback_assignee_id, r.property_id, r.contact_id, v_task_type, v_task_title,
         v_task_due, coalesce(r.requested_by, r.callback_assignee_id), v_task_desc, v_task_key)
      on conflict (org_id, source_key) where source_key is not null do update
         set type = excluded.type, title = excluded.title, due_at = excluded.due_at,
             description = excluded.description, updated_at = now(),
             -- A human may already have closed the review task. The real outcome
             -- still needs follow-up, so it is reopened. Replays never reach here
             -- (a completed request returns early).
             status = 'open', snoozed_until = null, completed_at = null, completed_by = null
      returning id into v_task_id;
    exception when others then
      if sqlerrm not like 'DNC_LOCKED%' then raise; end if;
      v_task_id := null;
    end;
    if v_task_id is not null then
      insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
      values (r.org_id, r.property_id, 'system', 'task_created',
              jsonb_build_object('task_id', v_task_id, 'task_type', v_task_type, 'due_at', v_task_due,
                                 'assignee_id', r.callback_assignee_id),
              'tasks.created', v_task_id)
      on conflict (source_type, source_id) where source_id is not null do nothing;
    end if;
  else
    -- No task wanted: close a review task a prior escalation may have opened.
    begin
      update public.tasks
         set status = 'cancelled', updated_at = now()
       where org_id = r.org_id and source_key = v_task_key and status in ('open', 'snoozed');
    exception when others then
      if sqlerrm not like 'DNC_LOCKED%' then raise; end if;
    end;
  end if;

  insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
  values (r.org_id, r.property_id, 'system', 'norma_call_completed',
          jsonb_build_object('request_id', r.id, 'outcome', p_outcome, 'call_id', p_call_id,
                             'phone_e164', r.phone_e164, 'summary', v_summary,
                             'callback_requested_for', v_cb_at,
                             'drip_resumed', v_released > 0),
          'norma_call_requests.completed', r.id)
  on conflict (source_type, source_id) where source_id is not null do nothing;

  insert into public.norma_notifications (request_id, kind)
  values (r.id, 'call_completed')
  on conflict (request_id, kind) do nothing;

  return jsonb_build_object('result', 'applied', 'status', 'completed', 'outcome', p_outcome,
                            'task_id', v_task_id, 'released', v_released, 'converted', v_converted);
end;
$$;

create or replace function public.fn_norma_mark_needs_review(p_request_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_task uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'not_found'; end if;
  if r.status not in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return r.status;
  end if;
  if r.status <> 'needs_review' then
    update public.norma_call_requests
       set status = 'needs_review', dispatch_error = coalesce(left(p_reason, 1000), dispatch_error)
     where id = r.id;
  end if;
  -- A do-not-contact lead is read-only (tasks_reject_dnc_locked_contact), and
  -- nobody should be asked to ring it back anyway. The escalation still
  -- happens; only the review task is skipped. The handler also covers a lock
  -- that lands between this statement and the commit.
  begin
    insert into public.tasks
      (org_id, assignee_id, related_property_id, contact_id, type, title, due_at, created_by, description, source_key)
    values
      (r.org_id, r.callback_assignee_id, r.property_id, r.contact_id, 'custom',
       'Norma call needs review: outcome unknown', now(), coalesce(r.requested_by, r.callback_assignee_id),
       'Norma may have called this seller but Sandra could not confirm the result. Check Bland and the lead before calling again.',
       'norma_call:' || r.id::text)
    on conflict (org_id, source_key) where source_key is not null do nothing
    returning id into v_task;
  exception when others then
    if sqlerrm not like 'DNC_LOCKED%' then raise; end if;
    v_task := null;
  end;
  if v_task is not null then
    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (r.org_id, r.property_id, 'system', 'task_created',
            jsonb_build_object('task_id', v_task, 'task_type', 'custom', 'due_at', now(),
                               'assignee_id', r.callback_assignee_id),
            'tasks.created', v_task)
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;
  return 'needs_review';
end;
$$;

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
  -- A do-not-contact lead's tasks are read-only; leave the review task as is.
  begin
    update public.tasks
       set status = 'cancelled', updated_at = now()
     where org_id = r.org_id and source_key = 'norma_call:' || r.id::text
       and status in ('open', 'snoozed');
  exception when others then
    if sqlerrm not like 'DNC_LOCKED%' then raise; end if;
  end;
  perform public.fn_norma_release_pauses(r.id);
  return 'dispatch_rejected';
end;
$$;

revoke all on function public.fn_norma_complete_call(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fn_norma_mark_needs_review(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_mark_dispatch_rejected(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_norma_complete_call(uuid, text, text, jsonb) to service_role;
grant execute on function public.fn_norma_mark_needs_review(uuid, text) to service_role;
grant execute on function public.fn_norma_mark_dispatch_rejected(uuid, text, text) to service_role;

commit;
