-- ============================================================================
-- Rollback of 20261008150100_norma_call_queue (plan [G1]; run as a new forward migration).
-- Returns the database to its pre-queue catalog:
--   * restores, byte-for-byte from their pre-queue source migrations, the shared functions the queue
--     migration replaced: norma_call_requests_guard, fn_norma_bind_call_id, fn_norma_complete_call,
--     fn_norma_eligibility, fn_norma_mark_needs_review, fn_norma_mark_reviewed (all from
--     20261008090100_norma_retry_next_step_union_reviewed.sql) and merge_duplicate_properties
--     (from 20261008135000_norma_inbound_call_records.sql);
--   * drops every queue object in dependency order (triggers, functions, link columns, tables);
--   * re-asserts the norma_private grants from 20261008135000 (schema USAGE and EXECUTE on
--     can_access_callbacks / associate_inbound_call for authenticated). The queue migration no longer
--     strips them; the grant lines at the end only restate 135000's state.
-- It does NOT restore fn_norma_claim_dispatch: 20261008150000 (legacy claim disable) is a separate
-- migration; apply rollbacks/20261008150000_norma_legacy_claim_disable.sql AFTER this file if the
-- legacy runtime must dial again.
-- DESTRUCTIVE: queue-only data this rollback deletes:
--   * the norma_queue_* tables (entries, attempts, digests, control), including the
--     norma_followup_reassignments history and the norma_state_timezones table;
--   * the send_attempted_at column on norma_call_requests, including the values on button-initiated rows.
-- Refuses to run while the queue is enabled or any queue-linked request is still in flight.
-- Idempotent: if the queue objects are already gone (norma_queue_control absent), it raises a NOTICE
-- and exits cleanly without changing anything.
-- Nothing here dials anyone or sends anything.
-- ============================================================================
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';
lock table public.norma_call_requests in access exclusive mode;

do $$
begin
  if to_regclass('public.norma_queue_control') is null then
    -- Idempotent re-run: the queue objects are already gone. Everything below is create-or-replace /
    -- drop-if-exists / grant, so it converges to the same catalog without touching data.
    raise notice 'NORMA_ROLLBACK: norma_queue_control does not exist; queue already rolled back, nothing to guard';
    return;
  end if;
  if exists (select 1 from public.norma_queue_control where enabled) then
    raise exception 'NORMA_ROLLBACK: norma_queue_control.enabled is true; disable the queue first' using errcode = '55000';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'norma_call_requests' and column_name = 'queue_entry_id'
  ) and exists (
    select 1 from public.norma_call_requests
     where queue_entry_id is not null
       and status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown')
  ) then
    raise exception 'NORMA_ROLLBACK: queue-linked requests are still in flight; let them settle first' using errcode = '55000';
  end if;
end $$;

-- 1. Queue triggers on shared tables (the functions they call are dropped in step 3).
drop trigger if exists zz_norma_queue_park_reply on public.messages;
drop trigger if exists zz_norma_queue_block_property on public.properties;
drop trigger if exists zz_norma_queue_block_contact on public.contacts;
drop trigger if exists zz_norma_queue_block_consent on public.consent_events;

