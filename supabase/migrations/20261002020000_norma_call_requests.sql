-- ============================================================================
-- Migration: norma_call_requests
-- Created: 2026-10-02
-- Purpose: Data layer for "Have Norma call" (.planning/norma/PLAN.md, slice 1,
-- milestone 1). Database only: no Bland client, no routes, no UI.
--
--   * norma_call_requests      one row per requested call, with a monotonic
--                              status machine enforced by a trigger.
--   * norma_enrollment_pauses  the drip enrollments a request itself paused.
--   * norma_notifications      Slack outbox (drained by a later worker).
--   * tasks.source_key         lets a Norma task be created at most once.
--   * fn_norma_* functions     eligibility, hold, pause/release, completion
--                              and the dispatch claim/transition helpers.
--   * resume_sequence_enrollment gains an expected-pause-reason argument and
--     refuses to resume while a Norma hold is open ([G2], [I1]).
--   * fn_norma_upgrade_pauses_for_reply ([H1]) and
--     sweep_resume_call_in_progress (stale-call sweep, hold aware).
--
-- Every function is service-role only. Nothing here dials anyone.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. tasks.source_key — one Norma task per request ([F3])
-- ----------------------------------------------------------------------------
alter table public.tasks add column if not exists source_key text;

create unique index if not exists idx_tasks_org_source_key
  on public.tasks (org_id, source_key)
  where source_key is not null;

-- ----------------------------------------------------------------------------
-- 2. norma_call_requests
-- ----------------------------------------------------------------------------
create table if not exists public.norma_call_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  contact_id uuid,
  phone_e164 text not null,
  requested_by uuid references auth.users(id) on delete set null,
  rep_context text,
  callback_assignee_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'requested',
  idempotency_key uuid not null default gen_random_uuid(),
  bland_call_id text,
  outcome text,
  callback_requested_for timestamptz,
  callback_timezone text,
  callback_raw text,
  qualification jsonb not null default '{}'::jsonb,
  summary text,
  dispatch_error text,
  dispatch_started_at timestamptz,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint norma_call_requests_phone_check
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint norma_call_requests_status_check
    check (status in (
      'requested', 'dispatching', 'dispatched', 'completed',
      'dispatch_rejected', 'dispatch_unknown', 'needs_review'
    )),
  constraint norma_call_requests_outcome_check
    check (outcome is null or outcome in (
      'no_answer', 'callback_requested', 'reached_no_callback',
      'not_interested', 'wrong_number', 'unknown'
    )),
  -- A completed request always carries a real (non-unknown) outcome.
  constraint norma_call_requests_completed_outcome_check
    check (status <> 'completed' or (outcome is not null and outcome <> 'unknown')),
  constraint norma_call_requests_completed_at_check
    check ((status = 'completed') = (completed_at is not null)),
  constraint norma_call_requests_idempotency_key_key unique (idempotency_key),
  constraint norma_call_requests_bland_call_id_key unique (bland_call_id),
  constraint norma_call_requests_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id) on delete cascade,
  constraint norma_call_requests_contact_org_fkey
    foreign key (contact_id, org_id)
    references public.contacts(id, org_id) on delete set null (contact_id)
);

-- At most one open request per lead. Uncertain attempts keep blocking a redial
-- until a human or reconciliation resolves them ([F2][F6]). Slice 2 adds
-- 'scheduled' to this list.
create unique index if not exists norma_call_requests_one_open_per_property_idx
  on public.norma_call_requests (property_id)
  where status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review');

create index if not exists norma_call_requests_org_property_idx
  on public.norma_call_requests (org_id, property_id, created_at desc);

-- Reconciliation sweep scan (open rows by age).
create index if not exists norma_call_requests_open_updated_idx
  on public.norma_call_requests (status, updated_at)
  where status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review');

-- Monotonic transitions, enforced in SQL ([F2][F3]). No transition may leave
-- `completed`; `dispatch_rejected` is terminal too.
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

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists norma_call_requests_guard on public.norma_call_requests;
create trigger norma_call_requests_guard
  before insert or update on public.norma_call_requests
  for each row execute function public.norma_call_requests_guard();

