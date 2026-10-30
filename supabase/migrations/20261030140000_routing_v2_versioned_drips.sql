-- SMS reply routing v2, PR-C: versioned drips, dynamic slot times, atomic reply transition.
--
-- Flag-off and additive. Existing sequences, steps and enrollments are NOT modified: the new
-- drips are NEW sequence rows (inactive, hidden from the drip picker) tagged with
-- routing_v2_key; only route_reply_transition() (not wired to live routing yet) enrolls into
-- them, and only when routing_v2_flags.questions_live AND .drips are on for a canary-eligible
-- property. sequence-tick re-checks the same flags (plus takeover + suppression) right before
-- every send of a v2 enrollment.
--
-- Rollback: supabase/rollbacks/20261030140000_routing_v2_versioned_drips.sql
begin;
set local lock_timeout = '5s';
-- The seed below writes v2 drip steps; the edit guard (section 6) honours this opt-in.
set local routing_v2.allow_drip_edit = 'on';

-- ---------------------------------------------------------------------------
-- 1. Columns (all nullable, no defaults: existing rows unchanged)
-- ---------------------------------------------------------------------------
alter table public.sequences
  add column if not exists routing_v2_key text,
  add column if not exists routing_v2_version integer,
  add column if not exists routing_v2_then_key text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sequences_routing_v2_key_check') then
    alter table public.sequences add constraint sequences_routing_v2_key_check check (
      (routing_v2_key is null and routing_v2_version is null and routing_v2_then_key is null)
      or (
        routing_v2_key in ('price_too_high','said_theyd_call','vacant_land','book_appointment','listed_not_selling')
        and routing_v2_version is not null and routing_v2_version >= 1
        and (routing_v2_then_key is null or routing_v2_then_key in
          ('price_too_high','said_theyd_call','vacant_land','book_appointment','listed_not_selling'))
      )
    );
  end if;
end $$;

create unique index if not exists idx_sequences_routing_v2_key_version
  on public.sequences (org_id, routing_v2_key, routing_v2_version)
  where routing_v2_key is not null;

alter table public.sequence_steps
  add column if not exists slot_window text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sequence_steps_slot_window_check') then
    alter table public.sequence_steps add constraint sequence_steps_slot_window_check
      check (slot_window is null or slot_window in ('any','morning','afternoon'));
  end if;
end $$;

alter table public.sequence_enrollments
  add column if not exists routing_v2_engine text,
  add column if not exists ended_reason text,
  add column if not exists retired_by_inbound_id uuid,
  add column if not exists routing_v2_inbound_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sequence_enrollments_routing_v2_engine_check') then
    alter table public.sequence_enrollments add constraint sequence_enrollments_routing_v2_engine_check
      check (routing_v2_engine is null or routing_v2_engine = 'v2');
  end if;
end $$;

-- At most one ACTIVE v2 enrollment per property (legacy rows are out of scope so the index
-- can never fail to build on existing data).
create unique index if not exists idx_enrollments_routing_v2_one_active
  on public.sequence_enrollments (property_id)
  where routing_v2_engine = 'v2' and status = 'active';

-- ---------------------------------------------------------------------------
-- 2. Transition log + outbox
-- ---------------------------------------------------------------------------
create table if not exists public.routing_v2_reply_transitions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  property_id uuid not null,
  inbound_message_id uuid not null unique,
  inbound_at timestamptz not null,
  transition_seq bigint not null,
  outcome text not null check (outcome in ('applied','superseded','takeover_blocked','flag_off','suppressed','no_sequence')),
  decision jsonb not null,
  new_enrollment_id uuid,
  retired_enrollment_ids uuid[] not null default '{}',
  cancelled_outbox_ids uuid[] not null default '{}',
  cancelled_drip_claim_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists routing_v2_reply_transitions_property_idx
  on public.routing_v2_reply_transitions (property_id, transition_seq desc);

