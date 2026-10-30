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
  outcome text not null check (outcome in ('applied','replies_only','superseded','takeover_blocked','flag_off','suppressed','no_sequence')),
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
  status text not null default 'open' check (status in ('open','cancelled','sent','unknown','not_sent')),
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
-- Canary eligibility, the SQL twin of isV2Eligible(parseRoutingV2Flags(flags), id) in
-- src/lib/sms-classification/routing-v2/flags.ts (pinned to it by the integration test):
--   * canary_property_ids: absent, or an array whose every entry is a UUID string; anything
--     else (null, non-array, one bad entry) = nothing eligible (fail closed);
--   * canary_percent: absent, or an integer JSON number 0..100; anything else = nothing eligible;
--   * eligible = id listed (case-insensitive) OR sha256(lower(id)) first 4 bytes (uint32 BE) % 100 < percent.
create or replace function public.routing_v2_canary_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb := p_flags->'canary_property_ids';
  v_pct jsonb := p_flags->'canary_percent';
  v_percent numeric := 0;
  v_bucket bigint;
begin
  if p_flags is null or jsonb_typeof(p_flags) <> 'object' or p_property_id is null then
    return false;
  end if;
  if v_ids is not null then
    if jsonb_typeof(v_ids) <> 'array' then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ids) e(v)
      where jsonb_typeof(e.v) <> 'string'
         or (e.v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
  end if;
  if v_pct is not null then
    if jsonb_typeof(v_pct) <> 'number' then
      return false;
    end if;
    v_percent := (v_pct #>> '{}')::numeric;
    if v_percent <> trunc(v_percent) or v_percent < 0 or v_percent > 100 then
      return false;
    end if;
  end if;
  if v_ids is not null and exists (
    select 1 from jsonb_array_elements_text(v_ids) e(v) where lower(e.v) = lower(p_property_id::text)
  ) then
    return true;
  end if;
  v_bucket := ('x' || substr(encode(sha256(convert_to(lower(p_property_id::text), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 100;
  return v_bucket < v_percent;
end;
$$;
revoke all on function public.routing_v2_canary_eligible(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_canary_eligible(jsonb, uuid) to service_role;

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
      and jsonb_typeof(c.routing_v2_flags) = 'object'
      and (c.routing_v2_flags->'questions_live') = 'true'::jsonb
      and (c.routing_v2_flags->p_slice) = 'true'::jsonb
      and public.routing_v2_canary_eligible(c.routing_v2_flags, p_property_id)
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
  v_drips boolean;
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
  elsif not (public.routing_v2_slice_enabled(p_property_id, 'drips')
              or public.routing_v2_slice_enabled(p_property_id, 'replies')) then
    -- Each slice works on its own: only when NEITHER drips nor replies is on is it record-only.
    v_outcome := 'flag_off';
  end if;

  if v_outcome is null then
    select coalesce(is_dnc_locked, false) into v_locked from public.properties where id = p_property_id;
    v_drips := public.routing_v2_slice_enabled(p_property_id, 'drips');

    -- 4. Retire every active OR paused enrollment for the property (any engine). Drips slice
    --    only: with drips off, existing drips are left exactly as they are.
    if not v_drips then
      null;
    elsif v_locked then
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
    if v_drips then
      with cc as (
        update public.routing_v2_drip_send_claims dc
        set status = 'cancelled', cancel_reason = 'retired_by=' || p_inbound_message_id::text, cancelled_at = now()
        where dc.property_id = p_property_id and dc.status = 'open'
        returning dc.id
      ) select coalesce(array_agg(id), '{}') into v_cancelled_claims from cc;
    end if;

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
    elsif not v_drips then
      v_outcome := 'replies_only';  -- reply/alert intents only; no drip change
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
      if ((v_item->>'kind') = 'alert' or v_outcome in ('applied','replies_only','no_sequence'))
         and public.routing_v2_slice_enabled(p_property_id, coalesce(nullif(v_item->>'slice',''), 'replies')) then
        -- Each intent only when its own slice is on (drips on / replies off: enrollment only).
        insert into public.routing_v2_outbox (org_id, property_id, inbound_message_id, transition_seq, kind, engine, slice, payload)
        values (v_org, p_property_id, p_inbound_message_id, v_seq, v_item->>'kind', 'v2',
                coalesce(nullif(v_item->>'slice',''), 'replies'),
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
  if p_outcome not in ('sent','unknown','not_sent') then
    raise exception 'ROUTING_V2_BAD_CLAIM_OUTCOME: %', p_outcome;
  end if;
  if p_outcome = 'not_sent' then
    -- Provider definitely not reached (quiet hours, consent, suppression, no sender,
    -- authorization refused, not attempted / definitive reject): terminal, only from open.
    update public.routing_v2_drip_send_claims set status = 'not_sent'
    where step_run_id = p_step_run_id and status = 'open' and provider_outcome is null
    returning id into v_id;
    return v_id;
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

-- After an accepted v2 send: advance to the next step, or complete AND chain in the same
-- transaction (so a chain can never be lost after the completion committed). Returns
-- 'advanced' | 'completed' | 'chained' | 'changed' (enrollment no longer at that step).
create or replace function public.routing_v2_advance_after_send(
  p_enrollment_id uuid, p_step_index integer, p_step_run_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments;
  v_delay integer;
  v_claimed_at timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found then return 'changed'; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  -- The claim close (the provider accepted: 'sent') commits in the SAME transaction as the
  -- advance / completion; the live tick does not close a sent claim anywhere else.
  if p_step_run_id is not null then
    select created_at into v_claimed_at from public.routing_v2_drip_send_claims where step_run_id = p_step_run_id;
    perform public.routing_v2_mark_drip_claim_sent(p_step_run_id, 'sent');
  end if;
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  if e.status <> 'active' or e.current_step_index <> p_step_index then return 'changed'; end if;
  -- A seller message newer than the claim (classified or not, transitioned or not) decides
  -- what happens next: no advance / completion side effect.
  if exists (select 1 from public.messages m
             where m.property_id = e.property_id and m.direction = 'inbound'
               and m.created_at > coalesce(v_claimed_at, e.updated_at)) then
    return 'changed';
  end if;
  select delay_after_previous_minutes into v_delay from public.sequence_steps
  where sequence_id = e.sequence_id and step_index = p_step_index + 1;
  if found then
    update public.sequence_enrollments
    set current_step_index = p_step_index + 1, next_run_at = now() + make_interval(mins => v_delay), updated_at = now()
    where id = e.id;
    return 'advanced';
  end if;
  -- Plain completion: no automatic handoff at drip end (Master A-004), so nothing chains.
  update public.sequence_enrollments
  set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now()
  where id = e.id;
  return 'completed';
end;
$$;

-- Chain at the end of a v2 drip. Only when the finished sequence names routing_v2_then_key,
-- which NO seeded drip does (auto handoff at drip end is disabled pending Jarrad's decision,
-- Master A-004), so today this always returns null; then_key is changeable by migration only.
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
  v_origin_at timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if not found or e.routing_v2_engine is distinct from 'v2' then return null; end if;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || e.property_id::text));
  select * into e from public.sequence_enrollments where id = p_enrollment_id;
  if e.status <> 'completed' or e.ended_reason is not null then return null; end if;
  select routing_v2_then_key into v_then from public.sequences where id = e.sequence_id;
  if v_then is null then return null; end if;
  -- The seller replied after the reply that started this drip (newer inbound or a newer,
  -- non-superseded transition): that reply decides what happens next, never the chain.
  select created_at into v_origin_at from public.messages where id = e.routing_v2_inbound_id;
  if v_origin_at is null
     or exists (select 1 from public.messages m
                where m.property_id = e.property_id and m.direction = 'inbound'
                  and m.id <> e.routing_v2_inbound_id and m.created_at >= v_origin_at)
     or exists (select 1 from public.routing_v2_reply_transitions t
                where t.property_id = e.property_id and t.outcome <> 'superseded'
                  and t.inbound_message_id <> e.routing_v2_inbound_id and t.inbound_at >= v_origin_at) then
    return null;
  end if;
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
revoke all on function public.routing_v2_advance_after_send(uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_advance_after_send(uuid, integer, uuid) to service_role;
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
    ('book_appointment', 0, 1, 'any', $t$Hey, Mel here. Can we talk about {{property_address}} at {{slot_time}}?$t$),
    ('book_appointment', 1, 2, 'afternoon', $t$Hi {{first_name | there}}, can I hold {{slot_time}} for a call about {{property_address}}?$t$),
    ('book_appointment', 2, 4, 'morning', $t$Hey, Mel here. We're booked solid today, but I can squeeze you in at {{slot_time}} this morning. Should I put you down?$t$),
    ('book_appointment', 3, 5, 'afternoon', $t$Hi {{first_name | there}}, want to talk about {{property_address}} at {{slot_time}}?$t$),
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
  v_opt_out boolean;
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
        -- v2 drips are SMS-only (the v2 send path, check-and-claim and slot times exist only
        -- for send_sms). Never silently drop an approved non-SMS step: skip the version instead.
        if exists (select 1 from public.sequence_steps st
                   where st.sequence_id = v_src and st.action_type <> 'send_sms'
                     and (v_key = 'listed_not_selling' or st.step_index >= 6)) then
          raise notice 'routing v2 seed: org % existing % drip has non-SMS steps, version 2 skipped', r.org_id, v_key;
          continue;
        end if;
        -- v2 steps carry their text inline (the Templates UI must never edit or block a v2 drip):
        -- a template reference is inlined below; a template POOL (template_category) cannot be,
        -- nor a reference to a missing template, so that version is skipped instead.
        if exists (select 1 from public.sequence_steps st
                   left join public.sms_templates t on t.id = st.template_id and t.deleted_at is null
                   where st.sequence_id = v_src
                     and (v_key = 'listed_not_selling' or st.step_index >= 6)
                     and (st.template_category is not null
                          or (st.template_id is not null and t.id is null))) then
          raise notice 'routing v2 seed: org % existing % drip uses a template pool or missing template, version 2 skipped', r.org_id, v_key;
          continue;
        end if;
      end if;

      -- No automatic next drip when a v2 drip runs out (Master A-004 / Jarrad: "I'll decide what
      -- to do when the drip runs out"). The chain path stays inert: nothing to chain to.
      v_then := null;
      -- Opt-out footer: a new version of an existing drip keeps that drip's setting (never strip
      -- the footer where today's drip has it); the brand-new drips keep the approved no-footer.
      v_opt_out := coalesce((select append_opt_out from public.sequences where id = v_src), false);
      insert into public.sequences
        (org_id, name, description, active, append_opt_out, routing_v2_key, routing_v2_version, routing_v2_then_key)
      values
        (r.org_id, v_name,
         'Routing v2 drip (seeded inactive). Enrolled only by routing v2 when its drips flag is on.',
         false, v_opt_out, v_key, 1, v_then)
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
               st.action_type, coalesce(st.template_body, t.content), null::uuid, null::text, st.target_status,
               st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
        from public.sequence_steps st
        left join public.sms_templates t on t.id = st.template_id and t.deleted_at is null
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
                 st.action_type, coalesce(st.template_body, t.content) as template_body, null::uuid as template_id,
                 null::text as template_category, st.target_status,
                 st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
          from public.sequence_steps st
          left join public.sms_templates t on t.id = st.template_id and t.deleted_at is null
          where st.sequence_id = v_src
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
  if tg_table_name = 'sequence_steps' and tg_op <> 'DELETE' then
    -- Nested: NEW only has action_type on sequence_steps rows.
    if new.action_type <> 'send_sms'
       and exists (select 1 from public.sequences where id = new.sequence_id and routing_v2_key is not null) then
      raise exception using errcode = 'P0001',
        message = 'ROUTING_V2_DRIP_LOCKED: routing v2 drips are SMS-only';
    end if;
  end if;
  if coalesce(current_setting('routing_v2.allow_drip_edit', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'sequences' then
    -- An organization delete cascades here after the org row is gone: allowed (S6).
    if tg_op = 'DELETE' and not exists (select 1 from public.organizations o where o.id = old.org_id) then
      return old;
    end if;
    -- Every non-migration write to a v2 drip row is refused: metadata, active, archive /
    -- restore, delete, and turning a legacy drip into a v2 one (or creating one).
    if (tg_op in ('UPDATE','DELETE') and old.routing_v2_key is not null)
       or (tg_op in ('INSERT','UPDATE') and new.routing_v2_key is not null) then
      raise exception using errcode = 'P0001',
        message = 'ROUTING_V2_DRIP_LOCKED: routing v2 drips are edited by migration only';
    end if;
    return case when tg_op = 'DELETE' then old else new end;
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
create trigger routing_v2_reject_drip_edit before insert or update or delete on public.sequences
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
  -- A v2 row can never lose its engine (whatever else the update changes).
  if tg_op = 'UPDATE' and old.routing_v2_engine = 'v2' and new.routing_v2_engine is distinct from 'v2' then
    raise exception using errcode = 'P0001',
      message = 'ROUTING_V2_DRIP_LOCKED: a routing v2 enrollment cannot drop its engine';
  end if;
  -- A v2-marked row (new, or re-marked / re-pointed) must come from routing_v2_enroll: the
  -- caller must BE the definer's owner role (current_user inside the SECURITY DEFINER
  -- function; never anon / authenticated / service_role) AND the function's transaction-local
  -- marker must be set. A caller can set the marker but cannot become the owner.
  if new.routing_v2_engine = 'v2'
     and (coalesce(current_setting('routing_v2.enrolling', true), '') <> 'on'
          or current_user::text is distinct from (
            select pg_get_userbyid(p.proowner)::text from pg_proc p
            where p.oid = 'public.routing_v2_enroll(uuid,uuid,uuid,uuid,uuid)'::regprocedure)) then
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
do $$
begin
  if (select pg_get_userbyid(p.proowner) from pg_proc p
      where p.oid = 'public.routing_v2_enroll(uuid,uuid,uuid,uuid,uuid)'::regprocedure)
     in ('anon','authenticated','service_role') then
    raise exception 'routing_v2_enroll must not be owned by an API role';
  end if;
end $$;
drop trigger if exists routing_v2_reject_foreign_enrollment on public.sequence_enrollments;
create trigger routing_v2_reject_foreign_enrollment before insert or update of sequence_id, routing_v2_engine, routing_v2_inbound_id on public.sequence_enrollments
  for each row execute function public.routing_v2_reject_foreign_enrollment();

drop trigger if exists routing_v2_reject_drip_step_edit on public.sequence_steps;
create trigger routing_v2_reject_drip_step_edit before insert or update or delete on public.sequence_steps
  for each row execute function public.routing_v2_reject_drip_edit();

-- ---------------------------------------------------------------------------
-- 8. Flag-off rollback (BUILD-PLAN 13.3). Runs at the start of every sequence-tick: stops every
--    active/paused v2 enrollment whose property no longer has the drips slice (DNC-locked rows
--    take the compliance opt-out), and cancels pending outbox rows whose slice is off. After
--    it runs nothing v2 blocks the legacy engine (one live drip per property).
-- ---------------------------------------------------------------------------
create or replace function public.routing_v2_stop_disabled()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_stopped integer := 0;
  v_opted_out integer := 0;
  v_outbox integer := 0;
  v_n integer;
begin
  for r in
    select distinct e.property_id from public.sequence_enrollments e
    where e.routing_v2_engine = 'v2' and e.status in ('active','paused')
      and not public.routing_v2_slice_enabled(e.property_id, 'drips')
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
    if public.routing_v2_slice_enabled(r.property_id, 'drips') then continue; end if;
    if coalesce((select is_dnc_locked from public.properties where id = r.property_id), false) then
      update public.sequence_enrollments
      set status = 'opted_out', pause_reason = 'dnc', next_run_at = null, updated_at = now()
      where property_id = r.property_id and routing_v2_engine = 'v2' and status in ('active','paused');
      get diagnostics v_n = row_count; v_opted_out := v_opted_out + v_n;
    else
      update public.sequence_enrollments
      set status = 'completed', completed_at = now(), next_run_at = null, updated_at = now(), ended_reason = 'flag_off'
      where property_id = r.property_id and routing_v2_engine = 'v2' and status in ('active','paused');
      get diagnostics v_n = row_count; v_stopped := v_stopped + v_n;
    end if;
    update public.routing_v2_drip_send_claims set status = 'cancelled', cancel_reason = 'flag_off', cancelled_at = now()
    where property_id = r.property_id and status = 'open';
  end loop;

  for r in
    select o.id, o.property_id from public.routing_v2_outbox o
    where o.status = 'pending' and not public.routing_v2_slice_enabled(o.property_id, o.slice)
    order by o.property_id
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
    update public.routing_v2_outbox set status = 'cancelled', cancel_reason = 'flag_off'
    where id = r.id and status = 'pending' and not public.routing_v2_slice_enabled(property_id, slice);
    get diagnostics v_n = row_count; v_outbox := v_outbox + v_n;
  end loop;

  return jsonb_build_object('enrollments_stopped', v_stopped, 'enrollments_opted_out', v_opted_out,
                            'outbox_cancelled', v_outbox);
end;
$$;
revoke all on function public.routing_v2_stop_disabled() from public, anon, authenticated;
grant execute on function public.routing_v2_stop_disabled() to service_role;

-- Durable claim reconcile (runs at the start of every tick): an open claim older than
-- p_older_than whose step run reached the provider is closed with the truth from the step run
-- (accepted -> sent, unknown -> unknown; anything else -> not_sent) and stamped reconciled_at.
-- Covers a crash / RPC error between the provider call and the claim close.
alter table public.routing_v2_drip_send_claims add column if not exists reconciled_at timestamptz;
-- R5: provider acceptance recorded on the claim itself, in its own small write right after the
-- provider returns (before the step-run write), so it can't be lost with that write.
alter table public.routing_v2_drip_send_claims
  add column if not exists provider_outcome text check (provider_outcome is null or provider_outcome in ('accepted','unknown')),
  add column if not exists provider_message_id uuid,
  add column if not exists provider_recorded_at timestamptz;

create or replace function public.routing_v2_record_provider_outcome(p_step_run_id uuid, p_outcome text, p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_outcome not in ('accepted','unknown') then
    raise exception 'ROUTING_V2_BAD_PROVIDER_OUTCOME: %', p_outcome;
  end if;
  update public.routing_v2_drip_send_claims
  set provider_outcome = case when provider_outcome = 'accepted' then 'accepted' else p_outcome end,
      provider_message_id = coalesce(p_message_id, provider_message_id),
      provider_recorded_at = coalesce(provider_recorded_at, now())
  where step_run_id = p_step_run_id;
  return found;
end;
$$;
revoke all on function public.routing_v2_record_provider_outcome(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.routing_v2_record_provider_outcome(uuid, text, uuid) to service_role;
create or replace function public.routing_v2_reconcile_claims(p_older_than interval default interval '10 minutes')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_status text;
  v_sent integer := 0;
  v_unknown integer := 0;
  v_not_sent integer := 0;
begin
  for r in
    select c.id, c.property_id, c.step_run_id, c.provider_outcome, sr.attempt_outcome, sr.message_id
    from public.routing_v2_drip_send_claims c
    left join public.sequence_step_runs sr on sr.id = c.step_run_id
    where c.status = 'open' and c.created_at < now() - p_older_than
    order by c.property_id, c.created_at
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || r.property_id::text));
    -- The claim's own provider record wins; not_sent only with no evidence of an attempt at all.
    v_status := case
      when r.provider_outcome = 'accepted' or r.attempt_outcome = 'accepted' then 'sent'
      when r.provider_outcome = 'unknown' or r.attempt_outcome = 'unknown' or r.message_id is not null
           or r.attempt_outcome is null then 'unknown'
      else 'not_sent' end;
    update public.routing_v2_drip_send_claims
    set status = v_status, reconciled_at = now()
    where id = r.id and status = 'open';
    if found then
      if v_status = 'sent' then v_sent := v_sent + 1;
      elsif v_status = 'unknown' then v_unknown := v_unknown + 1;
      else v_not_sent := v_not_sent + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('sent', v_sent, 'unknown', v_unknown, 'not_sent', v_not_sent);
end;
$$;
revoke all on function public.routing_v2_reconcile_claims(interval) from public, anon, authenticated;
grant execute on function public.routing_v2_reconcile_claims(interval) to service_role;

-- R5: resume never treats an accepted/unknown v2 drip send as a no-attempt. Same body as
-- 20261008143600 plus the routing v2 block (accepted -> advance past the step; unknown -> refuse).
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
  v2_status text;
  v2_provider text;
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
  -- consent_unavailable is deliberately NOT in this list: the tick retired the
  -- claim as not_attempted before pausing (no text was attempted), so a plain
  -- resume is the correct and only recovery.
  -- Routing v2 (R5): the drip send claim is the durable record of provider acceptance.
  -- Accepted -> advance past the step (never a second send of it); unknown -> refuse.
  if e.routing_v2_engine = 'v2' then
    select * into s from public.sequence_steps
     where sequence_id = e.sequence_id and step_index = e.current_step_index;
    select sr.* into r from public.sequence_step_runs sr
     where sr.enrollment_id = e.id and sr.step_id = s.id and sr.claim_active
     order by sr.created_at desc limit 1
     for update;
    if r.id is not null then
      select c.status, c.provider_outcome into v2_status, v2_provider
        from public.routing_v2_drip_send_claims c where c.step_run_id = r.id;
      if v2_status = 'sent' or v2_provider = 'accepted' or r.attempt_outcome = 'accepted' then
        update public.sequence_step_runs
           set attempt_outcome = 'accepted', run_at = coalesce(run_at, now()),
               recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid()),
               recovery_action = 'resume_advanced_v2',
               recovery_evidence = 'routing v2 claim records provider acceptance'
         where id = r.id;
        update public.routing_v2_drip_send_claims set status = 'sent' where step_run_id = r.id and status <> 'sent';
        select * into s from public.sequence_steps
         where sequence_id = e.sequence_id and step_index = e.current_step_index + 1;
        if s.id is null then
          update public.sequence_enrollments
             set status = 'completed', completed_at = now(), pause_reason = null, next_run_at = null, updated_at = now()
           where id = e.id and status = 'paused';
          return query select 'resumed', null::timestamptz;
          return;
        end if;
        next_at := now() + make_interval(mins => s.delay_after_previous_minutes);
        update public.sequence_enrollments
           set status = 'active', pause_reason = null, current_step_index = e.current_step_index + 1,
               next_run_at = next_at, updated_at = now()
         where id = e.id and status = 'paused';
        return query select 'resumed', next_at;
        return;
      end if;
      if v2_status = 'unknown' or v2_provider = 'unknown' or r.attempt_outcome = 'unknown' or r.message_id is not null then
        return query select 'reconciliation_required', e.next_run_at;
        return;
      end if;
    end if;
    s := null;
    r := null;
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

  -- A new consent-check budget starts at every resume: relabel this
  -- enrollment's deferred consent_unavailable rows so the tick's consecutive
  -- count (which counts only 'consent_unavailable_deferred') ignores them.
  update public.sequence_step_runs
     set recovery_action = 'consent_unavailable_resumed'
   where enrollment_id = e.id
     and recovery_action = 'consent_unavailable_deferred';

  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = next_at, updated_at = now()
   where id = e.id and status = 'paused';
  return query select 'resumed', next_at;
end;
$$;

revoke all on function public.resume_sequence_enrollment(uuid, uuid, text) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. v2 drips are never a copy source (their {{slot_time}} has no value outside v2). Same body
--    as 20261021200400 plus the source check.
-- ---------------------------------------------------------------------------
create or replace function public.sequence_copy_steps(p_target uuid, p_source uuid)
returns integer
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
declare
  target_org uuid;
  copied integer;
begin
  if p_target is null or p_source is null or p_target = p_source or auth.uid() is null
  then raise exception 'INVALID_SEQUENCE' using errcode = '22023'; end if;
  if exists (select 1 from public.sequences s where s.id = p_source and s.routing_v2_key is not null)
  then raise exception 'ROUTING_V2_DRIP_LOCKED: routing v2 drips cannot be copied' using errcode = 'P0001'; end if;
  -- The target row lock serializes concurrent copy attempts.
  select s.org_id into target_org from public.sequences s where s.id = p_target for update;
  if target_org is null or not exists (
    select 1 from public.memberships m where m.org_id = target_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.sequences s where s.id = p_source and s.org_id = target_org)
  then raise exception 'SOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.sequence_steps where sequence_id = p_target
  ) then raise exception 'TARGET_NOT_EMPTY' using errcode = '23514'; end if;
  if not exists (select 1 from public.sequence_steps where sequence_id = p_source)
  then raise exception 'SOURCE_EMPTY' using errcode = '23514'; end if;

  insert into public.sequence_steps (sequence_id, step_index, delay_after_previous_minutes,
    action_type, template_body, template_id, template_category, target_status,
    vm_media_id, vm_tts_body, vm_voice_id, vm_phone_line_id, vm_template_category)
  select p_target, st.step_index, st.delay_after_previous_minutes,
    st.action_type, st.template_body, st.template_id, st.template_category, st.target_status,
    st.vm_media_id, st.vm_tts_body, st.vm_voice_id, st.vm_phone_line_id, st.vm_template_category
  from public.sequence_steps st where st.sequence_id = p_source order by st.step_index;
  get diagnostics copied = row_count;
  return copied;
end;
$$;
revoke all on function public.sequence_copy_steps(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_copy_steps(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Needs person: the routing v2 'timezone_unconfirmed' hold (seller time zone could not be
--     confirmed for a booking text) lands in "Couldn't send". Same body as 20260929239000 with
--     that one reason added.
-- ---------------------------------------------------------------------------
create or replace function public.sequence_needs_person(p_org uuid)
returns table (property_id uuid, sequence_id uuid, bucket text, reason text, sequence_created_by uuid)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  with latest_enrollments as (
    select distinct on (e.property_id) e.*
    from public.sequence_enrollments e
    where e.org_id = p_org
    order by e.property_id, e.enrolled_at desc, e.id desc
  ), candidates as (
    select e.property_id, e.sequence_id, 'finished_no_reply'::text as bucket,
      'Finished, no reply'::text as reason, 1 as priority
    from latest_enrollments e
    where e.status = 'completed'
      and not exists (select 1 from public.lead_events le where le.org_id = p_org
        and le.property_id = e.property_id and le.event_type = 'sequence_canceled'
        and le.source_id = e.id)
      and not exists (select 1 from public.messages msg where msg.org_id = p_org
        and msg.property_id = e.property_id and msg.direction = 'inbound'
        and msg.created_at > coalesce((select max(coalesce(sent.sent_at, sr.run_at)) from public.sequence_step_runs sr
          left join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
          where sr.enrollment_id = e.id and sr.message_id is not null), e.enrolled_at))
    union all
    select e.property_id, e.sequence_id, 'couldnt_send'::text, 'Couldn''t send'::text, 2
    from latest_enrollments e where e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required','template_missing','step_misconfigured','no_phone','no_approved_sender','no approved sender for first-touch sequence send','timezone_unconfirmed')
    union all
    select p.id, null::uuid, 'needs_sequence'::text, 'Needs a sequence'::text, 3
    from public.properties p where p.org_id = p_org and p.outreach_dispo = 'needs_sequence'
      and p.deleted_at is null and p.is_dnc_locked is not true
      and exists (select 1 from public.messages inbound where inbound.org_id = p_org
        and inbound.property_id = p.id and inbound.direction = 'inbound')
      and not exists (select 1 from latest_enrollments e
        where e.property_id = p.id and e.status in ('active','paused'))
  )
  select distinct on (c.property_id) c.property_id, c.sequence_id, c.bucket, c.reason, s.created_by
  from candidates c join public.properties p on p.id = c.property_id and p.org_id = p_org
  left join public.sequences s on s.id = c.sequence_id and s.org_id = p_org
  where p.deleted_at is null and p.status <> 'dead'
  order by c.property_id, c.priority;
end;
$$;
revoke all on function public.sequence_needs_person(uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Inbound calls do not pause routing v2 drips (Jarrad: "Incoming calls should not pause
--    drips"). Same function as 20261021200300 with v2 enrollments excluded; legacy rows keep
--    the exact previous behaviour.
-- ---------------------------------------------------------------------------
create or replace function public.pause_enrollments_for_inbound_call(p_contact_ids uuid[])
returns table (id uuid, property_id uuid, sequence_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  update public.sequence_enrollments e
     set status = 'paused', pause_reason = 'inbound_call', updated_at = now()
   where e.property_id in (
           select pr.id from public.properties pr where pr.homeowner_contact_id = any(p_contact_ids)
         )
     and e.routing_v2_engine is distinct from 'v2'
     and (e.status = 'active'
          or (e.status = 'paused'
              and e.pause_reason in ('reconciliation_required', 'call_in_progress', 'norma_call')))
  returning e.id, e.property_id, e.sequence_id;
end;
$$;
revoke all on function public.pause_enrollments_for_inbound_call(uuid[]) from public, anon, authenticated;
grant execute on function public.pause_enrollments_for_inbound_call(uuid[]) to service_role;

comment on column public.sequences.routing_v2_key is
  'Routing v2 drip identity (PR-C). Null for every pre-existing / human-made drip.';
comment on column public.sequence_steps.slot_window is
  'Routing v2 booking steps: window for the {{slot_time}} computed at send (any/morning/afternoon).';
comment on column public.sequence_enrollments.routing_v2_engine is
  'v2 = created by routing v2 (route_reply_transition / chain). Null for every legacy enrollment.';

commit;
