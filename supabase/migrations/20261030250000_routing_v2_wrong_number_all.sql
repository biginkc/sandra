-- SMS reply routing v2, PR-G: automatic wrong number for every property on a phone, and the
-- "no SMS capabilities" bounce marking the number bad. Behind routing_v2_flags.wrong_number_all
-- AND questions_live (both default false). Nothing calls these functions until the cutover PR
-- wires them; with the flags off they write nothing.
--
-- Design (Codex r2 consolidation):
--   A. fn_routing_v2_phone_action_apply_all: ONE transaction under a phone-level advisory lock
--      plus row locks (properties, the phone's contacts / contact_phone_numbers rows, any
--      sms_phone_suppressions rows). It re-reads flags + canary (SQL twin of flags.ts, fail
--      closed), checks suppression/DNC, requires this inbound to be the NEWEST inbound from the
--      phone across every property, applies the disposition, pauses the drips (ids recorded),
--      writes every audit row with prior state and marks the action applied with a durable
--      send id. All or nothing: an error rolls everything back and the call is retryable.
--   B. The approved reply is sent AFTER A commits, keyed by the send id (stored on the outbound
--      message as messages.idempotency_key). Recovery matches by that key only.
--   C. Undo: one transaction under the same phone lock; restores only properties whose state
--      still equals what A left, refuses while the phone is suppressed, and resumes exactly
--      the recorded enrollment ids (resume_sequence_enrollment re-checks each one).
--
-- Never writes contacts, consent or sms_phone_suppressions. A non-source property whose
-- homeowner contact also has a different phone is skipped (that phone stays reachable); the
-- landed property is closed exactly as today's single-property path does.
--
-- Rollback: supabase/rollbacks/20261030250000_routing_v2_wrong_number_all.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.routing_v2_phone_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_property_id uuid not null references public.properties(id) on delete cascade,
  source_inbound_message_id uuid not null references public.messages(id) on delete cascade,
  action text not null check (action in ('wrong_number_all', 'bad_number')),
  phone_e164 text not null,
  -- A row exists only once A committed: applied, or undone by a person.
  status text not null check (status in ('applied', 'undone')),
  property_ids uuid[] not null default '{}',
  -- Reply (B). awaiting_fence: held until fence_at, then re-checked for a newer inbound.
  -- pending: never attempted. sending: handed to the provider boundary, outcome
  -- not yet recorded. sent/failed/unknown/skipped/not_needed: final.
  reply_state text not null check (reply_state in ('awaiting_fence', 'pending', 'sending', 'sent', 'failed', 'unknown', 'skipped', 'not_needed')),
  -- Post-commit fence: the reply is released no earlier than this (applied + 10 s).
  fence_at timestamptz,
  send_id uuid not null default gen_random_uuid(),
  reply_message_id uuid,
  reply_reason text,
  reply_updated_at timestamptz,
  -- When the reply entered `sending` (handed to the provider boundary). Recovery may not touch
  -- a `sending` row until this is older than the provider-timeout lease (120 s).
  sending_at timestamptz,
  decision jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  constraint routing_v2_phone_actions_undone_pair check (undone_by is null or undone_at is not null),
  constraint routing_v2_phone_actions_undone_shape check ((status = 'undone') = (undone_at is not null)),
  constraint routing_v2_phone_actions_fence_shape check (reply_state <> 'awaiting_fence' or fence_at is not null),
  constraint routing_v2_phone_actions_sending_shape check (reply_state <> 'sending' or sending_at is not null)
);
comment on table public.routing_v2_phone_actions is
  'Routing v2 PR-G: one row per source inbound whose phone-level action (wrong_number_all, bad_number) committed. Unique per inbound = duplicate webhooks replay.';

create unique index if not exists routing_v2_phone_actions_inbound_uidx
  on public.routing_v2_phone_actions (source_inbound_message_id);
create unique index if not exists routing_v2_phone_actions_send_id_uidx
  on public.routing_v2_phone_actions (send_id);
create index if not exists routing_v2_phone_actions_org_created_idx
  on public.routing_v2_phone_actions (org_id, created_at desc);
create index if not exists routing_v2_phone_actions_unsettled_idx
  on public.routing_v2_phone_actions (created_at)
  where reply_state in ('awaiting_fence', 'pending', 'sending');