-- 2. Restore the pre-queue definitions (CREATE OR REPLACE keeps owner and existing ACLs; ACLs re-asserted below).
create or replace function public.norma_call_requests_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_retry boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'NORMA_TRANSITION: a request must be inserted as requested'
        using errcode = '23514';
    end if;
    if new.attempt <> 1 or new.first_bland_call_id is not null or new.first_attempt_outcome is not null then
      raise exception 'NORMA_TRANSITION: a request must start at attempt 1'
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

  -- The one backwards edge: attempt 1 confirmed not answered, retry scheduled.
  v_retry := coalesce(old.attempt = 1 and new.attempt = 2
         and old.status in ('dispatching', 'dispatched') and new.status = 'requested'
         and new.first_attempt_outcome = 'no_answer'
         and new.first_bland_call_id is not null
         and (old.bland_call_id is null or old.bland_call_id = new.first_bland_call_id)
         and new.bland_call_id is null, false);

  -- Enforce the same operator decision at the row transition, so direct
  -- service-role DML or another writer cannot bypass completion admission.
  if v_retry and not coalesce((select enabled from public.norma_retry_admission
                              where singleton = true for share), false) then
    raise exception 'NORMA_RETRY_DISABLED: operator admission is OFF'
      using errcode = '42501';
  end if;

  if new.attempt is distinct from old.attempt and not v_retry then
    raise exception 'NORMA_TRANSITION: attempt can only move 1 -> 2 when scheduling the retry'
      using errcode = '23514';
  end if;
  if old.first_bland_call_id is not null
     and (new.first_bland_call_id is distinct from old.first_bland_call_id
          or new.first_attempt_outcome is distinct from old.first_attempt_outcome) then
    raise exception 'NORMA_IMMUTABLE: first attempt record cannot change'
      using errcode = '23514';
  end if;
  if not v_retry and old.first_bland_call_id is null
     and (new.first_bland_call_id is not null or new.first_attempt_outcome is not null) then
    raise exception 'NORMA_IMMUTABLE: first attempt is recorded only by scheduling the retry'
      using errcode = '23514';
  end if;

  if old.bland_call_id is not null and new.bland_call_id is distinct from old.bland_call_id and not v_retry then
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
      or v_retry
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

create or replace function public.fn_norma_bind_call_id(p_request_id uuid, p_call_id text, p_expected_attempt integer default null)
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
  if p_call_id is null or btrim(p_call_id) = '' then
    return 'invalid_call_id';
  end if;
  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then return 'not_found'; end if;
  if r.status = 'completed' then return 'already_completed'; end if;
  if r.first_bland_call_id is not null and r.first_bland_call_id = p_call_id then
    return 'already_completed';
  end if;
  if p_expected_attempt is not null and r.attempt <> p_expected_attempt then
    return 'stale_attempt';
  end if;
  if p_expected_attempt is null and r.attempt <> 1 then
    return 'already_completed';
  end if;
  if r.status in ('requested', 'dispatch_rejected') then return 'invalid_state'; end if;
  if r.bland_call_id is not null and r.bland_call_id <> p_call_id then
    return 'call_id_conflict';
  end if;
  begin
    update public.norma_call_requests
       set bland_call_id = p_call_id,
           status = case when status in ('dispatching', 'dispatch_unknown') then 'dispatched' else status end,
           dispatched_at = coalesce(dispatched_at, now())
     where id = r.id;
  exception when unique_violation or check_violation then
    return 'call_id_conflict';
  end;
  return 'bound';
