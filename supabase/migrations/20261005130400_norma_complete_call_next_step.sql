-- My Leads one-call close, P1a-writers (1a.9): fn_norma_complete_call creates its next step
-- through fn_create_next_step. Verbatim copy of the 20261002120500 body except the task block:
-- a callback outcome is now a phone appointment (kind 'appointment'), the wrong-number outcome a
-- task, both upserted by the request's source key; the manual task_created lead event is gone
-- (the shared function writes the identical identity, tasks.created / task id). A closed,
-- rescheduled or superseded keyed appointment is not reopened: the result becomes a fresh next
-- step under a deterministic key (request key + call id), so a repeat updates that row instead of adding another. Signature and grants unchanged (create or replace).
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
  -- Lock order (see fn_norma_lock_lead): request -> enrollments -> contact ->
  -- property. The disposition, pause and task writes below all end up on those
  -- rows, so they are all taken now: a do-not-contact lock (which takes contact
  -- then property) cannot land between a read and the write that depends on it,
  -- and no other path can hold one of them while waiting for another of ours.
  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
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
    -- The next step goes through fn_create_next_step: a callback is a phone appointment, the
    -- wrong-number case a task, both upserted by the request's source key (one row per request).
    -- The actor is the requester when still an active member, else the assignee (the shared
    -- function refuses an actor without an active membership; the old insert did not care).
    -- If the keyed appointment was closed, rescheduled or superseded the shared function
    -- refuses to reopen it; the result then becomes a fresh next step under a deterministic key (request key + call id), so a repeat updates that row instead of adding another.
    begin
      begin
        v_task_id := (public.fn_create_next_step(
          p_org := r.org_id,
          p_actor := coalesce((select m.user_id from public.memberships m
                                where m.user_id = r.requested_by and m.org_id = r.org_id
                                  and m.access_status = 'active' and m.deletion_prepared_at is null
                                  and (m.access_expires_at is null or m.access_expires_at > now())),
                              r.callback_assignee_id),
          p_assignee := r.callback_assignee_id,
          p_kind := case when v_task_type = 'custom' then 'task' else 'appointment' end,
          p_title := v_task_title, p_due_at := v_task_due,
          p_property := r.property_id, p_contact := r.contact_id,
          p_mode := 'phone', p_description := v_task_desc,
          p_source_key := v_task_key, p_origin := 'norma') ->> 'task_id')::uuid;
      exception when others then
        if not (sqlstate = 'P0001' and sqlerrm like '%was closed, rescheduled or superseded%') then raise; end if;
        v_task_id := (public.fn_create_next_step(
          p_org := r.org_id,
          p_actor := coalesce((select m.user_id from public.memberships m
                                where m.user_id = r.requested_by and m.org_id = r.org_id
                                  and m.access_status = 'active' and m.deletion_prepared_at is null
                                  and (m.access_expires_at is null or m.access_expires_at > now())),
                              r.callback_assignee_id),
          p_assignee := r.callback_assignee_id,
          p_kind := case when v_task_type = 'custom' then 'task' else 'appointment' end,
          p_title := v_task_title, p_due_at := v_task_due,
          p_property := r.property_id, p_contact := r.contact_id,
          p_mode := 'phone', p_description := v_task_desc,
          p_source_key := v_task_key || ':' || p_call_id,
          p_origin := 'norma') ->> 'task_id')::uuid;
      end;
    exception when others then
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
      v_task_id := null;
    end;
  else
    -- No task wanted: close a review task a prior escalation may have opened.
    begin
      update public.tasks
         set status = 'cancelled', updated_at = now()
       where org_id = r.org_id and source_key = v_task_key and status in ('open', 'snoozed');
    exception when others then
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
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

commit;
