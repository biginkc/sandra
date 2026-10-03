-- ============================================================================
-- Migration: norma_call_twice
-- Created: 2026-10-02
-- Purpose: "Have Norma call" places ONE retry when the first call is confirmed
-- not answered by a person (Sandra outcome no_answer), as part of the same rep
-- request. Smallest safe design: the retry is the SAME request row.
--
--   * norma_call_requests.attempt (1 or 2); first_bland_call_id and
--     first_attempt_outcome / first_attempt_at remember attempt 1. bland_call_id
--     always means the CURRENT call, so every existing reader (webhook
--     correlation, reconciliation lookup, call-id mismatch checks) is unchanged.
--     At most two Bland calls per request: bland_call_id + first_bland_call_id.
--   * fn_norma_complete_call: a confirmed no_answer on attempt 1 (from
--     dispatching / dispatched only) does NOT complete the request. In the same
--     row-locked transaction it records attempt 1, sets attempt = 2 and puts the
--     request back to `requested` (an open status: hold, drip pauses and the
--     one-open-request fence all stay). The caller then runs the ordinary
--     dispatchNormaCall, so the dispatch gate and the dial-time eligibility
--     recheck apply again. Because attempt can only go 1 -> 2 once, and a replay
--     of attempt 1's result is answered `replayed` by first_bland_call_id, the
--     retry can never be scheduled twice; the dispatch claim is atomic, so it
--     can never be dialled twice. Attempt 2 completes normally; its no_answer is
--     the one that releases the drip pauses.
--   * The guard trigger allows exactly that one backwards edge
--     (dispatching|dispatched -> requested with attempt 1 -> 2) and nothing else.
--     `completed` stays final; no other transition changes.
--   * fn_norma_bind_call_id: attempt 1's call id arriving after the retry was
--     scheduled (webhook beat the bind) is reported already_completed.
--   * precall_sms_status: what happened to the optional pre-call text (sent,
--     refused, failed), for the audit trail.
-- Service-role only, as before. Nothing here dials anyone or sends anything.
-- ============================================================================

begin;

alter table public.norma_call_requests
  add column if not exists attempt smallint not null default 1,
  add column if not exists first_bland_call_id text,
  add column if not exists first_attempt_outcome text,
  add column if not exists first_attempt_at timestamptz,
  add column if not exists precall_sms_status text;

alter table public.norma_call_requests
  drop constraint if exists norma_call_requests_attempt_check,
  add constraint norma_call_requests_attempt_check check (attempt in (1, 2)),
  drop constraint if exists norma_call_requests_first_attempt_check,
  add constraint norma_call_requests_first_attempt_check check (
    (attempt = 1 and first_bland_call_id is null and first_attempt_outcome is null)
    or (attempt = 2 and first_attempt_outcome = 'no_answer')
  ),
  drop constraint if exists norma_call_requests_distinct_calls_check,
  add constraint norma_call_requests_distinct_calls_check check (
    bland_call_id is null or first_bland_call_id is null or bland_call_id <> first_bland_call_id
  );

create unique index if not exists norma_call_requests_first_bland_call_id_key
  on public.norma_call_requests (first_bland_call_id)
  where first_bland_call_id is not null;

create or replace function public.norma_call_requests_guard()
returns trigger
language plpgsql
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
  v_retry := old.attempt = 1 and new.attempt = 2
         and old.status in ('dispatching', 'dispatched') and new.status = 'requested'
         and new.first_attempt_outcome = 'no_answer'
         and new.first_bland_call_id is not null
         and (old.bland_call_id is null or old.bland_call_id = new.first_bland_call_id)
         and new.bland_call_id is null;

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

-- Attempt 1's call id arriving after the retry was scheduled (the webhook beat
-- the bind) is not a conflict: attempt 1 is already recorded.
create or replace function public.fn_norma_bind_call_id(p_request_id uuid, p_call_id text)
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
  -- Exactly once per request: only attempt 1, only from an in-flight status
  -- (a late result on dispatch_unknown / needs_review is applied as a plain
  -- no_answer, never retried), and the same row-locked transaction moves the
  -- request to attempt 2, so a replay or a concurrent sweep finds attempt = 2.
  -- The request goes back to `requested`, which is an OPEN status: the hold,
  -- the drip pauses and the one-open-request fence all stay in force, and the
  -- caller then runs the ordinary dispatchNormaCall (gate + dial-time recheck).
  -- Nothing is released and no task/disposition/notification is written yet.
  if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched') then
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
      if not (sqlstate = 'P0001' and split_part(sqlerrm, ':', 1) = 'DNC_LOCKED') then raise; end if;
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

-- The dispatch claim is fenced on the attempt the dispatcher read: a worker
-- holding an old snapshot (attempt 1) cannot claim the retry (attempt 2) and
-- then act on stale facts (a second pre-call text, attempt:1 metadata).
drop function if exists public.fn_norma_claim_dispatch(uuid);
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
     and (p_expected_attempt is null or attempt = p_expected_attempt);
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;
revoke all on function public.fn_norma_claim_dispatch(uuid, integer) from public, anon, authenticated;
grant execute on function public.fn_norma_claim_dispatch(uuid, integer) to service_role;

-- STOP must prevent the next call: fn_norma_eligibility (and so the dial-time
-- recheck of both attempts) also refuses sms_opted_out, opted_out and a durable
-- sms_phone_suppressions row for the dialled number.
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

revoke all on function public.fn_norma_bind_call_id(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_complete_call(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_norma_bind_call_id(uuid, text) to service_role;
revoke all on function public.fn_norma_eligibility(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_norma_eligibility(uuid, uuid, text) to service_role;
grant execute on function public.fn_norma_complete_call(uuid, text, text, jsonb) to service_role;

commit;