end;
$$;

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
  -- The FIRST call of a request that was already retried: its result was
  -- applied when the retry was scheduled. A webhook replay or a reconciliation
  -- lookup for it is a no-op, never a mismatch and never a second retry.
  if r.first_bland_call_id is not null and r.first_bland_call_id = p_call_id then
    return jsonb_build_object('result', 'replayed', 'status', r.status, 'outcome', r.outcome);
  end if;
  -- Only the CURRENT attempt may complete or advance the request. Both calls
  -- share request_id + idempotency_key, so the call echoes its attempt number in
  -- the metadata (carried here as payload.attempt). While the current attempt has
  -- no bound call id yet (between scheduling and bind) any id would otherwise be
  -- accepted, including a stale or forged attempt-1 one: a result for another
  -- attempt is a no-op.
  -- Attempt metadata is required once the request has been retried. A legacy
  -- completion without metadata remains valid for attempt 1 only; it cannot
  -- settle the current attempt 2 call by omission.
  if not (v_payload ? 'attempt' and (v_payload ->> 'attempt') ~ '^[0-9]+$')
     and r.attempt <> 1 then
    return jsonb_build_object('result', 'stale_attempt', 'status', r.status);
  end if;
  if v_payload ? 'attempt' and (v_payload ->> 'attempt') not in ('1', '2') then
    return jsonb_build_object('result', 'stale_attempt', 'status', r.status);
  end if;
  if v_payload ? 'attempt'
     and coalesce(case when (v_payload ->> 'attempt') ~ '^[0-9]+$' then (v_payload ->> 'attempt')::integer end, 0) <> r.attempt then
    return jsonb_build_object('result', 'stale_attempt', 'status', r.status);
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

  -- ---- call twice: the first call was confirmed a non-connect ---------------
  -- Exactly once per request: only an explicitly identified attempt 1, only from an in-flight status
  -- (a late result on dispatch_unknown / needs_review is applied as a plain
  -- no_answer, never retried), and the same row-locked transaction moves the
  -- request to attempt 2, so a replay or a concurrent sweep finds attempt = 2.
  -- The request goes back to `requested`, which is an OPEN status: the hold,
  -- the drip pauses and the one-open-request fence all stay in force, and the
  -- caller then runs the ordinary dispatchNormaCall (gate + dial-time recheck).
  -- Nothing is released and no task/disposition/notification is written yet.
  if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')
     and (v_payload ->> 'attempt') = '1'
     -- Lock the admission row through the scheduling commit. An operator's OFF
     -- commit waits for admitted schedulers; later callers see OFF (or abort
     -- under an older repeatable-read snapshot), never a cached runtime flag.
     and coalesce((select enabled from public.norma_retry_admission
                   where singleton = true for share), false) then
    begin
      update public.norma_call_requests
         set status = 'requested', attempt = 2,
             first_bland_call_id = p_call_id, first_attempt_outcome = 'no_answer',
             first_attempt_at = now(), bland_call_id = null,
             dispatch_started_at = null, dispatched_at = null, next_check_at = now()
       where id = r.id;
    exception when unique_violation then
      return jsonb_build_object('result', 'call_id_conflict', 'status', r.status);
    end;
    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (r.org_id, r.property_id, 'system', 'norma_call_attempt_no_answer',
            jsonb_build_object('request_id', r.id, 'attempt', 1, 'call_id', p_call_id,
                               'phone_e164', r.phone_e164),
            'norma_call_requests.attempt1', r.id)
    on conflict (source_type, source_id) where source_id is not null do nothing;
    return jsonb_build_object('result', 'applied', 'status', 'requested', 'outcome', 'no_answer',
                              'retry', true);
  end if;

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
    perform public.fn_norma_mark_needs_review(r.id, 'Bland result did not map to a known outcome', r.attempt);
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
                             'drip_resumed', v_released > 0, 'attempts', r.attempt),
          'norma_call_requests.completed', r.id)
  on conflict (source_type, source_id) where source_id is not null do nothing;

  insert into public.norma_notifications (request_id, kind)
  values (r.id, 'call_completed')
  on conflict (request_id, kind) do nothing;

  return jsonb_build_object('result', 'applied', 'status', 'completed', 'outcome', p_outcome,
                            'task_id', v_task_id, 'released', v_released, 'converted', v_converted);
end;
$$;