create table if not exists public.routing_v2_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  property_id uuid not null,
  inbound_message_id uuid not null,
  transition_seq bigint not null,
  kind text not null check (kind in ('reply','alert')),
  -- Which engine queued it and which routing_v2_flags slice gates it; both are re-checked at
  -- claim time for every kind (questions_live is always required too).
  engine text not null default 'v2' check (engine = 'v2'),
  slice text not null check (slice in ('replies','drips','haiku','price_check','alert_on_time_only',
                                       'wrong_number_all','model_stop_suppression')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','claimed','sent','cancelled')),
  cancel_reason text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists routing_v2_outbox_pending_idx
  on public.routing_v2_outbox (property_id) where status in ('pending','claimed');

-- Drip send claims: sequence-tick takes one (under the property lock, after re-checking the
-- enrollment) immediately before the provider call. A reply transition cancels every open claim
-- and retires the enrollment in the same lock, so authorize_sequence_provider_attempt (which
-- re-locks the enrollment and requires status = 'active') refuses the send.
create table if not exists public.routing_v2_drip_send_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  property_id uuid not null,
  enrollment_id uuid not null,
  step_run_id uuid not null unique,
  status text not null default 'open' check (status in ('open','cancelled','sent','unknown')),
  cancel_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists routing_v2_drip_send_claims_open_idx
  on public.routing_v2_drip_send_claims (property_id) where status = 'open';

alter table public.routing_v2_reply_transitions enable row level security;
alter table public.routing_v2_outbox enable row level security;
alter table public.routing_v2_drip_send_claims enable row level security;
revoke all on public.routing_v2_reply_transitions, public.routing_v2_outbox, public.routing_v2_drip_send_claims
  from public, anon, authenticated;
grant select, insert, update on public.routing_v2_reply_transitions, public.routing_v2_outbox,
  public.routing_v2_drip_send_claims to service_role;

-- ---------------------------------------------------------------------------
-- 3. Flag + eligibility (BUILD-PLAN §13.1). Every slice also needs questions_live.
-- ---------------------------------------------------------------------------
create or replace function public.routing_v2_slice_enabled(p_property_id uuid, p_slice text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.properties p
    join public.ai_responder_configs c on c.org_id = p.org_id and c.active
    where p.id = p_property_id
      and coalesce(c.routing_v2_flags->>'questions_live','false') = 'true'
      and coalesce(c.routing_v2_flags->>p_slice,'false') = 'true'
      and (
        coalesce(c.routing_v2_flags->'canary_property_ids','[]'::jsonb) ? p_property_id::text
        or ((hashtext(p_property_id::text)::bigint % 100) + 100) % 100
           < coalesce((c.routing_v2_flags->>'canary_percent')::int, 0)
      )
  );
$$;

-- Seller-side suppression for a property's drip contact: DNC lock, contact opt-out / DNC, or
-- a phone suppression row matching any of the contact's numbers (last 10 digits).
create or replace function public.routing_v2_contact_suppressed(p_property_id uuid, p_contact_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce((select is_dnc_locked from public.properties where id = p_property_id), true)
    or exists (
      select 1 from public.contacts c
      where c.id = p_contact_id and (c.sms_opted_out or c.do_not_contact)
    )
    or exists (
      select 1
      from public.contacts c
      join public.sms_phone_suppressions s on s.org_id = c.org_id
      where c.id = p_contact_id
        and right(regexp_replace(s.phone_e164, '\D', '', 'g'), 10) in (
          right(regexp_replace(coalesce(c.phone_1,''), '\D', '', 'g'), 10),
          right(regexp_replace(coalesce(c.phone_2,''), '\D', '', 'g'), 10),
          right(regexp_replace(coalesce(c.phone_3,''), '\D', '', 'g'), 10)
        )
        and length(regexp_replace(s.phone_e164, '\D', '', 'g')) >= 10
    );
$$;

-- Latest version of a v2 drip for an org.
create or replace function public.routing_v2_sequence_for(p_org_id uuid, p_key text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id from public.sequences s
  where s.org_id = p_org_id and s.routing_v2_key = p_key and s.archived_at is null
  order by s.routing_v2_version desc
  limit 1;
$$;

-- Insert one v2 enrollment (caller holds the property lock and has retired prior rows).
create or replace function public.routing_v2_enroll(
  p_org_id uuid, p_property_id uuid, p_contact_id uuid, p_sequence_id uuid, p_inbound_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delay integer;
  v_id uuid;
begin
  select delay_after_previous_minutes into v_delay
  from public.sequence_steps where sequence_id = p_sequence_id and step_index = 0;
  if v_delay is null then
    raise exception 'ROUTING_V2_EMPTY_SEQUENCE: % has no step 0', p_sequence_id;
  end if;
  -- Provenance: the enrollment guard only accepts a v2 row while this transaction-local
  -- marker is set, and only this SECURITY DEFINER function sets it (a caller-supplied
  -- routing_v2_engine = 'v2' alone is refused).
  perform set_config('routing_v2.enrolling', 'on', true);
  insert into public.sequence_enrollments
    (org_id, sequence_id, property_id, contact_id, status, current_step_index, next_run_at,
     routing_v2_engine, routing_v2_inbound_id)
  values
    (p_org_id, p_sequence_id, p_property_id, p_contact_id, 'active', 0,
     now() + make_interval(mins => v_delay), 'v2', p_inbound_id)
  returning id into v_id;
  perform set_config('routing_v2.enrolling', '', true);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Atomic reply transition (BUILD-PLAN §14). Not called by live routing yet.
--
-- p_decision: {"sequence_key": text|null, "contact_id": uuid|null,
--              "outbox": [{"kind": "reply"|"alert", "payload": {...}}]}
-- Returns the stored transition row as jsonb (+ "replayed": true on a repeat call).
-- ---------------------------------------------------------------------------
create or replace function public.route_reply_transition(
  p_inbound_message_id uuid,
  p_property_id uuid,
  p_decision jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.routing_v2_reply_transitions;
  v_row public.routing_v2_reply_transitions;
  v_org uuid;
  v_inbound_at timestamptz;
  v_contact uuid;
  v_seq bigint;
  v_outcome text;
  v_key text := nullif(p_decision->>'sequence_key', '');
  v_sequence uuid;
  v_new_enrollment uuid;
  v_retired uuid[] := '{}';
  v_cancelled uuid[] := '{}';
  v_cancelled_claims uuid[] := '{}';
  v_takeover timestamptz;
  v_locked boolean;
  v_item jsonb;
begin
  -- 1. Serialize every reply / takeover / scheduler step for this property.
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));

  -- 2. Idempotency: a repeat call returns the stored result with no side effects.
  select * into v_existing from public.routing_v2_reply_transitions
  where inbound_message_id = p_inbound_message_id;
  if found then
    return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
  end if;

  select m.org_id, m.created_at, m.contact_id into v_org, v_inbound_at, v_contact
  from public.messages m
  where m.id = p_inbound_message_id and m.direction = 'inbound' and m.property_id = p_property_id;
  if v_org is null then
    raise exception 'ROUTING_V2_BAD_INBOUND: % is not an inbound message for property %',
      p_inbound_message_id, p_property_id;
  end if;
  v_contact := coalesce(nullif(p_decision->>'contact_id','')::uuid, v_contact);

  select coalesce(max(transition_seq), 0) + 1 into v_seq
  from public.routing_v2_reply_transitions where property_id = p_property_id;

  -- 3. Latest reply wins: a newer inbound already transitioned -> record only.
  if exists (
    select 1 from public.routing_v2_reply_transitions t
    where t.property_id = p_property_id and t.outcome <> 'superseded'
      and (t.inbound_at > v_inbound_at
           or (t.inbound_at = v_inbound_at and t.inbound_message_id > p_inbound_message_id))
  ) then
    v_outcome := 'superseded';
  elsif not public.routing_v2_slice_enabled(p_property_id, 'drips') then
    v_outcome := 'flag_off';
  end if;

  if v_outcome is null then
    select coalesce(is_dnc_locked, false) into v_locked from public.properties where id = p_property_id;

    -- 4. Retire every active OR paused enrollment for the property (any engine).
    if v_locked then
      -- DNC-locked property: guard_locked_property_sequence_enrollment only allows the exact
      -- compliance stop (active/paused -> opted_out, pause_reason dnc, next_run_at null, no
      -- other column). Anything else raises DNC_LOCKED and would roll back the transition.
      with retired as (
        update public.sequence_enrollments e
        set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
        where e.property_id = p_property_id and e.status in ('active','paused')
        returning e.id
      ) select coalesce(array_agg(id), '{}') into v_retired from retired;
    else
      with retired as (
        update public.sequence_enrollments e
        set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(),
            ended_reason = 'rerouted', retired_by_inbound_id = p_inbound_message_id
        where e.property_id = p_property_id and e.status in ('active','paused')
        returning e.id
      ) select coalesce(array_agg(id), '{}') into v_retired from retired;
    end if;

    -- 4b. Open drip send claims for the property are cancelled (reply-vs-tick race).
    with cc as (
      update public.routing_v2_drip_send_claims dc
      set status = 'cancelled', cancel_reason = 'retired_by=' || p_inbound_message_id::text, cancelled_at = now()
      where dc.property_id = p_property_id and dc.status = 'open'
      returning dc.id
    ) select coalesce(array_agg(id), '{}') into v_cancelled_claims from cc;

    -- 6. Obsolete intents from older inbounds are cancelled.
    with c as (
      update public.routing_v2_outbox o
      set status = 'cancelled', cancel_reason = 'superseded_by=' || p_inbound_message_id::text
      where o.property_id = p_property_id and o.status = 'pending' and o.transition_seq < v_seq
      returning o.id
    ) select coalesce(array_agg(id), '{}') into v_cancelled from c;

    select last_person_takeover_at into v_takeover from public.properties where id = p_property_id;

    if v_locked then
      v_outcome := 'suppressed';
    elsif v_takeover is not null and v_takeover >= v_inbound_at then
      v_outcome := 'takeover_blocked';
    elsif public.routing_v2_contact_suppressed(p_property_id, v_contact) then
      v_outcome := 'suppressed';
    else
      v_outcome := 'applied';
      if v_key is not null then
        v_sequence := public.routing_v2_sequence_for(v_org, v_key);
        if v_sequence is null then
          v_outcome := 'no_sequence';
        else
          v_new_enrollment := public.routing_v2_enroll(v_org, p_property_id, v_contact, v_sequence, p_inbound_message_id);
        end if;
      end if;
    end if;

    -- 5. Outbound intents. Takeover / suppression: alerts only, never an auto reply.
    for v_item in select * from jsonb_array_elements(coalesce(p_decision->'outbox', '[]'::jsonb)) loop
      if (v_item->>'kind') = 'alert' or v_outcome in ('applied','no_sequence') then
        insert into public.routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, payload)
        values (v_org, p_property_id, p_inbound_message_id, v_seq, v_item->>'kind', 'v2',
                coalesce(nullif(v_item->>'slice',''), case v_item->>'kind' when 'reply' then 'replies' else 'drips' end),
                coalesce(v_item->'payload','{}'::jsonb));
      end if;
    end loop;
  end if;

  insert into public.routing_v2_reply_transitions
    (org_id, property_id, inbound_message_id, inbound_at, transition_seq, outcome, decision,
     new_enrollment_id, retired_enrollment_ids, cancelled_outbox_ids, cancelled_drip_claim_ids)
  values
    (v_org, p_property_id, p_inbound_message_id, v_inbound_at, v_seq, v_outcome, p_decision,
     v_new_enrollment, v_retired, v_cancelled, v_cancelled_claims)
  returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('replayed', false);
end;
$$;

-- Human takeover under the same lock: cancels every pending v2 intent for the property.
create or replace function public.routing_v2_cancel_for_takeover(p_property_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || p_property_id::text));
  update public.routing_v2_outbox set status = 'cancelled', cancel_reason = 'human_takeover'
  where property_id = p_property_id and status in ('pending','claimed');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Delivery-time re-check for one outbox row. Returns 'ok' (row now claimed) or the cancel reason.
create or replace function public.routing_v2_claim_outbox(p_outbox_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_outbox;
  v_latest bigint;
  v_inbound_at timestamptz;
  v_takeover timestamptz;
  v_reason text;
begin
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.property_id::text));
  select * into v from public.routing_v2_outbox where id = p_outbox_id;
  if v.status <> 'pending' then return 'not_pending'; end if;

  select max(transition_seq) into v_latest from public.routing_v2_reply_transitions
  where property_id = v.property_id and outcome <> 'superseded';
  select inbound_at into v_inbound_at from public.routing_v2_reply_transitions
  where inbound_message_id = v.inbound_message_id;
  select last_person_takeover_at into v_takeover from public.properties where id = v.property_id;

  if v_latest is distinct from v.transition_seq then
    v_reason := 'superseded';
  elsif v.kind = 'reply' and v_takeover is not null and v_takeover >= v_inbound_at then
    v_reason := 'human_takeover';
  elsif v.engine is distinct from 'v2' or not public.routing_v2_slice_enabled(v.property_id, v.slice) then
    -- Every kind (alerts too): questions_live + the item's own slice + canary eligibility.
    v_reason := 'flag_off';
  end if;

  if v_reason is not null then
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = v_reason where id = v.id;
    return v_reason;
  end if;
  update public.routing_v2_outbox set status = 'claimed', claimed_at = now() where id = v.id;
  return 'ok';