create table if not exists public.routing_v2_phone_action_properties (
  id uuid primary key default gen_random_uuid(),
  action_id uuid not null references public.routing_v2_phone_actions(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  is_source boolean not null default false,
  outcome text not null check (outcome in ('applied', 'skipped')),
  skip_reason text,
  applied_dispo text,
  prior_outreach_dispo text,
  prior_follow_up_at timestamptz,
  applied_follow_up_at timestamptz,
  recorded_revision bigint,
  paused_enrollment_ids uuid[] not null default '{}',
  -- The exact updated_at A stamped on the enrollments it paused (with routing_v2_pause_token).
  paused_at timestamptz,
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint routing_v2_phone_action_properties_outcome_shape check (
    (outcome = 'applied' and applied_dispo is not null and skip_reason is null)
    or (outcome = 'skipped' and applied_dispo is null and skip_reason is not null)
  ),
  constraint routing_v2_phone_action_properties_undone_pair check (undone_by is null or undone_at is not null),
  constraint routing_v2_phone_action_properties_paused_shape check ((cardinality(paused_enrollment_ids) = 0) = (paused_at is null))
);
comment on table public.routing_v2_phone_action_properties is
  'Routing v2 PR-G audit + undo: one row per target property (applied with its exact prior state and the drips it paused, or skipped with the reason).';

create unique index if not exists routing_v2_phone_action_properties_uidx
  on public.routing_v2_phone_action_properties (action_id, property_id);
create index if not exists routing_v2_phone_action_properties_property_idx
  on public.routing_v2_phone_action_properties (property_id, created_at desc);

-- Pause token on enrollments: set only by A, cleared when a later change moves the row back
-- to active or to a different pause (a person resuming, a later re-pause), so undo can tell its
-- own pause from a later one with the same reason. Inert (NULL) for every row A never paused.
-- It NEVER touches a row whose new status is anything else (opted_out / completed): a global-
-- DNC or other compliance transition must see no extra column change (the DNC lock guard in
-- 20260830092331 rejects any change beyond status/pause_reason/next_run_at/updated_at). A stale
-- token on such a row is harmless: undo only resumes rows still paused for inbound_reply with
-- this action's token AND exactly A's paused_at.
alter table public.sequence_enrollments add column if not exists routing_v2_pause_token uuid;
comment on column public.sequence_enrollments.routing_v2_pause_token is
  'Routing v2 PR-G: id of the phone action that paused this enrollment; cleared when the row later goes back to active or to another pause. Never changed by a transition to opted_out/completed.';
create or replace function public.routing_v2_clear_pause_token()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.routing_v2_pause_token is not null
     and new.routing_v2_pause_token is not distinct from old.routing_v2_pause_token
     and new.status in ('active', 'paused')
     and (new.status is distinct from old.status or new.pause_reason is distinct from old.pause_reason) then
    new.routing_v2_pause_token := null;
  end if;
  return new;
end;
$$;
revoke all on function public.routing_v2_clear_pause_token() from public, anon, authenticated, service_role;
drop trigger if exists trg_sequence_enrollments_routing_v2_pause_token on public.sequence_enrollments;
create trigger trg_sequence_enrollments_routing_v2_pause_token
  before update of status, pause_reason on public.sequence_enrollments
  for each row when (old.routing_v2_pause_token is not null and new.status in ('active', 'paused'))
  execute function public.routing_v2_clear_pause_token();

-- Provenance guard (PR-C's pattern, 20261030181000): nobody but A may SET a pause token. A
-- non-null token that differs from OLD is accepted only when current_user is the owner role of
-- PR-G's SECURITY DEFINER functions AND A's transaction-local marker routing_v2.pausing = 'on'
-- is set (a caller can set the marker but cannot become the owner). Clearing a token is always
-- allowed (it only takes away undo's ability to resume), so the clear-on-resume trigger, a
-- person's resume and any DNC/compliance transition never trip it; an opt-out leaves the token
-- untouched (r12).
create or replace function public.routing_v2_pause_token_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.routing_v2_pause_token is not null
     and (tg_op = 'INSERT' or new.routing_v2_pause_token is distinct from old.routing_v2_pause_token)
     and (coalesce(current_setting('routing_v2.pausing', true), '') <> 'on'
          or current_user::text is distinct from (
            select pg_get_userbyid(p.proowner)::text from pg_proc p
            where p.oid = 'public.fn_routing_v2_phone_action_apply_all(uuid,text,text,jsonb,bigint)'::regprocedure)) then
    raise exception using errcode = 'P0001',
      message = 'ROUTING_V2_PAUSE_TOKEN_LOCKED: only the routing v2 phone action sets a pause token';
  end if;
  return new;
end;
$$;
revoke all on function public.routing_v2_pause_token_guard() from public, anon, authenticated, service_role;
drop trigger if exists trg_sequence_enrollments_routing_v2_pause_token_guard_ins on public.sequence_enrollments;
create trigger trg_sequence_enrollments_routing_v2_pause_token_guard_ins
  before insert on public.sequence_enrollments
  for each row when (new.routing_v2_pause_token is not null)
  execute function public.routing_v2_pause_token_guard();
drop trigger if exists trg_sequence_enrollments_routing_v2_pause_token_guard_upd on public.sequence_enrollments;
create trigger trg_sequence_enrollments_routing_v2_pause_token_guard_upd
  before update on public.sequence_enrollments
  for each row when (new.routing_v2_pause_token is not null and new.routing_v2_pause_token is distinct from old.routing_v2_pause_token)
  execute function public.routing_v2_pause_token_guard();

alter table public.routing_v2_phone_actions enable row level security;
alter table public.routing_v2_phone_action_properties enable row level security;
revoke all on public.routing_v2_phone_actions from public, anon, authenticated, service_role;
revoke all on public.routing_v2_phone_action_properties from public, anon, authenticated, service_role;
-- Reads only; every write goes through the functions below.
grant select on public.routing_v2_phone_actions to authenticated, service_role;
grant select on public.routing_v2_phone_action_properties to authenticated, service_role;

drop policy if exists routing_v2_phone_actions_org_select on public.routing_v2_phone_actions;
create policy routing_v2_phone_actions_org_select on public.routing_v2_phone_actions
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and org_id in (select public.pipeline_runs_readable_org_ids()));
drop policy if exists routing_v2_phone_action_properties_org_select on public.routing_v2_phone_action_properties;
create policy routing_v2_phone_action_properties_org_select on public.routing_v2_phone_action_properties
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id) and org_id in (select public.pipeline_runs_readable_org_ids()));

-- §13.1, the SQL twin of isV2Eligible(parseRoutingV2Flags(flags), id) in
-- src/lib/sms-classification/routing-v2/flags.ts (pinned to it by the integration test):
--   * canary_property_ids: absent, or an array whose every entry is a UUID string; anything
--     else (null, non-array, one bad entry) = nothing eligible (fail closed);
--   * canary_percent: absent, or an integer JSON number 0..100; anything else = nothing eligible;
--   * eligible = id listed (case-insensitive) OR sha256(lower(id)) first 4 bytes (uint32 BE) % 100 < percent.
create or replace function public.routing_v2_phone_action_eligible(p_flags jsonb, p_property_id uuid)
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
revoke all on function public.routing_v2_phone_action_eligible(jsonb, uuid) from public, anon, authenticated;

create or replace function public.routing_v2_phone_digits(p_phone text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10); $$;
revoke all on function public.routing_v2_phone_digits(text) from public, anon, authenticated;