create or replace function public.fn_norma_eligibility(
  p_property_id uuid,
  p_contact_id uuid,
  p_phone_e164 text
)
returns table (eligible boolean, block_reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prop record;
  v_contact record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_property_id is null or p_contact_id is null
     or p_phone_e164 is null or p_phone_e164 !~ '^\+1[2-9][0-9]{9}$' then
    eligible := false; block_reason := 'invalid_request';
    return next; return;
  end if;

  select p.org_id, p.homeowner_contact_id, p.is_dnc_locked, p.outreach_dispo,
         p.is_training, p.deleted_at
    into v_prop
    from public.properties p
   where p.id = p_property_id;
  if not found or v_prop.deleted_at is not null then
    eligible := false; block_reason := 'property_not_found';
    return next; return;
  end if;

  if v_prop.is_training or public.is_training_target(p_property_id, p_contact_id, p_phone_e164) then
    eligible := false; block_reason := 'training_lead';
    return next; return;
  end if;

  if v_prop.is_dnc_locked or v_prop.outreach_dispo = 'dnc' then
    eligible := false; block_reason := 'dnc_locked';
    return next; return;
  end if;

  if v_prop.homeowner_contact_id is distinct from p_contact_id then
    eligible := false; block_reason := 'contact_not_on_property';
    return next; return;
  end if;

  select c.org_id, c.do_not_contact, c.sms_opted_out, c.phone_1, c.phone_2, c.phone_3
    into v_contact
    from public.contacts c
   where c.id = p_contact_id;
  if not found or v_contact.org_id is distinct from v_prop.org_id then
    eligible := false; block_reason := 'contact_not_on_property';
    return next; return;
  end if;
  if v_contact.do_not_contact then
    eligible := false; block_reason := 'dnc_contact';
    return next; return;
  end if;
  -- STOP: a seller who opted out by text (contact flag, durable phone
  -- suppression, or the opted_out disposition) must not be called next either.
  if coalesce(v_contact.sms_opted_out, false) or v_prop.outreach_dispo = 'opted_out' then
    eligible := false; block_reason := 'sms_opted_out';
    return next; return;
  end if;
  -- contacts.phone_1..3 have no format constraint. CSV import writes +1XXXXXXXXXX
  -- (normalizePhone) but other writers may store "(816) 555-0142". Normalise a
  -- stored slot to +1XXXXXXXXXX only when it has exactly 10 digits, or 11
  -- starting with 1 (the same rule as normalizePhone); any other slot is
  -- ignored. The dialled number must equal a normalised slot in full, so a
  -- non-US number can never match a US-looking contact number.
  if not exists (
    select 1
      from unnest(array[v_contact.phone_1, v_contact.phone_2, v_contact.phone_3]) as t(ph),
           lateral (select regexp_replace(coalesce(ph, ''), '\D', '', 'g') as d) x
     where case
             -- A slot written with a leading "+" is an international number
             -- unless it is exactly +1 and ten digits: "+44 12 3456 7890" must
             -- never be read as a US number.
             when btrim(coalesce(ph, '')) like '+%'
                  and not (length(x.d) = 11 and x.d like '1%') then null
             when length(x.d) = 10 then '+1' || x.d
             when length(x.d) = 11 and x.d like '1%' then '+' || x.d
             else null
           end = p_phone_e164
  ) then
    eligible := false; block_reason := 'phone_not_on_contact';
    return next; return;
  end if;

  -- evaluateSuppression queries nothing; the registry must be read directly.
  if exists (
    select 1 from public.global_phone_dnc_registry g
     where g.org_id = v_prop.org_id and g.phone_e164 = p_phone_e164
  ) then
    eligible := false; block_reason := 'global_dnc_registry';
    return next; return;
  end if;

  if exists (
    select 1 from public.sms_phone_suppressions s
     where s.org_id = v_prop.org_id and s.channel = 'sms' and s.phone_e164 = p_phone_e164
  ) then
    eligible := false; block_reason := 'sms_phone_suppressed';
    return next; return;
  end if;

  -- A number Norma already reached as wrong is never dialled again. (Sandra has
  -- no per-number wrong-number flag on main; this is the only record of it.)
  if exists (
    select 1 from public.norma_call_requests w
     where w.org_id = v_prop.org_id and w.phone_e164 = p_phone_e164
       and w.status = 'completed' and w.outcome = 'wrong_number'
  ) then
    eligible := false; block_reason := 'wrong_number_flagged';
    return next; return;
  end if;

  if v_prop.outreach_dispo = 'not_interested' then
    eligible := false; block_reason := 'not_interested';
    return next; return;
  end if;

  eligible := true; block_reason := null;
  return next; return;
exception
  when insufficient_privilege then
    raise;
  when others then
    eligible := false; block_reason := 'eligibility_check_failed';
    return next; return;
end;
$$;

create or replace function public.fn_norma_mark_needs_review(p_request_id uuid, p_reason text, p_expected_attempt integer default null)
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
  if p_expected_attempt is not null and r.attempt <> p_expected_attempt then return r.status; end if;
  if p_expected_attempt is null and r.attempt <> 1 then return r.status; end if;
  if r.status not in ('dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return r.status;
  end if;
  if r.status <> 'needs_review' then
    update public.norma_call_requests
       set status = 'needs_review', dispatch_error = coalesce(left(p_reason, 1000), dispatch_error)
     where id = r.id;
  end if;
  perform public.fn_norma_lock_lead(r.property_id, r.contact_id);
  -- A do-not-contact lead is read-only (tasks_reject_dnc_locked_contact), and
  -- nobody should be asked to ring it back anyway. The escalation still
  -- happens; only the review task is skipped. The handler also covers a lock
  -- that lands between this statement and the commit.
  -- Same contract as before: an existing task for this request is left exactly as it is (a
  -- review task a human already closed is not reopened by a repeated escalation).
  if not exists (select 1 from public.tasks t where t.org_id = r.org_id and t.source_key = 'norma_call:' || r.id::text) then
    begin
      v_task := (public.fn_create_next_step(
        p_org := r.org_id,
        p_actor := coalesce((select m.user_id from public.memberships m
                              where m.user_id = r.requested_by and m.org_id = r.org_id
                                and m.access_status = 'active' and m.deletion_prepared_at is null
                                and (m.access_expires_at is null or m.access_expires_at > now())),
                            r.callback_assignee_id),
        p_assignee := r.callback_assignee_id,
        p_kind := 'task', p_title := 'Norma call needs review: outcome unknown', p_due_at := now(),
        p_property := r.property_id, p_contact := r.contact_id,
        p_description := 'Norma may have called this seller but Sandra could not confirm the result. Check Bland and the lead before calling again.',
        p_source_key := 'norma_call:' || r.id::text, p_origin := 'norma') ->> 'task_id')::uuid;
    exception when others then
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
      v_task := null;
    end;
  end if;
  return 'needs_review';
end;
$$;

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

create or replace function public.merge_duplicate_properties(
  keeper_id uuid,
  loser_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_keeper_org_id uuid;
  v_loser_org_id uuid;
begin
  select property.org_id into v_keeper_org_id
  from public.properties property where property.id = keeper_id;
  select property.org_id into v_loser_org_id
  from public.properties property where property.id = loser_id;
  if v_keeper_org_id is null or v_loser_org_id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found'
      using errcode = 'P0002';
  end if;
  if v_keeper_org_id <> v_loser_org_id
     or not public.hugo_has_active_org_access(v_keeper_org_id) then
    raise exception 'merge_duplicate_properties: active access required'
      using errcode = '42501';
  end if;

  -- Deterministic locking makes a concurrent save either complete before the
  -- merge or fail cleanly before the loser is removed.
  perform 1
  from public.properties property
  where property.id in (keeper_id, loser_id)
  order by property.id
  for update;

  update public.norma_inbound_calls set property_id=keeper_id,updated_at=now()
    where property_id=loser_id and org_id=v_keeper_org_id;
  update public.norma_inbound_reviews set property_id=keeper_id
    where property_id=loser_id and org_id=v_keeper_org_id;

  update public.lead_events
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.ai_disposition_reviews
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.esign_requests
  set property_id = keeper_id,
      updated_at = now()
  where property_id = loser_id and org_id = v_keeper_org_id;
  update public.lead_files
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  perform set_config('offer_calculations.merge_repoint', 'true', true);
  set constraints offer_calculations_parent_org_property_series_fkey deferred;
  update public.offer_calculations
  set property_id = keeper_id
  where property_id = loser_id and org_id = v_keeper_org_id;

  -- The trigger marker is transaction-local and only covers the repoint above.
  -- Clear it before invoking the private merge body so no later maintenance
  -- statement can accidentally inherit calculator write authority.
  perform set_config('offer_calculations.merge_repoint', '', true);

  perform public.merge_duplicate_properties_hugo_unchecked(keeper_id, loser_id);
end;
$$;

revoke all on function public.fn_norma_bind_call_id(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_norma_bind_call_id(uuid, text, integer) to service_role;
revoke all on function public.fn_norma_complete_call(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_norma_complete_call(uuid, text, text, jsonb) to service_role;
revoke all on function public.fn_norma_eligibility(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_norma_eligibility(uuid, uuid, text) to service_role;
revoke all on function public.fn_norma_mark_needs_review(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.fn_norma_mark_needs_review(uuid, text, integer) to service_role;
revoke all on function public.fn_norma_mark_reviewed(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_norma_mark_reviewed(uuid, uuid, uuid) to service_role;
revoke all on function public.merge_duplicate_properties(uuid, uuid) from public, anon, service_role;
grant execute on function public.merge_duplicate_properties(uuid, uuid) to authenticated;

-- 3. Drop queue functions (public wrappers first, then norma_private helpers).
drop function if exists public.fn_norma_claim_dispatch_v2(uuid,integer,timestamptz,boolean,integer,integer,text);
drop function if exists public.fn_norma_create_request_v2(uuid,uuid,text,uuid,text,uuid,uuid,uuid);
drop function if exists public.fn_norma_mark_sending(uuid,uuid,integer);
drop function if exists public.fn_norma_queue_apply_presend(uuid,text);
drop function if exists public.fn_norma_queue_block_reason(uuid);
drop function if exists public.fn_norma_queue_cancel(uuid,uuid);
drop function if exists public.fn_norma_queue_claim(uuid,timestamptz,boolean,integer,integer,text);
drop function if exists public.fn_norma_queue_enqueue(uuid,uuid,uuid[],text);
drop function if exists public.fn_norma_queue_next_slot(uuid,timestamptz);
drop function if exists public.fn_norma_queue_next_slot_for(text,timestamptz[],timestamptz);
drop function if exists public.fn_norma_queue_pause(uuid,uuid);
drop function if exists public.fn_norma_queue_pause_unknown_state(uuid);
drop function if exists public.fn_norma_queue_release_expired_leases(timestamptz);
drop function if exists public.fn_norma_queue_resume(uuid,uuid,timestamptz);
drop function if exists public.fn_norma_queue_settle(uuid,text,text);
drop function if exists public.fn_norma_queue_sweep_blocks();
drop function if exists public.fn_norma_queue_sweep_replies();
drop function if exists norma_private.fn_norma_eligibility_core(uuid,uuid,text);
drop function if exists norma_private.fn_norma_followup_reassignment_upsert(uuid,uuid,uuid,uuid,text,jsonb);
drop function if exists norma_private.fn_norma_queue_settle_core(uuid,text,text);
drop function if exists norma_private.fn_norma_queue_apply_blocks(uuid,uuid);
drop function if exists norma_private.fn_norma_queue_attempt_upsert(uuid,text,text);
drop function if exists norma_private.fn_norma_queue_block_reason_core(uuid,uuid);
drop function if exists norma_private.fn_norma_queue_park_for_reply(uuid,timestamptz);
drop function if exists norma_private.fn_norma_queue_pick_phone(uuid,uuid);
drop function if exists norma_private.fn_norma_queue_reschedule(uuid,timestamptz);
drop function if exists norma_private.fn_norma_queue_trg_consent();
drop function if exists norma_private.fn_norma_queue_trg_contact();
drop function if exists norma_private.fn_norma_queue_trg_message();
drop function if exists norma_private.fn_norma_queue_trg_property();
drop function if exists norma_private.fn_norma_next_slot_core(text,timestamptz[],timestamptz);
drop function if exists norma_private.fn_norma_dial_counts(timestamptz,text,uuid);
drop function if exists norma_private.fn_norma_callable_phones(uuid);
drop function if exists norma_private.fn_norma_consent_opted_out(uuid,text);
drop function if exists norma_private.fn_norma_active_member(uuid,uuid);
drop function if exists norma_private.fn_norma_snap_open(text,timestamptz);
drop function if exists norma_private.fn_norma_window_open(text,timestamptz);
drop function if exists norma_private.fn_norma_zone_of_state(text);
drop function if exists norma_private.fn_norma_wallclock();

-- 4. Queue link on the request table, then the queue tables (children first). Dropping a table drops
-- its policies, indexes, constraints and its guard trigger; the guard function goes last.
drop index if exists public.norma_call_requests_queue_entry_idx;
alter table public.norma_call_requests
  drop column if exists queue_entry_id,
  drop column if exists queue_lease_token,
  drop column if exists queue_dispatch_token,
  drop column if exists send_attempted_at;
drop table if exists public.norma_followup_reassignments;
drop table if exists public.norma_queue_digests;
drop table if exists public.norma_queue_attempts;
drop table if exists public.norma_queue_entries;
drop table if exists public.norma_queue_control;
drop table if exists public.norma_state_timezones;
drop function if exists public.norma_queue_entries_guard();

-- 5. Re-assert the 20261008135000 grants (the queue migration no longer strips them; these just restate them).
-- (norma_private itself and its two inbound functions pre-date the queue and stay.)
revoke all on schema norma_private from public, anon;
grant usage on schema norma_private to authenticated;
revoke all on function norma_private.can_access_callbacks(uuid) from public, anon, service_role;
grant execute on function norma_private.can_access_callbacks(uuid) to authenticated;
revoke all on function norma_private.associate_inbound_call(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
grant execute on function norma_private.associate_inbound_call(uuid, uuid, timestamptz) to authenticated;

commit;