-- ----------------------------------------------------------------------------
-- 3. norma_enrollment_pauses — the enrollments a request paused itself ([F4])
-- ----------------------------------------------------------------------------
create table if not exists public.norma_enrollment_pauses (
  request_id uuid not null references public.norma_call_requests(id) on delete cascade,
  enrollment_id uuid not null references public.sequence_enrollments(id) on delete cascade,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  release_result text,
  primary key (request_id, enrollment_id)
);

create index if not exists norma_enrollment_pauses_enrollment_idx
  on public.norma_enrollment_pauses (enrollment_id);

-- ----------------------------------------------------------------------------
-- 4. norma_notifications — Slack outbox ([F8])
-- ----------------------------------------------------------------------------
create table if not exists public.norma_notifications (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.norma_call_requests(id) on delete cascade,
  kind text not null default 'call_completed' check (kind in ('call_completed')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  slack_ts text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint norma_notifications_request_kind_key unique (request_id, kind)
);

create index if not exists norma_notifications_due_idx
  on public.norma_notifications (next_attempt_at)
  where status = 'pending';

-- ----------------------------------------------------------------------------
-- 5. RLS / grants. Authenticated members may read requests (the lead page
-- shows in-flight state). Everything else is service-role only.
-- ----------------------------------------------------------------------------
alter table public.norma_call_requests enable row level security;
alter table public.norma_enrollment_pauses enable row level security;
alter table public.norma_notifications enable row level security;

drop policy if exists norma_call_requests_org_select on public.norma_call_requests;
create policy norma_call_requests_org_select on public.norma_call_requests
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke all on public.norma_call_requests from public, anon, authenticated;
revoke all on public.norma_enrollment_pauses from public, anon, authenticated;
revoke all on public.norma_notifications from public, anon, authenticated;
grant select on public.norma_call_requests to authenticated;
grant select, insert, update, delete on public.norma_call_requests to service_role;
grant select, insert, update, delete on public.norma_enrollment_pauses to service_role;
grant select, insert, update, delete on public.norma_notifications to service_role;

-- ----------------------------------------------------------------------------
-- 6. Hold + eligibility
-- ----------------------------------------------------------------------------

-- An open request is itself a hold on the property's enrollments, whatever
-- their pause_reason ([G2]). Used by every resume path.
create or replace function public.fn_norma_hold_active(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.norma_call_requests r
     where r.property_id = p_property_id
       and r.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review')
  );
$$;

-- Hard blocks only: do-not-contact (lead lock, contact flag, global phone
-- registry for the exact number) and `not_interested`. Plus structural checks
-- (the contact belongs to the property and owns the number). Any error fails
-- closed.
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

  select c.org_id, c.do_not_contact, c.phone_1, c.phone_2, c.phone_3
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

-- ----------------------------------------------------------------------------
-- 7. Pause / release
-- ----------------------------------------------------------------------------

-- Pause the property's live enrollments with `norma_call` and remember the
-- ones this request paused itself. Locks every live enrollment first so a
-- concurrent softphone cleanup / sweep either finished already (and is paused
-- here) or sees the hold when it takes the same lock.
create or replace function public.fn_norma_pause_for_request(p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  v_locked boolean;
  v_ids uuid[];
  v_seq_ids uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null or r.status not in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    return 0;
  end if;

  select p.is_dnc_locked into v_locked from public.properties p where p.id = r.property_id;
  if coalesce(v_locked, true) then
    return 0;
  end if;

  perform 1
    from public.sequence_enrollments e
   where e.property_id = r.property_id and e.status in ('active', 'paused')
   order by e.id
     for update;

  with paused as (
    update public.sequence_enrollments e
       set status = 'paused', pause_reason = 'norma_call', updated_at = now()
     where e.property_id = r.property_id and e.status = 'active'
    returning e.id, e.sequence_id
  ), ins as (
    insert into public.norma_enrollment_pauses (request_id, enrollment_id)
    select r.id, paused.id from paused
    on conflict do nothing
    returning enrollment_id
  )
  select coalesce(array_agg(paused.id), '{}'::uuid[]),
         coalesce(array_agg(distinct paused.sequence_id), '{}'::uuid[])
    into v_ids, v_seq_ids
    from paused;

  if cardinality(v_ids) > 0 then
    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
    values (r.org_id, r.property_id, 'system', 'sequence_paused',
            jsonb_build_object('count', cardinality(v_ids), 'sequence_ids', to_jsonb(v_seq_ids),
                               'reason', 'norma_call', 'permanent', false));
  end if;
  return cardinality(v_ids);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7b. resume_sequence_enrollment — expected pause reason ([I1]) + Norma hold
-- ([G2]). Both checks run under the enrollment lock and BEFORE any claim
-- retirement or activation.
-- ----------------------------------------------------------------------------
drop function if exists public.resume_sequence_enrollment(uuid, uuid);

create or replace function public.resume_sequence_enrollment(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null,
  p_expected_pause_reason text default null
)
returns table (outcome text, next_run_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  next_at timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  if e.id is null then
    return query select 'not_found', null::timestamptz;
    return;
  end if;
  if (coalesce(auth.role(), '') = 'service_role' and p_actor_user_id is not null)
     or (coalesce(auth.role(), '') <> 'service_role' and (
       auth.uid() is null
       or (p_actor_user_id is not null and p_actor_user_id <> auth.uid())
       or not exists (
         select 1 from public.memberships m
          where m.org_id = e.org_id and m.user_id = auth.uid()
       )
     )) then
    return query select 'not_authorized', null::timestamptz;
    return;
  end if;
  if e.status <> 'paused' then
    return query select 'not_paused', e.next_run_at;
    return;
  end if;
  -- [I1] The caller decided to resume based on a read of the pause reason. A
  -- reply, takeover or Norma conversion may have changed it since.
  if p_expected_pause_reason is not null
     and e.pause_reason is distinct from p_expected_pause_reason then
    return query select 'pause_reason_changed', e.next_run_at;
    return;
  end if;
  -- [G2] An open Norma request holds every enrollment on the property.
  if public.fn_norma_hold_active(e.property_id) then
    return query select 'norma_hold', e.next_run_at;
    return;
  end if;
  if coalesce(e.pause_reason, '') in ('reconciliation_required', 'provider_failed') then
    return query select 'retry_required', e.next_run_at;
    return;
  end if;

  select * into s from public.sequence_steps
   where sequence_id = e.sequence_id and step_index = e.current_step_index;
  if s.id is not null then
    select * into r from public.sequence_step_runs
     where enrollment_id = e.id and step_id = s.id and claim_active
     order by created_at desc limit 1
     for update;
    if r.id is not null then
      if r.attempt_outcome not in ('not_attempted', 'definitively_rejected') then
        return query select 'reconciliation_required', e.next_run_at;
        return;
      end if;
      update public.sequence_step_runs
         set claim_active = false,
             recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid()),
             recovery_action = 'resume',
             recovery_evidence = 'paused enrollment resumed with a proven no-attempt claim'
       where id = r.id and claim_active;
    end if;
    next_at := now() + make_interval(mins => s.delay_after_previous_minutes);
  else
    next_at := now();
  end if;

  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = next_at, updated_at = now()
   where id = e.id and status = 'paused';
  return query select 'resumed', next_at;
end;
$$;

revoke all on function public.resume_sequence_enrollment(uuid, uuid, text) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid, text) to authenticated, service_role;

-- Release the pauses this request itself made. Safe to call more than once.
-- Only call after the request has left the open states (the resume RPC
-- refuses while the hold is active). An enrollment whose reason changed in the
-- meantime (reply, takeover, terminal, DNC) is left alone.
create or replace function public.fn_norma_release_pauses(p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.norma_call_requests%rowtype;
  p record;
  e public.sequence_enrollments%rowtype;
  v_prop record;
  v_contact record;
  v_outcome text;
  v_result text;
  v_resumed integer := 0;
  v_seq_ids uuid[] := '{}'::uuid[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select * into r from public.norma_call_requests where id = p_request_id for update;
  if r.id is null then
    return 0;
  end if;
  if r.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown', 'needs_review') then
    -- The hold is still open: nothing may resume.
    return 0;
  end if;

  for p in
    select np.enrollment_id
      from public.norma_enrollment_pauses np
     where np.request_id = r.id and np.released_at is null
     order by np.enrollment_id
  loop
    select * into e from public.sequence_enrollments where id = p.enrollment_id for update;
    v_result := null;
    if e.id is null then
      v_result := 'enrollment_gone';
    elsif e.status <> 'paused' or e.pause_reason is distinct from 'norma_call' then
      v_result := 'reason_changed';
    else
      select pr.is_dnc_locked, pr.outreach_dispo, pr.status, pr.homeowner_contact_id
        into v_prop from public.properties pr where pr.id = e.property_id;
      select c.do_not_contact, c.sms_opted_out into v_contact
        from public.contacts c where c.id = v_prop.homeowner_contact_id;
      if coalesce(v_prop.is_dnc_locked, true)
         or v_prop.outreach_dispo in ('wrong_number', 'bad_number', 'dnc', 'opted_out',
                                      'not_interested', 'nurture', 'callback_requested', 'booked_appointment')
         or v_prop.status in ('dead', 'closed', 'offer_sent', 'under_contract')
         or coalesce(v_contact.do_not_contact, false)
         or coalesce(v_contact.sms_opted_out, false) then
        v_result := 'not_eligible';
      else
        select rs.outcome into v_outcome
          from public.resume_sequence_enrollment(e.id, null, 'norma_call') rs;
        v_result := v_outcome;
        if v_outcome = 'resumed' then
          v_resumed := v_resumed + 1;
          v_seq_ids := v_seq_ids || e.sequence_id;
        end if;
      end if;
    end if;
    update public.norma_enrollment_pauses
       set released_at = now(), release_result = v_result
     where request_id = r.id and enrollment_id = p.enrollment_id;
  end loop;

  if v_resumed > 0 then
    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (r.org_id, r.property_id, 'system', 'sequence_resumed',
            jsonb_build_object('count', v_resumed, 'sequence_ids', to_jsonb(v_seq_ids),
                               'reason', 'norma_call_ended'),
            'norma_call_requests.released', r.id)
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;
  return v_resumed;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. Request creation (atomic: eligibility + insert + pause)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 9. Dispatch claim / transition helpers
-- ----------------------------------------------------------------------------

-- requested -> dispatching. Single conditional update; losers get false.
create or replace function public.fn_norma_claim_dispatch(p_request_id uuid)
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
   where id = p_request_id and status = 'requested';
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;

-- Bind the Bland call id. Never overwrites a completed request or a different
-- id. dispatching / dispatch_unknown move to dispatched; needs_review keeps its
-- status (a human still owns it) but records the id.
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
  exception when unique_violation then
    return 'call_id_conflict';
  end;
  return 'bound';
end;
$$;

-- Bland explicitly rejected the call (or confirms none exists). Releases the
-- pauses this request owned. Never applies once a call is bound/completed.
create or replace function public.fn_norma_mark_dispatch_rejected(p_request_id uuid, p_reason text)
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

-- The send-call outcome is unknown (timeout / 5xx / id write failed). Pauses
-- stay; the request keeps blocking a redial. Does not regress a request the
-- webhook already moved on.
create or replace function public.fn_norma_mark_dispatch_unknown(p_request_id uuid, p_reason text)
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
  if r.status <> 'dispatching' then return r.status; end if;
  update public.norma_call_requests
     set status = 'dispatch_unknown', dispatch_error = left(p_reason, 1000)
   where id = r.id;
  return 'dispatch_unknown';
end;
$$;

-- Escalate an unresolved request to a human: status needs_review plus one
-- review task (unique source_key). Pauses stay, redial stays blocked.
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
  insert into public.tasks
    (org_id, assignee_id, related_property_id, contact_id, type, title, due_at, created_by, description, source_key)
  values
    (r.org_id, r.callback_assignee_id, r.property_id, r.contact_id, 'custom',
     'Norma call needs review: outcome unknown', now(), coalesce(r.requested_by, r.callback_assignee_id),
     'Norma may have called this seller but Sandra could not confirm the result. Check Bland and the lead before calling again.',
     'norma_call:' || r.id::text)
  on conflict (org_id, source_key) where source_key is not null do nothing
  returning id into v_task;
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

-- ----------------------------------------------------------------------------
-- 10. Completion — the only place call results touch CRM state. One
-- transaction; the request row lock serialises webhook and sweep.
-- ----------------------------------------------------------------------------
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
    update public.sequence_enrollments e
       set status = 'paused', pause_reason = 'norma_call', updated_at = now()
     where e.property_id = r.property_id and e.status = 'active';
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
    update public.tasks
       set status = 'cancelled', updated_at = now()
     where org_id = r.org_id and source_key = v_task_key and status in ('open', 'snoozed');
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

-- ----------------------------------------------------------------------------
-- 11. [H1] Replies / takeover during a hold, and the stale-call sweep
-- ----------------------------------------------------------------------------

-- When the property has an open Norma hold, upgrade `norma_call` and held
-- `call_in_progress` pauses to the reply / takeover reason so no Norma release,
-- softphone cleanup or stale sweep can resume them. Never touches terminal or
-- DNC reasons (it only matches those two reasons).
create or replace function public.fn_norma_upgrade_pauses_for_reply(p_property_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer := 0;
  v_locked boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('inbound_reply', 'rep_sms_human_takeover') then
    raise exception 'invalid upgrade reason' using errcode = '22023';
  end if;
  if not public.fn_norma_hold_active(p_property_id) then
    return 0;
  end if;
  select p.is_dnc_locked into v_locked from public.properties p where p.id = p_property_id;
  if coalesce(v_locked, true) then
    return 0;
  end if;
  update public.sequence_enrollments e
     set pause_reason = p_reason, updated_at = now()
   where e.property_id = p_property_id and e.status = 'paused'
     and e.pause_reason in ('norma_call', 'call_in_progress');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- The stale-call sweep's activation, now hold aware. Takes each enrollment
-- lock first, then re-reads the hold in a fresh statement, so it cannot race
-- fn_norma_pause_for_request (which locks the same rows). Returns the number
-- actually resumed.
create or replace function public.sweep_resume_call_in_progress(
  p_enrollment_ids uuid[],
  p_resume_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  e public.sequence_enrollments%rowtype;
  v_n integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  for v_id in select distinct x from unnest(coalesce(p_enrollment_ids, '{}'::uuid[])) as t(x) order by 1 loop
    select * into e from public.sequence_enrollments where id = v_id for update;
    if e.id is null or e.status <> 'paused' or e.pause_reason is distinct from 'call_in_progress' then
      continue;
    end if;
    if public.fn_norma_hold_active(e.property_id) then
      continue;
    end if;
    update public.sequence_enrollments
       set status = 'active', pause_reason = null, next_run_at = p_resume_at, updated_at = p_resume_at
     where id = e.id and status = 'paused' and pause_reason = 'call_in_progress';
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ----------------------------------------------------------------------------
-- 12. Function grants: service role only (the resume RPC keeps its own grants)
-- ----------------------------------------------------------------------------
revoke all on function public.norma_call_requests_guard() from public, anon, authenticated;
revoke all on function public.fn_norma_hold_active(uuid) from public, anon, authenticated;
revoke all on function public.fn_norma_eligibility(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_pause_for_request(uuid) from public, anon, authenticated;
revoke all on function public.fn_norma_release_pauses(uuid) from public, anon, authenticated;
revoke all on function public.fn_norma_create_request(uuid, uuid, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.fn_norma_claim_dispatch(uuid) from public, anon, authenticated;
revoke all on function public.fn_norma_bind_call_id(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_mark_dispatch_rejected(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_mark_dispatch_unknown(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_mark_needs_review(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_norma_complete_call(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fn_norma_upgrade_pauses_for_reply(uuid, text) from public, anon, authenticated;
revoke all on function public.sweep_resume_call_in_progress(uuid[], timestamptz) from public, anon, authenticated;

grant execute on function public.fn_norma_hold_active(uuid) to service_role;
grant execute on function public.fn_norma_eligibility(uuid, uuid, text) to service_role;
grant execute on function public.fn_norma_pause_for_request(uuid) to service_role;
grant execute on function public.fn_norma_release_pauses(uuid) to service_role;
grant execute on function public.fn_norma_create_request(uuid, uuid, text, uuid, text, uuid) to service_role;
grant execute on function public.fn_norma_claim_dispatch(uuid) to service_role;
grant execute on function public.fn_norma_bind_call_id(uuid, text) to service_role;
grant execute on function public.fn_norma_mark_dispatch_rejected(uuid, text) to service_role;
grant execute on function public.fn_norma_mark_dispatch_unknown(uuid, text) to service_role;
grant execute on function public.fn_norma_mark_needs_review(uuid, text) to service_role;
grant execute on function public.fn_norma_complete_call(uuid, text, text, jsonb) to service_role;
grant execute on function public.fn_norma_upgrade_pauses_for_reply(uuid, text) to service_role;
grant execute on function public.sweep_resume_call_in_progress(uuid[], timestamptz) to service_role;

commit;