-- Phone-level lock shared by apply_all and undo.
create or replace function public.routing_v2_phone_lock(p_org_id uuid, p_phone text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$ select pg_advisory_xact_lock(hashtext('routing_v2_phone:' || p_org_id::text || ':' || public.routing_v2_phone_digits(p_phone))); $$;
revoke all on function public.routing_v2_phone_lock(uuid, text) from public, anon, authenticated, service_role;

-- Any inbound from the action's phone (any property) newer than its trigger inbound.
create or replace function public.routing_v2_phone_action_newer_inbound(p_action_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.id
  from public.routing_v2_phone_actions a
  join public.messages t on t.id = a.source_inbound_message_id
  join public.messages m
    on m.created_at >= t.created_at
   and m.org_id = a.org_id and m.channel = 'sms' and m.direction = 'inbound'
   and m.id <> t.id
   and public.routing_v2_phone_digits(m.from_address) = public.routing_v2_phone_digits(a.phone_e164)
   and (m.created_at > t.created_at or m.id > t.id)
  where a.id = p_action_id
  order by m.created_at
  limit 1;
$$;
revoke all on function public.routing_v2_phone_action_newer_inbound(uuid) from public, anon, authenticated, service_role;

-- A newer inbound raced the reply: skip it, put the source property on the EXISTING
-- needs-person hold (nine_needs_person, the fields markPropertyNeedsAttention writes; an
-- existing hold is left alone) and audit p_event. Properties are otherwise left exactly as A
-- left them. Caller holds the global-DNC barrier, the phone lock and the action row lock.
create or replace function public.routing_v2_phone_action_hold_superseded(p_action_id uuid, p_newer uuid, p_event text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_held boolean;
begin
  if p_event not in ('superseded_after_commit', 'superseded_before_send') then
    raise exception 'unsupported event: %', p_event using errcode = '22023';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  update public.routing_v2_phone_actions
  set reply_state = 'skipped', reply_reason = p_event, reply_updated_at = now()
  where id = v.id;
  perform pg_advisory_xact_lock(hashtext('routing_v2:' || v.source_property_id::text));
  update public.properties
  set needs_human_attention = true, last_ai_escalation_reason = 'nine_needs_person',
      last_ai_escalation_at = now(), updated_at = now()
  -- A DNC-locked property (e.g. a manual contact do_not_contact) is never written (the DNC
  -- lock guard would reject it and the settler would retry forever): the reply is still
  -- skipped and audited, just without the hold.
  where id = v.source_property_id and org_id = v.org_id and needs_human_attention = false and is_dnc_locked = false;
  v_held := found;
  insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
  values (v.org_id, v.source_property_id, 'system', 'routing_v2_phone_action_' || p_event,
    jsonb_build_object('phone_action_id', v.id, 'newer_inbound_message_id', p_newer, 'hold_set', v_held,
      'hold_reason', 'nine_needs_person'));
  return v_held;
end;
$$;
revoke all on function public.routing_v2_phone_action_hold_superseded(uuid, uuid, text) from public, anon, authenticated, service_role;

-- PR-G's own approved reply is one outbound SMS row on the source property, and the existing
-- message trigger (trg_messages_bump_decision_context_revision) moves that property's
-- decision_context_revision by exactly one. When the reply is recorded `sent` (normal or
-- recovery path, matched by send_id), re-stamp the source row's applied revision so undo's
-- unchanged revision check still works. Only when the bump provably came from that message
-- alone: the message is ours (this send_id, the source property, outbound SMS), the property
-- is not DNC-locked, and the revision moved by exactly one since A. Anything else = no
-- re-stamp, and undo keeps refusing. Caller holds the phone lock and the action row lock.
create or replace function public.routing_v2_phone_action_restamp_after_reply(p_action_id uuid, p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_row public.routing_v2_phone_action_properties%rowtype;
  v_rev bigint;
  v_locked boolean;
begin
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  if not found or p_message_id is null then
    return false;
  end if;
  if not exists (
    select 1 from public.messages m
    where m.id = p_message_id and m.org_id = v.org_id and m.property_id = v.source_property_id
      and m.channel = 'sms' and m.direction = 'outbound' and m.idempotency_key = v.send_id
  ) then
    return false;
  end if;
  select * into v_row from public.routing_v2_phone_action_properties
  where action_id = v.id and property_id = v.source_property_id and outcome = 'applied' and undone_at is null;
  if not found then
    return false;
  end if;
  select p.decision_context_revision, p.is_dnc_locked into v_rev, v_locked
  from public.properties p where p.id = v.source_property_id and p.org_id = v.org_id;
  if v_locked or v_rev is distinct from v_row.recorded_revision + 1 then
    return false;
  end if;
  update public.routing_v2_phone_action_properties set recorded_revision = v_rev where id = v_row.id;
  return true;
end;
$$;
revoke all on function public.routing_v2_phone_action_restamp_after_reply(uuid, uuid) from public, anon, authenticated, service_role;

-- A. The whole action except the SMS, in one transaction.
create or replace function public.fn_routing_v2_phone_action_apply_all(
  p_source_inbound_message_id uuid,
  p_action text,
  p_phone text,
  p_decision jsonb default '{}'::jsonb,
  -- The decision_context_revision the v2 decision was made against (optional).
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_existing public.routing_v2_phone_actions%rowtype;
  v_flags jsonb;
  v_dispo text := case p_action when 'wrong_number_all' then 'wrong_number' else 'bad_number' end;
  v_digits text := public.routing_v2_phone_digits(p_phone);
  v_ids uuid[];
  v_id uuid;
  v_action_id uuid;
  v_send_id uuid;
  r record;
  v_reason text;
  v_source_reason text;
  v_paused uuid[];
  v_after record;
  v_row_id uuid;
  v_applied uuid[] := '{}';
  v_skipped jsonb := '[]'::jsonb;
  v_skips jsonb := '{}'::jsonb;
  v_dec record;
  v_contacts uuid[];
  v_pause_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_action not in ('wrong_number_all', 'bad_number') then
    raise exception 'unsupported routing v2 phone action: %', p_action using errcode = '22023';
  end if;
  -- The decision's revision is required: without it A cannot prove the decision is current.
  if p_expected_revision is null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'expected_revision_required');
  end if;

  select m.id, m.org_id, m.property_id, m.from_address, m.created_at, m.body
  into v_message
  from public.messages m
  where m.id = p_source_inbound_message_id and m.channel = 'sms' and m.direction = 'inbound';
  if not found or v_message.property_id is null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_message_missing');
  end if;
  if coalesce(p_phone, '') !~ '^\+1[0-9]{10}$' or v_digits <> public.routing_v2_phone_digits(v_message.from_address) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'phone_mismatch');
  end if;

  -- Never trust the caller's description of the decision: re-derive it from the persisted
  -- v2 decision for THIS inbound (routing_v2_shadow_decisions, PR-A/PR-D). Only the scope is a
  -- caller input (the v2 question set has no scope question; the cutover PR supplies it).
  select d.road, d.provenance, d.haiku_eligibility, d.haiku
  into v_dec
  from public.routing_v2_shadow_decisions d
  where d.inbound_message_id = p_source_inbound_message_id
    and d.org_id = v_message.org_id and d.property_id = v_message.property_id
    and d.status = 'decided';
  if not found then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'no_decision_record');
  end if;
  if p_action = 'wrong_number_all' then
    -- ORDER-TABLE: a Jev wrong-person answer >= 0.60 is the road; in the 0.50-0.70 band Haiku
    -- decides, and if Haiku is unsure Jev's road stands (applyHaikuPolicy final_road).
    if v_dec.road is distinct from 'wrong_number_close'
       or v_dec.provenance->>'by' is distinct from 'jev'
       or v_dec.provenance->>'signal' is distinct from 'wrong_person'
       or jsonb_typeof(v_dec.provenance->'probability') is distinct from 'number'
       or (v_dec.provenance->>'probability')::numeric < 0.6 then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'decision_not_wrong_person');
    end if;
    if v_dec.haiku_eligibility is not null and (
         v_dec.haiku is null
      or jsonb_typeof(v_dec.haiku->'hold') is distinct from 'boolean'
      or (v_dec.haiku->>'hold')::boolean
      or v_dec.haiku->>'final_road' is distinct from 'wrong_number_close'
    ) then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'haiku_not_confirmed');
    end if;
    if coalesce(p_decision->>'wrong_scope', '') <> 'all' then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'scope_not_all');
    end if;
  else
    -- The bounce code check (PR-A route.ts codePreCheck) recorded on the decision, and the
    -- inbound text itself still matches that detector.
    if v_dec.road is distinct from 'bad_number'
       or v_dec.provenance->>'by' is distinct from 'code'
       or v_dec.provenance->>'check' is distinct from 'bad_number'
       or coalesce(v_message.body, '') !~* '(no sms capabilit|unable to receive)' then
      return jsonb_build_object('status', 'not_applicable', 'reason', 'decision_not_bounce');
    end if;
  end if;

  -- Global-DNC write barrier (20260830092331), SHARED, before any phone/contact/property lock:
  -- the global-DNC path takes it EXCLUSIVE before locking contacts, so taking it first here
  -- means the two can only queue behind each other, never deadlock.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
  -- Serialize every v2 phone action and undo for this phone.
  perform public.routing_v2_phone_lock(v_message.org_id, p_phone);

  select * into v_existing from public.routing_v2_phone_actions a
  where a.source_inbound_message_id = p_source_inbound_message_id;
  if found then
    return jsonb_build_object(
      'status', 'replayed', 'actionId', v_existing.id, 'actionStatus', v_existing.status,
      'replyState', v_existing.reply_state, 'sendId', v_existing.send_id,
      'propertyIds', to_jsonb(v_existing.property_ids)
    );
  end if;

  select c.routing_v2_flags into v_flags
  from public.ai_responder_configs c
  where c.org_id = v_message.org_id and c.active = true
  limit 1;
  if v_flags is null or jsonb_typeof(v_flags) <> 'object'
     or (v_flags->'questions_live') is distinct from 'true'::jsonb
     or (v_flags->'wrong_number_all') is distinct from 'true'::jsonb then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'flag_off');
  end if;

  -- Settle window: the triggering inbound must be at least 30 s old, so every inbound that
  -- arrived around it has committed and is visible to the newest-inbound check below
  -- (inbound inserts commit in milliseconds). Retryable; nothing is written.
  if v_message.created_at > clock_timestamp() - interval '30 seconds' then
    return jsonb_build_object('status', 'not_settled', 'reason', 'inbound_settle_window', 'retryAfterSeconds',
      greatest(1, ceil(extract(epoch from (v_message.created_at + interval '30 seconds' - clock_timestamp()))))::int);
  end if;

  -- D. Latest reply wins across every property for this phone (committed rows; range on
  -- created_at uses idx_messages_created).
  if exists (
    select 1 from public.messages m
    where m.created_at >= v_message.created_at
      and m.org_id = v_message.org_id and m.channel = 'sms' and m.direction = 'inbound'
      and m.id <> v_message.id
      and public.routing_v2_phone_digits(m.from_address) = v_digits
      and (m.created_at > v_message.created_at or m.id > v_message.id)
  ) then
    return jsonb_build_object('status', 'superseded', 'reason', 'newer_inbound_from_phone');
  end if;

  -- Lock order (same everywhere): phone advisory -> contacts rows -> contact_phone_numbers
  -- rows -> sms_phone_suppressions -> per-property advisory -> properties rows -> enrollments.
  -- Contacts holding the phone (equality on the stored E.164 plus the normalized phone table).
  v_contacts := array(
    select c.id from public.contacts c
    where c.org_id = v_message.org_id
      and (c.phone_1 = p_phone or c.phone_2 = p_phone or c.phone_3 = p_phone
           or c.id in (select cp.contact_id from public.contact_phone_numbers cp where cp.org_id = v_message.org_id and cp.digits10 = v_digits))
    order by c.id
  );
  if p_action = 'wrong_number_all' then
    select array_agg(p.id order by p.id) into v_ids
    from public.properties p
    where p.org_id = v_message.org_id and p.deleted_at is null
      and (p.id = v_message.property_id or p.homeowner_contact_id = any(v_contacts));
  else
    select array_agg(p.id) into v_ids
    from public.properties p
    where p.id = v_message.property_id and p.org_id = v_message.org_id and p.deleted_at is null;
  end if;
  if v_ids is null or not (v_message.property_id = any(v_ids)) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_property_missing');
  end if;

  perform 1 from public.contacts c
  where c.id = any(v_contacts)
     or c.id in (select p.homeowner_contact_id from public.properties p where p.id = any(v_ids))
  order by c.id for update;
  perform 1 from public.contact_phone_numbers cp
  where cp.org_id = v_message.org_id and cp.digits10 = v_digits
  order by cp.contact_id, cp.slot for update;
  perform 1 from public.sms_phone_suppressions sp
  where sp.org_id = v_message.org_id and sp.channel = 'sms' and sp.phone_e164 = p_phone
  for update;
  if found then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'phone_suppressed');
  end if;
  -- Global phone DNC registry (append-only; inserted only under the EXCLUSIVE global-DNC
  -- barrier, so it cannot change while A holds the shared one). Read directly, as the other
  -- registry consumers do (norma eligibility, voicemail drop): contact/property DNC flags and
  -- sms_phone_suppressions do not cover a registry-only phone.
  if exists (select 1 from public.global_phone_dnc_registry g where g.org_id = v_message.org_id and g.phone_e164 = p_phone) then
    return jsonb_build_object('status', 'suppressed', 'reason', 'global_dnc_registry');
  end if;
  foreach v_id in array v_ids loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_id::text));
  end loop;
  perform 1 from public.properties p where p.id = any(v_ids) order by p.id for update;

  -- Re-derive the target set under the locks; a change since the first read = retry later.
  if p_action = 'wrong_number_all' and v_ids is distinct from (
    select array_agg(p.id order by p.id) from public.properties p
    where p.org_id = v_message.org_id and p.deleted_at is null
      and (p.id = v_message.property_id or exists (
        select 1 from public.contacts c
        where c.id = p.homeowner_contact_id and c.org_id = v_message.org_id
          and (c.phone_1 = p_phone or c.phone_2 = p_phone or c.phone_3 = p_phone
               or c.id in (select cp.contact_id from public.contact_phone_numbers cp where cp.org_id = v_message.org_id and cp.digits10 = v_digits))))
  ) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'property_set_changed');
  end if;

  -- Final write gate: re-read the active config NOW, after every lock, with FOR SHARE (an
  -- owner's flag flip waits for this transaction, or this read sees the flip). The earlier
  -- read was only an early exit; this one decides.
  select c.routing_v2_flags into v_flags
  from public.ai_responder_configs c
  where c.org_id = v_message.org_id and c.active = true
  limit 1
  for share;
  if v_flags is null or jsonb_typeof(v_flags) <> 'object'
     or (v_flags->'questions_live') is distinct from 'true'::jsonb
     or (v_flags->'wrong_number_all') is distinct from 'true'::jsonb then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'flag_off');
  end if;
  -- Phone-level actions are eligible only if every property on the phone is (§13.1).
  if exists (select 1 from unnest(v_ids) t(id) where not public.routing_v2_phone_action_eligible(v_flags, t.id)) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'canary_excluded');
  end if;

  if exists (
    select 1 from public.properties p where p.id = v_message.property_id and p.decision_context_revision is distinct from p_expected_revision
  ) then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'stale_decision_context');
  end if;

  for r in
    select p.id, p.outreach_dispo, p.needs_human_attention, p.is_training, p.is_dnc_locked,
           p.id = v_message.property_id as is_source,
           coalesce(c.sms_opted_out, false) or coalesce(c.do_not_contact, false) as contact_suppressed,
           exists (
             select 1 from unnest(array[c.phone_1, c.phone_2, c.phone_3]) ph(v)
             where nullif(public.routing_v2_phone_digits(ph.v), '') is not null
               and public.routing_v2_phone_digits(ph.v) <> v_digits
           ) as other_phone
    from public.properties p
    left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = v_message.org_id
    where p.id = any(v_ids)
    order by p.id
  loop
    v_reason := case
      when r.needs_human_attention then 'held'
      when r.is_training then 'training'
      when r.is_dnc_locked then 'dnc_locked'
      when r.outreach_dispo in ('opted_out', 'dnc') then 'opted_out_or_dnc'
      when r.outreach_dispo = v_dispo then 'already_applied'
      when r.outreach_dispo is not null and r.outreach_dispo not in ('not_interested', 'needs_sequence') then 'human_owned_outcome'
      when r.contact_suppressed then 'contact_suppressed'
      when exists (
        select 1 from public.ai_disposition_reviews rv
        where rv.property_id = r.id and rv.org_id = v_message.org_id and rv.status = 'pending'
      ) then 'pending_review'
      when not r.is_source and r.other_phone then 'other_phones_on_contact'
      else null
    end;
    if r.is_source then v_source_reason := v_reason; end if;
    if v_reason is not null then v_skips := v_skips || jsonb_build_object(r.id::text, v_reason); end if;
  end loop;
  if v_source_reason is not null then
    return jsonb_build_object('status', 'not_applicable', 'reason', 'source_' || v_source_reason);
  end if;

  -- Every check passed: write it all.
  insert into public.routing_v2_phone_actions (
    org_id, source_property_id, source_inbound_message_id, action, phone_e164, status,
    property_ids, reply_state, fence_at, decision
  ) values (
    v_message.org_id, v_message.property_id, p_source_inbound_message_id, p_action, p_phone, 'applied',
    v_ids, case p_action when 'wrong_number_all' then 'awaiting_fence' else 'not_needed' end,
    case p_action when 'wrong_number_all' then clock_timestamp() + interval '10 seconds' end,
    coalesce(p_decision, '{}'::jsonb)
  )
  returning id, send_id into v_action_id, v_send_id;

  for r in
    select p.id, p.outreach_dispo, p.follow_up_at,
           p.id = v_message.property_id as is_source
    from public.properties p where p.id = any(v_ids) order by p.id
  loop
    if v_skips ? r.id::text then
      insert into public.routing_v2_phone_action_properties (action_id, org_id, property_id, is_source, outcome, skip_reason)
      values (v_action_id, v_message.org_id, r.id, r.is_source, 'skipped', v_skips->>r.id::text);
      v_skipped := v_skipped || jsonb_build_object('propertyId', r.id, 'reason', v_skips->>r.id::text);
      continue;
    end if;

    update public.properties
    -- Only the disposition. Hold fields (needs_human_attention, last_ai_escalation_*) are never
    -- written by A or by undo, so undo can't restore a stale hold (no ABA hazard).
    set outreach_dispo = v_dispo, updated_at = now()
    where id = r.id and org_id = v_message.org_id
    returning decision_context_revision, follow_up_at into v_after;

    -- As setResponderDispo does for a wrong_number: pause the property's active drips.
    v_paused := '{}';
    v_pause_at := null;
    if p_action = 'wrong_number_all' then
      -- Each pause carries this action's token and a unique stamp; undo resumes only rows that
      -- still carry both (any later resume/re-pause clears the token, see the trigger below).
      v_pause_at := clock_timestamp();
      -- Provenance marker for routing_v2_pause_token_guard (transaction-local; reset below).
      perform set_config('routing_v2.pausing', 'on', true);
      with paused as (
        update public.sequence_enrollments e
        set status = 'paused', pause_reason = 'inbound_reply', updated_at = v_pause_at,
            routing_v2_pause_token = v_action_id
        where e.property_id = r.id and e.status = 'active'
        returning e.id, e.sequence_id
      )
      select coalesce(array_agg(id order by id), '{}') into v_paused from paused;
      perform set_config('routing_v2.pausing', '', true);
      if cardinality(v_paused) = 0 then v_pause_at := null; end if;
      if cardinality(v_paused) > 0 then
        insert into public.lead_events (org_id, property_id, actor_type, event_type, payload)
        values (v_message.org_id, r.id, 'system', 'sequence_paused', jsonb_build_object(
          'count', cardinality(v_paused), 'reason', 'inbound_reply', 'permanent', false, 'phone_action_id', v_action_id));
      end if;
    end if;

    insert into public.routing_v2_phone_action_properties (
      action_id, org_id, property_id, is_source, outcome, applied_dispo,
      prior_outreach_dispo, prior_follow_up_at,
      applied_follow_up_at, recorded_revision, paused_enrollment_ids, paused_at
    ) values (
      v_action_id, v_message.org_id, r.id, r.is_source, 'applied', v_dispo,
      r.outreach_dispo, r.follow_up_at,
      v_after.follow_up_at, v_after.decision_context_revision, v_paused, v_pause_at
    )
    returning id into v_row_id;

    insert into public.lead_events (org_id, property_id, actor_type, event_type, payload, source_type, source_id)
    values (
      v_message.org_id, r.id, 'ai', 'dispo_set',
      jsonb_build_object(
        'from', r.outreach_dispo, 'to', v_dispo, 'reason', 'routing_v2:' || p_action, 'auto_accepted', true,
        'phone_action_id', v_action_id, 'source_inbound_message_id', p_source_inbound_message_id
      ),
      'routing_v2_phone_action_properties.applied', v_row_id
    );
    v_applied := v_applied || r.id;
  end loop;

  return jsonb_build_object(
    'status', 'applied', 'actionId', v_action_id, 'sendId', v_send_id,
    'replyState', case p_action when 'wrong_number_all' then 'awaiting_fence' else 'not_needed' end,
    'applied', to_jsonb(v_applied), 'skipped', v_skipped, 'propertyIds', to_jsonb(v_ids)
  );
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_apply_all(uuid, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_apply_all(uuid, text, text, jsonb, bigint) to service_role;

-- B. Reply state transitions, keyed by the durable send id (a mismatched id changes nothing).
--   pending -> sending | skipped ; sending -> sent | failed | unknown
create or replace function public.fn_routing_v2_phone_action_reply(
  p_action_id uuid,
  p_send_id uuid,
  p_to text,
  p_message_id uuid default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_ok boolean := false;
  v_newer uuid;
  v_held boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_to not in ('sending', 'skipped', 'sent', 'failed', 'unknown') then
    raise exception 'unsupported reply state: %', p_to using errcode = '22023';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Same order as undo (global-DNC barrier, phone lock, then the action row), so pending ->
  -- sending can never interleave with an undo of the same action; the barrier is needed
  -- because a superseded send writes the needs-person hold on the source property.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
  perform public.routing_v2_phone_lock(v.org_id, v.phone_e164);
  select * into v from public.routing_v2_phone_actions where id = p_action_id for update;
  -- Final DB send gate: a suppressed or globally-DNC'd phone never starts its reply.
  if p_to = 'sending' and v.send_id = p_send_id and v.reply_state = 'pending' and (
       exists (select 1 from public.global_phone_dnc_registry g where g.org_id = v.org_id and g.phone_e164 = v.phone_e164)
    or exists (select 1 from public.sms_phone_suppressions sp where sp.org_id = v.org_id and sp.channel = 'sms' and sp.phone_e164 = v.phone_e164)
  ) then
    update public.routing_v2_phone_actions
    set reply_state = 'skipped', reply_reason = 'suppressed_at_send', reply_updated_at = now()
    where id = v.id;
    return jsonb_build_object('ok', false, 'replyState', 'skipped', 'sendId', v.send_id, 'reason', 'suppressed_at_send');
  end if;
  -- A newer inbound from the phone (any property) committed after the fence release: the
  -- reply never starts; the source property goes on the existing needs-person hold.
  if p_to = 'sending' and v.send_id = p_send_id and v.reply_state = 'pending' and v.status = 'applied' then
    v_newer := public.routing_v2_phone_action_newer_inbound(v.id);
    if v_newer is not null then
      v_held := public.routing_v2_phone_action_hold_superseded(v.id, v_newer, 'superseded_before_send');
      return jsonb_build_object('ok', false, 'replyState', 'skipped', 'sendId', v.send_id, 'reason', 'superseded_before_send',
        'newerInboundMessageId', v_newer, 'holdSet', v_held);
    end if;
  end if;
  if v.send_id = p_send_id and (
       -- An undone action never starts its reply.
       (v.reply_state = 'pending' and p_to = 'sending' and v.status = 'applied')
    or (v.reply_state = 'pending' and p_to = 'skipped')
    or (v.reply_state = 'sending' and p_to in ('failed', 'unknown'))
    or (v.reply_state = 'sending' and p_to = 'sent' and p_message_id is not null)
  ) then
    update public.routing_v2_phone_actions
    set reply_state = p_to, reply_message_id = coalesce(p_message_id, reply_message_id),
        reply_reason = p_reason, reply_updated_at = now(),
        sending_at = case when p_to = 'sending' then clock_timestamp() else sending_at end
    where id = v.id;
    v_ok := true;
    if p_to = 'sent' then
      perform public.routing_v2_phone_action_restamp_after_reply(v.id, p_message_id);
    end if;
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  return jsonb_build_object('ok', v_ok, 'replyState', v.reply_state, 'sendId', v.send_id);
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_reply(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_reply(uuid, uuid, text, uuid, text) to service_role;

-- Provider-boundary send check (read-only): the action is still applied with its reply in
-- flight, and the phone is neither in sms_phone_suppressions nor in the global DNC registry.
create or replace function public.fn_routing_v2_phone_action_send_allowed(p_action_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select a.status = 'applied' and a.reply_state = 'sending'
       and not exists (select 1 from public.global_phone_dnc_registry g where g.org_id = a.org_id and g.phone_e164 = a.phone_e164)
       and not exists (select 1 from public.sms_phone_suppressions sp where sp.org_id = a.org_id and sp.channel = 'sms' and sp.phone_e164 = a.phone_e164)
       and public.routing_v2_phone_action_newer_inbound(a.id) is null
    from public.routing_v2_phone_actions a where a.id = p_action_id
  ), false);
$$;
revoke all on function public.fn_routing_v2_phone_action_send_allowed(uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_send_allowed(uuid) to service_role;

-- B recovery: only after the 120 s provider-timeout lease; a reply left in `sending` is settled ONLY by its send id (the outbound
-- message's idempotency_key, on the action's own source property). Never re-sent.
create or replace function public.fn_routing_v2_phone_action_recover_reply(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  m record;
  v_to text;
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.routing_v2_phone_lock(v.org_id, v.phone_e164);
  select * into v from public.routing_v2_phone_actions where id = p_action_id for update;
  if v.reply_state <> 'sending' then
    return jsonb_build_object('replyState', v.reply_state, 'sendId', v.send_id);
  end if;
  -- Provider-timeout lease: the original send may still be in flight (provider HTTP timeout
  -- plus margin). Until the lease expires the row stays `sending` (undo stays busy).
  if v.sending_at > clock_timestamp() - interval '120 seconds' then
    return jsonb_build_object('replyState', 'sending', 'sendId', v.send_id, 'inFlight', true,
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v.sending_at + interval '120 seconds' - clock_timestamp()))))::int);
  end if;
  select msg.id, msg.status, msg.external_id, msg.metadata into m
  from public.messages msg
  where msg.org_id = v.org_id and msg.channel = 'sms' and msg.direction = 'outbound'
    and msg.idempotency_key = v.send_id and msg.property_id = v.source_property_id;
  -- Explicit status map, same rule as send.ts repSmsIdempotencyReplay. Nothing is assumed:
  --   sent/delivered WITH a provider receipt (and not flagged provider_unknown) -> sent
  --   failed                                                               -> failed
  --   no row, pending/queued/paused/sending, a terminal row with no receipt,
  --   provider_unknown, or any other status                                  -> unknown
  if m.id is null then
    v_to := 'unknown'; v_reason := 'no_message_for_send_id';
  elsif m.status in ('sent', 'delivered') and nullif(btrim(coalesce(m.external_id, '')), '') is not null
        and coalesce(m.metadata->>'providerOutcome', '') <> 'provider_unknown' then
    v_to := 'sent'; v_reason := 'recovered_by_send_id';
  elsif m.status = 'failed' then
    v_to := 'failed'; v_reason := 'message_failed';
  else
    v_to := 'unknown'; v_reason := 'message_status_' || coalesce(m.status, 'null');
  end if;
  update public.routing_v2_phone_actions
  set reply_state = v_to, reply_message_id = m.id, reply_reason = v_reason, reply_updated_at = now()
  where id = v.id;
  if v_to = 'sent' then
    perform public.routing_v2_phone_action_restamp_after_reply(v.id, m.id);
  end if;
  return jsonb_build_object('replyState', v_to, 'sendId', v.send_id, 'messageId', m.id, 'reason', v_reason);
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_recover_reply(uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_recover_reply(uuid) to service_role;

-- Settler feed: replies still pending/sending after p_older_than_seconds.
create or replace function public.fn_routing_v2_phone_action_unsettled_replies(p_older_than_seconds integer default 120, p_limit integer default 25)
returns table (action_id uuid, org_id uuid, reply_state text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.org_id, a.reply_state
  from public.routing_v2_phone_actions a
  where a.reply_state in ('awaiting_fence', 'pending', 'sending')
    and (a.status = 'applied' or a.reply_state = 'sending')
    and (a.reply_state <> 'awaiting_fence' or a.fence_at <= now())
    and (a.reply_state <> 'sending' or a.sending_at <= now() - interval '120 seconds')
    -- A fenced reply's own timer is fence_at (applied + 10 s); the age filter applies to the rest.
    and (a.reply_state = 'awaiting_fence'
         or coalesce(a.reply_updated_at, a.created_at) <= now() - make_interval(secs => greatest(coalesce(p_older_than_seconds, 120), 0)))
  order by a.created_at
  limit greatest(coalesce(p_limit, 25), 1);
$$;
revoke all on function public.fn_routing_v2_phone_action_unsettled_replies(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_unsettled_replies(integer, integer) to service_role;

-- C. Undo core (a person's undo): caller holds the DNC barrier, the phone lock and the action
-- row lock. Restores ONLY what A changed (dispo, follow-up, A's own token-stamped paused
-- enrollments), only where dispo, follow-up AND the decision revision still equal what A left;
-- hold fields are never read for restore or written. Internal only.
create or replace function public.routing_v2_phone_action_undo_core(p_action_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
-- Undo waits at most this long for the suppression table lock, then reports busy.
set lock_timeout = '3s'
as $$
declare
  v_action public.routing_v2_phone_actions%rowtype;
  v_row public.routing_v2_phone_action_properties%rowtype;
  v_cur record;
  v_found boolean;
  v_reason text;
  v_phone_suppressed boolean;
  v_registry boolean;
  v_restored jsonb := '[]'::jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_enrollment uuid;
  v_outcome text;
  v_resumed integer := 0;
  v_not_resumed jsonb := '[]'::jsonb;
  v_remaining integer;
  v_actor uuid := p_actor;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  select * into v_action from public.routing_v2_phone_actions where id = p_action_id;

  -- Same lock order as A: phone advisory (caller) -> contacts rows -> sms_phone_suppressions
  -- -> per-property advisory -> properties rows -> enrollments.
  -- The only contact data undo reads is each homeowner contact's opt-out flags (existing
  -- rows): share-lock those rows so an opt-out cannot commit between check and restore.
  perform 1 from public.contacts c
  where c.id in (
    select p.homeowner_contact_id from public.properties p
    join public.routing_v2_phone_action_properties ap on ap.property_id = p.id
    where ap.action_id = v_action.id and ap.outcome = 'applied' and ap.undone_at is null
  )
  order by c.id for share;
  -- Undo is rare and short: SHARE mode blocks every concurrent suppression insert/update
  -- (from any writer, lock or not) until this transaction commits, so the check below cannot
  -- be overtaken. Held only for this transaction (milliseconds; at most lock_timeout waiting
  -- to get it). Busy = nothing changed; retry later.
  begin
    lock table public.sms_phone_suppressions in share mode;
  exception when lock_not_available then
    return jsonb_build_object('status', 'busy', 'reason', 'suppression_lock', 'restored', '[]'::jsonb, 'stateChanged', '[]'::jsonb,
      'skipped', '[]'::jsonb, 'resumed', 0, 'notResumed', '[]'::jsonb);
  end;
  v_registry := exists (select 1 from public.global_phone_dnc_registry g where g.org_id = v_action.org_id and g.phone_e164 = v_action.phone_e164);
  v_phone_suppressed := exists (
    select 1 from public.sms_phone_suppressions sp
    where sp.org_id = v_action.org_id and sp.channel = 'sms' and sp.phone_e164 = v_action.phone_e164
  );

  for v_row in
    select * from public.routing_v2_phone_action_properties
    where action_id = v_action.id and outcome = 'applied' and undone_at is null
    order by property_id
  loop
    perform pg_advisory_xact_lock(hashtext('routing_v2:' || v_row.property_id::text));
    select p.outreach_dispo, p.follow_up_at, p.decision_context_revision,
           p.needs_human_attention, p.is_dnc_locked,
           coalesce(c.sms_opted_out, false) or coalesce(c.do_not_contact, false) as contact_suppressed
    into v_cur
    from public.properties p
    left join public.contacts c on c.id = p.homeowner_contact_id
    where p.id = v_row.property_id and p.org_id = v_action.org_id
    for update of p;
    v_found := found;

    v_reason := case
      when not v_found then 'property_missing'
      when v_cur.is_dnc_locked then 'dnc_locked'
      when v_registry then 'global_dnc_registry'
      when v_phone_suppressed then 'phone_suppressed'
      when v_cur.outreach_dispo is distinct from v_row.applied_dispo
        -- A never changes follow_up_at; this catches a person setting one since (never overwrite it).
        or v_cur.follow_up_at is distinct from v_row.applied_follow_up_at
        or v_cur.decision_context_revision is distinct from v_row.recorded_revision then 'state_changed'
      -- Held now (a person must look): leave it alone. Undo never reads or writes the hold
      -- fields beyond this current-state guard.
      when v_cur.needs_human_attention then 'held'
      when v_cur.contact_suppressed then 'contact_suppressed'
      else null
    end;

    if v_reason is not null then
      v_changed := v_changed || to_jsonb(v_row.property_id);
      v_skipped := v_skipped || jsonb_build_object('propertyId', v_row.property_id, 'reason', v_reason);
      if v_found then
        insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload)
        values (v_action.org_id, v_row.property_id, 'user', v_actor, 'routing_v2_phone_action_undo_skipped',
          jsonb_build_object('reason', v_reason, 'phone_action_id', v_action.id, 'action', v_action.action));
      end if;
      continue;
    end if;

    update public.properties
    set outreach_dispo = v_row.prior_outreach_dispo,
        follow_up_at = v_row.prior_follow_up_at,
        updated_at = now()
    where id = v_row.property_id and org_id = v_action.org_id;

    foreach v_enrollment in array v_row.paused_enrollment_ids loop
      -- Only A's own pause: still paused for inbound_reply, still carrying this action's token
      -- and exactly the stamp A wrote. A person's resume or a later re-pause clears the token.
      if not exists (
        select 1 from public.sequence_enrollments e
        where e.id = v_enrollment and e.status = 'paused' and e.pause_reason = 'inbound_reply'
          and e.routing_v2_pause_token = v_action.id and e.updated_at = v_row.paused_at
        for update
      ) then
        v_not_resumed := v_not_resumed || jsonb_build_object('enrollmentId', v_enrollment, 'outcome', 'not_this_actions_pause');
        continue;
      end if;
      select o.outcome into v_outcome from public.resume_sequence_enrollment(v_enrollment, null, 'inbound_reply') o;
      if v_outcome = 'resumed' then
        v_resumed := v_resumed + 1;
      else
        v_not_resumed := v_not_resumed || jsonb_build_object('enrollmentId', v_enrollment, 'outcome', v_outcome);
      end if;
    end loop;

    update public.routing_v2_phone_action_properties set undone_at = now(), undone_by = v_actor where id = v_row.id;

    insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
    values (
      v_action.org_id, v_row.property_id, 'user', v_actor, 'routing_v2_phone_action_undone',
      jsonb_build_object('action', v_action.action, 'applied_dispo', v_row.applied_dispo, 'restored_dispo', v_row.prior_outreach_dispo,
        'phone_action_id', v_action.id, 'source_inbound_message_id', v_action.source_inbound_message_id),
      'routing_v2_phone_action_properties.undone', v_row.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;
    v_restored := v_restored || to_jsonb(v_row.property_id);
  end loop;

  select count(*) into v_remaining
  from public.routing_v2_phone_action_properties
  where action_id = v_action.id and outcome = 'applied' and undone_at is null;

  -- Any undo stops a reply that has not started (even a partial one).
  update public.routing_v2_phone_actions
  set status = case when v_remaining = 0 then 'undone' else status end,
      undone_at = case when v_remaining = 0 then now() else undone_at end,
      undone_by = case when v_remaining = 0 then v_actor else undone_by end,
      reply_reason = case when reply_state in ('pending', 'awaiting_fence')
                          then 'undone_before_send'
                          else reply_reason end,
      reply_updated_at = case when reply_state in ('pending', 'awaiting_fence') then now() else reply_updated_at end,
      reply_state = case when reply_state in ('pending', 'awaiting_fence') then 'skipped' else reply_state end
  where id = v_action.id;

  return jsonb_build_object(
    'status', case when v_remaining = 0 then 'undone' else 'partial' end,
    'restored', v_restored, 'stateChanged', v_changed, 'skipped', v_skipped,
    'resumed', v_resumed, 'notResumed', v_not_resumed
  );
end;
$$;
revoke all on function public.routing_v2_phone_action_undo_core(uuid, uuid) from public, anon, authenticated, service_role;

-- C. Undo (a person). One transaction under the phone lock. A reply in flight (`sending`)
-- makes undo busy: only a not-yet-started or finished reply can be undone.
create or replace function public.fn_undo_routing_v2_phone_action(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_action public.routing_v2_phone_actions%rowtype;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_action_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  select * into v_action from public.routing_v2_phone_actions where id = p_action_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_action.org_id)
     or v_action.org_id not in (select public.pipeline_runs_readable_org_ids()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
  perform public.routing_v2_phone_lock(v_action.org_id, v_action.phone_e164);
  select * into v_action from public.routing_v2_phone_actions where id = p_action_id for update;
  if v_action.status = 'undone' then
    return jsonb_build_object('status', 'already_undone', 'restored', '[]'::jsonb, 'stateChanged', '[]'::jsonb,
      'skipped', '[]'::jsonb, 'resumed', 0, 'notResumed', '[]'::jsonb);
  end if;
  if v_action.reply_state = 'sending' then
    return jsonb_build_object('status', 'busy', 'reason', 'reply_in_flight', 'restored', '[]'::jsonb, 'stateChanged', '[]'::jsonb,
      'skipped', '[]'::jsonb, 'resumed', 0, 'notResumed', '[]'::jsonb);
  end if;
  return public.routing_v2_phone_action_undo_core(p_action_id, v_actor);
end;
$$;
revoke all on function public.fn_undo_routing_v2_phone_action(uuid) from public, anon;
grant execute on function public.fn_undo_routing_v2_phone_action(uuid) to authenticated;

-- B0. Post-commit fence. A leaves a wrong-number reply `awaiting_fence` until fence_at
-- (applied + 10 s). After that, under the phone lock, any inbound from the phone (any
-- property) newer than the trigger means A raced a late-committing text. Then the reply is
-- skipped, every property stays exactly as A left it, the source property is put on the
-- EXISTING needs-person hold (reason nine_needs_person) and it is audited; a person decides and
-- can use the normal undo (full checks). Otherwise the reply is released to `pending`.
create or replace function public.fn_routing_v2_phone_action_release_fence(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.routing_v2_phone_actions%rowtype;
  v_newer uuid;
  v_held boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into v from public.routing_v2_phone_actions where id = p_action_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Writes properties (the hold): global-DNC barrier first, then the phone lock.
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('switchboard-global-dnc-write-barrier-v1', 0));
  perform public.routing_v2_phone_lock(v.org_id, v.phone_e164);
  select * into v from public.routing_v2_phone_actions where id = p_action_id for update;
  if v.reply_state <> 'awaiting_fence' then
    return jsonb_build_object('replyState', v.reply_state, 'sendId', v.send_id);
  end if;
  if v.fence_at > clock_timestamp() then
    return jsonb_build_object('replyState', 'awaiting_fence', 'sendId', v.send_id,
      'retryAfterSeconds', greatest(1, ceil(extract(epoch from (v.fence_at - clock_timestamp()))))::int);
  end if;

  v_newer := public.routing_v2_phone_action_newer_inbound(v.id);

  if exists (select 1 from public.global_phone_dnc_registry g where g.org_id = v.org_id and g.phone_e164 = v.phone_e164)
     or exists (select 1 from public.sms_phone_suppressions sp where sp.org_id = v.org_id and sp.channel = 'sms' and sp.phone_e164 = v.phone_e164) then
    update public.routing_v2_phone_actions
    set reply_state = 'skipped', reply_reason = 'suppressed_at_send', reply_updated_at = now()
    where id = v.id;
    return jsonb_build_object('replyState', 'skipped', 'sendId', v.send_id, 'reason', 'suppressed_at_send');
  end if;

  if v_newer is null then
    update public.routing_v2_phone_actions
    set reply_state = 'pending', reply_reason = 'fence_passed', reply_updated_at = now()
    where id = v.id;
    return jsonb_build_object('replyState', 'pending', 'sendId', v.send_id);
  end if;

  v_held := public.routing_v2_phone_action_hold_superseded(v.id, v_newer, 'superseded_after_commit');
  return jsonb_build_object('replyState', 'skipped', 'sendId', v.send_id, 'reason', 'superseded_after_commit',
    'newerInboundMessageId', v_newer, 'holdSet', v_held);
end;
$$;
revoke all on function public.fn_routing_v2_phone_action_release_fence(uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_phone_action_release_fence(uuid) to service_role;

commit;