end;
$$;

-- Send-time re-check for a v2 drip step (called by sequence-tick right before the provider
-- call). Returns 'ok' or a reason; on flag-off the enrollment is stopped (BUILD-PLAN §13.3),
-- on takeover/suppression it is paused so a person decides.
create or replace function public.routing_v2_enrollment_send_check(p_enrollment_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_takeover timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found then return 'missing'; end if;
  if e.routing_v2_engine is distinct from 'v2' then
    -- Legacy enrollment: untouched, unless it points at a v2 drip (only routing v2 may enroll
    -- there; anything else would send approved texts with no flag/canary/takeover check).
    if not exists (select 1 from public.sequences s where s.id = e.sequence_id and s.routing_v2_key is not null) then
      return 'ok';
    end if;
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
    select * into e from public.sequence_enrollments where id = p_enrollment_id;
    if e.status <> 'active' then return 'not_active'; end if;
    if coalesce((select is_dnc_locked from public.properties where id = e.property_id), false) then
      update public.sequence_enrollments
      set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
      where id = e.id and status = 'active';
      return 'suppressed';
    end if;
    update public.sequence_enrollments
    set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
    where id = e.id and status = 'active';
    return 'flag_off';
  end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if e.status <> 'active' then return 'not_active'; end if;

  -- DNC lock first: the only write the lock trigger allows is the compliance opt-out.
  if coalesce((select is_dnc_locked from public.properties where id = e.property_id), false) then
    update public.sequence_enrollments
    set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'suppressed';
  end if;

  if not public.routing_v2_slice_enabled(e.property_id, 'drips') then
    update public.sequence_enrollments
    set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
    where id = e.id and status = 'active';
    return 'flag_off';
  end if;
  select last_person_takeover_at into v_takeover from public.properties where id = e.property_id;
  if v_takeover is not null and v_takeover >= e.enrolled_at then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'person_took_over', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'person_took_over';
  end if;
  if public.routing_v2_contact_suppressed(e.property_id, e.contact_id) then
    update public.sequence_enrollments
    set status = 'paused', pause_reason = 'consent_revoked', next_run_at = null, updated_at = now()
    where id = e.id and status = 'active';
    return 'suppressed';
  end if;
  return 'ok';
end;
$$;

-- Check-and-claim for one v2 drip send, called by sequence-tick immediately before the
-- provider call (after its own step-run claim). Under the property lock it re-runs the full
-- send check and records an open claim; returns 'ok' or the refusal reason. A reply transition
-- that lands afterwards cancels the claim and retires the enrollment, which makes
-- authorize_sequence_provider_attempt refuse the provider call.
create or replace function public.routing_v2_claim_drip_send(p_enrollment_id uuid, p_step_run_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_check text;
  v_existing public.routing_v2_drip_send_claims;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found then return 'missing'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  v_check := public.routing_v2_enrollment_send_check(p_enrollment_id);
  if e.routing_v2_engine is distinct from 'v2' then return v_check; end if;
  if v_check <> 'ok' then return v_check; end if;
  if not exists (select 1 from public.sequence_step_runs r
                 where r.id = p_step_run_id and r.enrollment_id = p_enrollment_id and r.claim_active) then
    return 'step_run_not_active';
  end if;
  select * into v_existing from public.routing_v2_drip_send_claims where step_run_id = p_step_run_id;
  if found then
    return case when v_existing.status = 'open' then 'ok' else 'claim_cancelled' end;
  end if;
  insert into public.routing_v2_drip_send_claims (org_id, property_id, enrollment_id, step_run_id)
  values (e.org_id, e.property_id, e.id, p_step_run_id);
  return 'ok';
end;
$$;

-- After an accepted send: the claim is consumed, so later replies only cancel unsent claims.
-- p_outcome: 'sent' (provider accepted) or 'unknown' (provider may have sent). A reply that
-- cancelled the claim while the provider call was in flight is corrected: the claim takes the
-- real outcome and leaves the transition's cancelled_drip_claim_ids. Returns the claim id
-- (null when the step run has no v2 claim, e.g. a legacy drip).
create or replace function public.routing_v2_mark_drip_claim_sent(p_step_run_id uuid, p_outcome text default 'sent')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_outcome not in ('sent','unknown') then
    raise exception 'ROUTING_V2_BAD_CLAIM_OUTCOME: %', p_outcome;
  end if;
  update public.routing_v2_drip_send_claims
  set status = p_outcome,
      cancel_reason = case when status = 'cancelled' then 'provider_accepted_after:' || coalesce(cancel_reason, '') else cancel_reason end
  where step_run_id = p_step_run_id and status in ('open','cancelled','unknown')
  returning id into v_id;
  if v_id is not null then
    update public.routing_v2_reply_transitions
    set cancelled_drip_claim_ids = array_remove(cancelled_drip_claim_ids, v_id)
    where v_id = any(cancelled_drip_claim_ids);
  end if;
  return v_id;
end;
$$;

-- Chain at the end of a v2 drip (Said they'd call -> Book appointment v2). Only when the
-- finished sequence names routing_v2_then_key; no other drip has an end-of-drip action.
create or replace function public.routing_v2_chain_after_completion(p_enrollment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_then text;
  v_next uuid;
  v_takeover timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found or e.routing_v2_engine is distinct from 'v2' then return null; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if e.status <> 'completed' or e.ended_reason is not null then return null; end if;
  select routing_v2_then_key into v_then from public.sequences where id = e.sequence_id;
  if v_then is null then return null; end if;
  if not public.routing_v2_slice_enabled(e.property_id, 'drips') then return null; end if;
  select last_person_takeover_at into v_takeover from public.properties where id = e.property_id;
  if v_takeover is not null and v_takeover >= e.enrolled_at then return null; end if;
  if public.routing_v2_contact_suppressed(e.property_id, e.contact_id) then return null; end if;
  if exists (select 1 from public.sequence_enrollments x
             where x.property_id = e.property_id and x.status in ('active','paused')) then
    return null;
  end if;
  v_next := public.routing_v2_sequence_for(e.org_id, v_then);
  if v_next is null then return null; end if;
  update public.sequence_enrollments set ended_reason = 'chained' where id = e.id;
  return public.routing_v2_enroll(e.org_id, e.property_id, e.contact_id, v_next, e.routing_v2_inbound_id);
end;
$$;

revoke all on function public.routing_v2_slice_enabled(uuid, text) from public, anon, authenticated;
revoke all on function public.routing_v2_contact_suppressed(uuid, uuid) from public, anon, authenticated;
revoke all on function public.routing_v2_sequence_for(uuid, text) from public, anon, authenticated;
revoke all on function public.routing_v2_enroll(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.route_reply_transition(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.routing_v2_cancel_for_takeover(uuid) from public, anon, authenticated;
revoke all on function public.routing_v2_claim_outbox(uuid) from public, anon, authenticated;
revoke all on function public.routing_v2_enrollment_send_check(uuid) from public, anon, authenticated;
revoke all on function public.routing_v2_chain_after_completion(uuid) from public, anon, authenticated;
revoke all on function public.routing_v2_claim_drip_send(uuid, uuid) from public, anon, authenticated;
revoke all on function public.routing_v2_mark_drip_claim_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.routing_v2_mark_drip_claim_sent(uuid, text) to service_role;
grant execute on function public.routing_v2_claim_drip_send(uuid, uuid) to service_role;
grant execute on function public.routing_v2_slice_enabled(uuid, text) to service_role;
grant execute on function public.routing_v2_contact_suppressed(uuid, uuid) to service_role;
grant execute on function public.routing_v2_sequence_for(uuid, text) to service_role;
grant execute on function public.route_reply_transition(uuid, uuid, jsonb) to service_role;
grant execute on function public.routing_v2_cancel_for_takeover(uuid) to service_role;
grant execute on function public.routing_v2_claim_outbox(uuid) to service_role;
grant execute on function public.routing_v2_enrollment_send_check(uuid) to service_role;
grant execute on function public.routing_v2_chain_after_completion(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Seed: NEW inactive v2 sequences per org (texts pinned by drip-spec.test.ts).
--    Idempotent: an org that already has version 1 of a key is skipped.
-- ---------------------------------------------------------------------------
drop table if exists routing_v2_seed;
create temporary table routing_v2_seed (key text, idx int, day int, slot_window text, body text) on commit drop;
insert into routing_v2_seed (key, idx, day, slot_window, body) values
    ('price_too_high', 0, 30, null, $t$Hey, it's Mel. We discussed {{property_address}} in today's meeting. Bummer the numbers didn't work. Okay to stay in touch in case anything changes?$t$),
    ('price_too_high', 1, 75, null, $t$Hi {{first_name | there}}, Mel with BMH. Any flexibility on your price for {{property_address}}?$t$),
    ('price_too_high', 2, 135, null, $t$Hey, Mel again. We're still buying in your area. Would you be open to revisiting an offer on {{property_address}}?$t$),
    ('price_too_high', 3, 225, null, $t$Hi {{first_name | there}}, we've set aside funds for a couple more purchases. Is your number on {{property_address}} still firm?$t$),
    ('price_too_high', 4, 315, null, $t$Hey, Mel here. Checking back on {{property_address}}. Has anything changed on your price?$t$),
    ('price_too_high', 5, 435, null, $t$Hi {{first_name | there}}, we just added capital for new purchases. Open to talking numbers on {{property_address}} again?$t$),
    ('price_too_high', 6, 555, null, $t$Hey, Mel at BMH Group. Last check-in for now on {{property_address}}. Any wiggle room on price, or should I check back later?$t$),
    ('vacant_land', 0, 0, null, $t$Hey, it's Mel. Thanks for clearing that up. I'll let acquisitions know {{property_address}} is a vacant lot. Would you sell it for the right price?$t$),
    ('vacant_land', 1, 30, null, $t$Hey, it's Mel. Acquisitions is looking at vacant lots near {{property_address}}. Is yours still available?$t$),
    ('vacant_land', 2, 90, null, $t$Hey, it's Mel. Still interested in the vacant lot at {{property_address}}. Do you have a price in mind?$t$),
    ('vacant_land', 3, 180, null, $t$Hey, it's Mel. Checking back on the vacant lot at {{property_address}}. Has anything changed on your end?$t$),
    ('vacant_land', 4, 365, null, $t$Hey, it's Mel at BMH Group. Still happy to make a cash offer on the vacant lot at {{property_address}} if it makes sense.$t$),
    ('said_theyd_call', 0, 1, 'any', $t$Hey, it's Mel. Our calendar is pretty full, but I can squeeze in a quick call about {{property_address}} at {{slot_time}} today. Would that work?$t$),
    ('said_theyd_call', 1, 2, 'any', $t$Hi {{first_name | there}}, Mel again. We had an opening come up at {{slot_time}} today. Want me to grab it for a quick call about {{property_address}}?$t$),
    ('said_theyd_call', 2, 3, 'afternoon', $t$Hey, I can squeeze you in at {{slot_time}} this afternoon before we wrap up. Want that spot?$t$),
    ('said_theyd_call', 3, 5, 'afternoon', $t$Hi {{first_name | there}}, schedule's tight today, but I can hold {{slot_time}} this afternoon for a quick call about {{property_address}}. Should I hold it?$t$),
    ('said_theyd_call', 4, 7, 'any', $t$Hey, Mel here. Just had a {{slot_time}} cancel today. Want me to put you in that spot for a quick call?$t$),
    ('said_theyd_call', 5, 10, 'afternoon', $t$Hi {{first_name | there}}, we're booked most of today, but I saved one afternoon slot at {{slot_time}} for {{property_address}}. Want it?$t$),
    ('book_appointment', 0, 1, 'any', $t$Hey, Mel again. Our calendar is pretty full, but I can get you in at {{slot_time}} today to talk about {{property_address}}. Want it?$t$),
    ('book_appointment', 1, 2, 'afternoon', $t$Hi {{first_name | there}}, a {{slot_time}} just opened up this afternoon. Want me to hold it for a quick call about {{property_address}}?$t$),
    ('book_appointment', 2, 4, 'morning', $t$Hey, Mel here. We're booked solid today, but I can squeeze you in at {{slot_time}} this morning. Should I put you down?$t$),
    ('book_appointment', 3, 5, 'afternoon', $t$Hi {{first_name | there}}, I've got one afternoon spot left today at {{slot_time}} for {{property_address}}. Want me to save it for you?$t$),
    ('book_appointment', 4, 7, 'any', $t$Hey, just had a {{slot_time}} cancel today. Want me to grab it for a quick call about {{property_address}}?$t$),
    ('book_appointment', 5, 8, 'any', $t$Hi {{first_name | there}}, last open spot I have today is {{slot_time}}. Want it for a quick call about {{property_address}}?$t$),
    ('listed_not_selling', 0, 2, null, $t$Hey, I just heard back from underwriting. It came in lower than you and I were hoping. I'm going to keep poking them to see if I can get them up on the offer.$t$);

do $$
declare
  r record;
  v_key text;
  v_name text;
  v_then text;
  v_seq uuid;
  v_src uuid;
  v_src_cum6 bigint;
  v_names constant jsonb := jsonb_build_object(
    'price_too_high', 'Price too high (routing v2)',
    'vacant_land', 'Vacant land (routing v2)',
    'said_theyd_call', 'Said they''d call (routing v2)',
    'book_appointment', 'Book appointment (routing v2)',
    'listed_not_selling', 'Listed, not selling (routing v2)');
begin
  for r in select distinct org_id from public.ai_responder_configs loop
    foreach v_key in array array['price_too_high','vacant_land','said_theyd_call','book_appointment','listed_not_selling'] loop
      continue when exists (select 1 from public.sequences
        where org_id = r.org_id and routing_v2_key = v_key and routing_v2_version = 1);
      v_name := v_names->>v_key;
      if exists (select 1 from public.sequences
                 where org_id = r.org_id and lower(name) = lower(v_name) and archived_at is null) then
        raise notice 'routing v2 seed: org % already has a drip named %, skipped', r.org_id, v_name;
        continue;
      end if;

      v_src := null;
      if v_key in ('book_appointment','listed_not_selling') then
        -- The org's existing drip: the nurture mapping first, else the one drip with that name.
        select case v_key when 'book_appointment' then c.nurture_drip_hot_book_appointment_sequence_id
                          else c.nurture_drip_listed_not_selling_sequence_id end
          into v_src
        from public.ai_responder_configs c
        where c.org_id = r.org_id
          and (case v_key when 'book_appointment' then c.nurture_drip_hot_book_appointment_sequence_id
                          else c.nurture_drip_listed_not_selling_sequence_id end) is not null
        order by c.active desc
        limit 1;
        if v_src is null then
          select s.id into v_src from public.sequences s
          where s.org_id = r.org_id and s.archived_at is null and s.routing_v2_key is null
            and lower(s.name) = case v_key when 'book_appointment' then 'book appointment' else 'listed, not selling' end
            and (select count(*) from public.sequences s2
                 where s2.org_id = r.org_id and s2.archived_at is null and s2.routing_v2_key is null
                   and lower(s2.name) = lower(s.name)) = 1;
        end if;
        if v_src is null then
          raise notice 'routing v2 seed: org % has no existing % drip, version 2 skipped', r.org_id, v_key;
          continue;
        end if;
      end if;

      v_then := case v_key when 'said_theyd_call' then 'book_appointment' else null end;
      insert into public.sequences
        (org_id, name, description, active, append_opt_out, routing_v2_key, routing_v2_version, routing_v2_then_key)
      values
        (r.org_id, v_name,
         'Routing v2 drip (seeded inactive). Enrolled only by routing v2 when its drips flag is on.',
         false, false, v_key, 1, v_then)
      returning id into v_seq;

      if v_key in ('price_too_high','vacant_land','said_theyd_call') then
        insert into public.sequence_steps
          (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body, slot_window)
        select v_seq, s.idx,
               (s.day - coalesce(lag(s.day) over (order by s.idx), 0)) * 1440,
               'send_sms', s.body, s.slot_window
        from routing_v2_seed s where s.key = v_key;

      elsif v_key = 'book_appointment' then
        -- New first 6 steps (days 1,2,4,5,7,8), then the existing drip's later steps unchanged.
        insert into public.sequence_steps
          (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body, slot_window)
        select v_seq, s.idx,
               (s.day - coalesce(lag(s.day) over (order by s.idx), 0)) * 1440,
               'send_sms', s.body, s.slot_window
        from routing_v2_seed s where s.key = 'book_appointment';

        select sum(delay_after_previous_minutes) into v_src_cum6
        from public.sequence_steps where sequence_id = v_src and step_index <= 6;

        insert into public.sequence_steps
          (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body, template_id,
           template_category, target_status, vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id,
           vm_template_category)
        select v_seq, 6 + (row_number() over (order by st.step_index))::int - 1,
               case when st.step_index = (select min(step_index) from public.sequence_steps
                                          where sequence_id = v_src and step_index >= 6)
                         and v_src_cum6 > 8 * 1440
                    then (v_src_cum6 - 8 * 1440)::int  -- keep the step on its original day
                    else st.delay_after_previous_minutes end,
               st.action_type, st.template_body, st.template_id, st.template_category, st.target_status,
               st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
        from public.sequence_steps st
        where st.sequence_id = v_src and st.step_index >= 6;

      else
        -- Listed, not selling: every existing step on its original day + the new day-2 step.
        insert into public.sequence_steps
          (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body, template_id,
           template_category, target_status, vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id,
           vm_template_category)
        select v_seq, (row_number() over (order by m.cum, m.ord, m.src_index))::int - 1,
               (m.cum - coalesce(lag(m.cum) over (order by m.cum, m.ord, m.src_index), 0))::int,
               m.action_type, m.template_body, m.template_id, m.template_category, m.target_status,
               m.vm_media_id, m.vm_tts_body, m.vm_voice_id, m.vm_phone_line_id, m.vm_template_category
        from (
          select sum(st.delay_after_previous_minutes) over (order by st.step_index)::bigint as cum,
                 0 as ord, st.step_index as src_index,
                 st.action_type, st.template_body, st.template_id, st.template_category, st.target_status,
                 st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
          from public.sequence_steps st where st.sequence_id = v_src
          union all
          select (s.day * 1440)::bigint, 1, 0, 'send_sms', s.body, null::uuid, null, null,
                 null, null, null, null, null
          from routing_v2_seed s where s.key = 'listed_not_selling'
        ) m;
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. v2 drips are not editable from the drip editor. sequence_replace_steps rewrites every
--    step without slot_window and the editor forces append_opt_out = true, which would break
--    the approved texts (slot times, one segment). New versions ship as new migrations; a
--    migration/rollback opts in with: set local routing_v2.allow_drip_edit = 'on'.
-- ---------------------------------------------------------------------------
create or replace function public.routing_v2_reject_drip_edit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_seq uuid;
begin
  if coalesce(current_setting('routing_v2.allow_drip_edit', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'sequences' then
    if old.routing_v2_key is not null and (
         new.append_opt_out is distinct from old.append_opt_out
      or new.active is distinct from old.active
      or new.routing_v2_key is distinct from old.routing_v2_key
      or new.routing_v2_version is distinct from old.routing_v2_version
      or new.routing_v2_then_key is distinct from old.routing_v2_then_key) then
      raise exception using errcode = 'P0001',
        message = 'ROUTING_V2_DRIP_LOCKED: routing v2 drips are edited by migration only';
    end if;
    return new;
  end if;
  foreach v_seq in array array[
    case when tg_op <> 'INSERT' then old.sequence_id end,
    case when tg_op <> 'DELETE' then new.sequence_id end] loop
    if v_seq is not null and exists (select 1 from public.sequences where id = v_seq and routing_v2_key is not null) then
      raise exception using errcode = 'P0001',
        message = 'ROUTING_V2_DRIP_LOCKED: routing v2 drip steps are edited by migration only';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists routing_v2_reject_drip_edit on public.sequences;
create trigger routing_v2_reject_drip_edit before update on public.sequences
  for each row execute function public.routing_v2_reject_drip_edit();
-- Only routing v2 enrolls into a v2 drip (manual / bulk / change-drip are refused).
create or replace function public.routing_v2_reject_foreign_enrollment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.sequence_id is not distinct from old.sequence_id
     and new.routing_v2_engine is not distinct from old.routing_v2_engine
     and new.routing_v2_inbound_id is not distinct from old.routing_v2_inbound_id then
    return new;
  end if;
  -- A v2-marked row (new, or re-marked / re-pointed) must come from routing_v2_enroll.
  if new.routing_v2_engine = 'v2'
     and coalesce(current_setting('routing_v2.enrolling', true), '') <> 'on' then
    raise exception using errcode = 'P0001',
      message = 'ROUTING_V2_DRIP_LOCKED: routing v2 enrollments are created by route_reply_transition only';
  end if;
  if new.routing_v2_engine is distinct from 'v2'
     and exists (select 1 from public.sequences s where s.id = new.sequence_id and s.routing_v2_key is not null) then
    raise exception using errcode = 'P0001',
      message = 'ROUTING_V2_DRIP_LOCKED: only routing v2 enrolls leads into routing v2 drips';
  end if;
  return new;
end;
$$;
drop trigger if exists routing_v2_reject_foreign_enrollment on public.sequence_enrollments;
create trigger routing_v2_reject_foreign_enrollment before insert or update of sequence_id, routing_v2_engine, routing_v2_inbound_id on public.sequence_enrollments
  for each row execute function public.routing_v2_reject_foreign_enrollment();

drop trigger if exists routing_v2_reject_drip_step_edit on public.sequence_steps;
create trigger routing_v2_reject_drip_step_edit before insert or update or delete on public.sequence_steps
  for each row execute function public.routing_v2_reject_drip_edit();

comment on column public.sequences.routing_v2_key is
  'Routing v2 drip identity (PR-C). Null for every pre-existing / human-made drip.';
comment on column public.sequence_steps.slot_window is
  'Routing v2 booking steps: window for the {{slot_time}} computed at send (any/morning/afternoon).';
comment on column public.sequence_enrollments.routing_v2_engine is
  'v2 = created by routing v2 (route_reply_transition / chain). Null for every legacy enrollment.';

commit;
