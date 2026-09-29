-- ============================================================================
-- Migration: Dialpad CTI foundation (A1)
-- Purpose: durable schema and privileged, service-only functions for
--   * one Dialpad CTI connection per organization,
--   * per-rep Dialpad identity bindings (claimed, then server-verified),
--   * per-rep outbound caller grants,
--   * immutable prepared call intents frozen to the authorized rep, lead,
--     assignment episode and destination number, and
--   * a signed-event inbox keyed by the fields Dialpad actually documents.
--
-- Dialpad call events carry no event id (call_id, event_timestamp, state,
-- custom_data, target, external_number are the documented identity fields;
-- events may arrive out of order). Identity is therefore
-- (org, call_id, state, event_timestamp) plus a payload hash, so an exact
-- redelivery is a replay and a different payload under the same key is
-- recorded as a conflict that never earns credit.
--
-- Nothing here calls Dialpad, places a call, or writes call_activities or
-- acquisition_attempts. The ledger writer is a later slice.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- Internal helpers (not callable by API roles)
-- ----------------------------------------------------------------------------

create or replace function public.dialpad_cti_origins_valid(p_origins text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_origins is not null
    and coalesce(cardinality(p_origins), 0) between 1 and 5
    and not exists (
      select 1 from unnest(p_origins) as o
      where o is null or o !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
    );
$$;

create or replace function public.dialpad_cti_normalize_us_phone(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when length(regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g')) = 11
      and regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') like '1%'
      then '+1' || right(regexp_replace(p_raw, '[^0-9]', '', 'g'), 10)
    when length(regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g')) = 10
      then '+1' || regexp_replace(p_raw, '[^0-9]', '', 'g')
    else null
  end;
$$;

create or replace function public.dialpad_cti_member_is_active(p_org uuid, p_user uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = p_user
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  );
$$;

-- Safe for API roles: it only ever answers about the calling user.
create or replace function public.dialpad_cti_caller_is_active_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and public.dialpad_cti_member_is_active(p_org, auth.uid());
$$;

-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------

create table if not exists public.dialpad_org_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  status text not null default 'disabled' check (status in ('disabled', 'active')),
  cti_client_id text not null check (cti_client_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  allowed_origins text[] not null default array['https://dialpad.com']::text[]
    check (public.dialpad_cti_origins_valid(allowed_origins)),
  -- Name of the externally held HS256 webhook signing secret (never the
  -- secret itself). The verifier resolves it outside the database.
  webhook_secret_ref text not null check (webhook_secret_ref ~ '^[A-Za-z0-9_./:-]{1,200}$'),
  webhook_secret_version integer not null default 1 check (webhook_secret_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id),
  unique (id, org_id)
);

comment on table public.dialpad_org_connections is
  'One Dialpad CTI connection per organization. Holds the public CTI client id, the allowed postMessage origins and only a reference to the webhook signing secret; no secret value is stored here. Written by service role only.';
comment on column public.dialpad_org_connections.webhook_secret_ref is
  'Reference (name) of the externally stored HS256 signing secret. The secret value must never be written to this table.';

create table if not exists public.dialpad_member_bindings (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  dialpad_user_id text not null check (dialpad_user_id ~ '^[0-9]{1,20}$'),
  status text not null default 'pending' check (status in ('pending', 'verified', 'revoked')),
  claimed_at timestamptz not null default now(),
  verified_at timestamptz,
  verification_kind text check (verification_kind in ('provider_directory', 'signed_call_event', 'owner_attestation')),
  verification_ref text check (verification_ref is null or length(verification_ref) between 1 and 500),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'verified' or (verified_at is not null and verification_kind is not null and verification_ref is not null)),
  check (status <> 'revoked' or (revoked_at is not null and revoked_reason is not null)),
  unique (id, org_id, user_id)
);

-- A CTI-reported id is only a claim. One live binding per rep, and one
-- verified binding per Dialpad user id, per organization.
create unique index if not exists dialpad_member_bindings_one_live_per_user
  on public.dialpad_member_bindings (org_id, user_id) where status <> 'revoked';
create unique index if not exists dialpad_member_bindings_one_verified_per_dialpad_user
  on public.dialpad_member_bindings (org_id, dialpad_user_id) where status = 'verified';

comment on table public.dialpad_member_bindings is
  'Per-rep Dialpad user identity. pending = browser-claimed id (untrusted); verified only through a service-side verification recording its evidence; revoked is terminal.';

create table if not exists public.dialpad_number_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  caller_number_e164 text not null check (caller_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  identity_type text check (identity_type in ('Office', 'OfficeGroup', 'CallCenter')),
  identity_id text check (identity_id ~ '^[0-9]{1,20}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  granted_by uuid not null references auth.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete restrict,
  check ((identity_type is null) = (identity_id is null)),
  check (status <> 'revoked' or (revoked_at is not null and revoked_by is not null)),
  unique (id, org_id, user_id)
);

create unique index if not exists dialpad_number_grants_one_active
  on public.dialpad_number_grants (org_id, user_id, caller_number_e164, coalesce(identity_type, ''), coalesce(identity_id, ''))
  where status = 'active';

comment on table public.dialpad_number_grants is
  'Outbound caller-id grants per rep (Dialpad outbound_caller_id / identity_type / identity_id). A rep may only use an active grant of their own.';

create table if not exists public.dialpad_call_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  rep_user_id uuid not null references auth.users(id) on delete restrict,
  binding_id uuid not null,
  dialpad_user_id text not null check (dialpad_user_id ~ '^[0-9]{1,20}$'),
  property_id uuid not null,
  contact_id uuid not null references public.contacts(id) on delete restrict,
  phone_slot smallint not null check (phone_slot between 1 and 3),
  destination_e164 text not null check (destination_e164 ~ '^\+1[0-9]{10}$'),
  assignment_episode_id uuid not null,
  number_grant_id uuid,
  caller_number_e164 text check (caller_number_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  caller_identity_type text check (caller_identity_type in ('Office', 'OfficeGroup', 'CallCenter')),
  caller_identity_id text check (caller_identity_id ~ '^[0-9]{1,20}$'),
  custom_data text not null check (custom_data ~ '^sandra\.dialpad\.v1\.[0-9a-f]{48}$'),
  idempotency_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'prepared' check (status in ('prepared', 'matched', 'cancelled')),
  prepared_at timestamptz not null default now(),
  expires_at timestamptz not null,
  matched_provider_call_id text check (matched_provider_call_id ~ '^[0-9]{1,20}$'),
  matched_event_id uuid,
  matched_at timestamptz,
  cancelled_at timestamptz,
  check (expires_at > prepared_at),
  check ((number_grant_id is null) = (caller_number_e164 is null)),
  check (status <> 'matched' or (matched_provider_call_id is not null and matched_event_id is not null and matched_at is not null)),
  check (status <> 'cancelled' or cancelled_at is not null),
  unique (org_id, custom_data),
  unique (org_id, rep_user_id, idempotency_key),
  unique (id, org_id),
  foreign key (connection_id, org_id) references public.dialpad_org_connections (id, org_id),
  foreign key (binding_id, org_id, rep_user_id) references public.dialpad_member_bindings (id, org_id, user_id),
  foreign key (property_id, org_id) references public.properties (id, org_id),
  foreign key (assignment_episode_id, property_id, org_id)
    references public.acquisition_assignment_episodes (id, property_id, org_id),
  foreign key (number_grant_id, org_id, rep_user_id) references public.dialpad_number_grants (id, org_id, user_id)
);

create unique index if not exists dialpad_call_intents_one_per_provider_call
  on public.dialpad_call_intents (org_id, matched_provider_call_id) where matched_provider_call_id is not null;
create index if not exists dialpad_call_intents_rep_idx
  on public.dialpad_call_intents (rep_user_id, prepared_at desc);

comment on table public.dialpad_call_intents is
  'Immutable prepared call intents. Rep, verified Dialpad user, lead, assignment episode, destination number and optional caller grant are frozen when the intent is prepared; only status and match/cancel fields may change, forward only. custom_data is the opaque token sent to Dialpad initiate_call.';

create table if not exists public.dialpad_call_events (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null,
  provider_call_id text not null check (provider_call_id ~ '^[0-9]{1,20}$'),
  event_state text not null check (length(event_state) between 1 and 64),
  event_timestamp_ms bigint not null check (event_timestamp_ms between 1000000000000 and 99999999999999),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_alg text not null default 'HS256' check (signature_alg = 'HS256'),
  secret_version integer not null check (secret_version > 0),
  received_at timestamptz not null default now(),
  disposition text not null default 'received' check (disposition in ('received', 'matched', 'quarantined', 'conflict')),
  disposition_reason text check (disposition_reason is null or length(disposition_reason) between 1 and 200),
  matched_intent_id uuid,
  conflicts_with_event_id uuid,
  disposed_at timestamptz,
  check (disposition <> 'matched' or matched_intent_id is not null),
  check (disposition not in ('quarantined', 'conflict') or disposition_reason is not null),
  check (disposition <> 'conflict' or conflicts_with_event_id is not null),
  unique (id, org_id),
  foreign key (connection_id, org_id) references public.dialpad_org_connections (id, org_id),
  foreign key (matched_intent_id, org_id) references public.dialpad_call_intents (id, org_id),
  foreign key (conflicts_with_event_id, org_id) references public.dialpad_call_events (id, org_id)
);

create unique index if not exists dialpad_call_events_exact_replay
  on public.dialpad_call_events (org_id, provider_call_id, event_state, event_timestamp_ms, payload_sha256);
create unique index if not exists dialpad_call_events_first_writer
  on public.dialpad_call_events (org_id, provider_call_id, event_state, event_timestamp_ms)
  where disposition <> 'conflict';
create index if not exists dialpad_call_events_call_idx
  on public.dialpad_call_events (org_id, provider_call_id, event_timestamp_ms);

comment on table public.dialpad_call_events is
  'Durable inbox of signature-verified Dialpad call events. Dialpad documents no event id, so identity is (org, call_id, state, event_timestamp) plus payload hash. Payload holds provider PII: service role only, no API-role access.';

alter table public.dialpad_call_intents
  drop constraint if exists dialpad_call_intents_matched_event_fkey;
alter table public.dialpad_call_intents
  add constraint dialpad_call_intents_matched_event_fkey
  foreign key (matched_event_id, org_id) references public.dialpad_call_events (id, org_id);

-- ----------------------------------------------------------------------------
-- Immutability and forward-only state triggers (apply to every role)
-- ----------------------------------------------------------------------------

create or replace function public.dialpad_cti_touch_connection()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dialpad_org_connections_touch on public.dialpad_org_connections;
create trigger dialpad_org_connections_touch
  before update on public.dialpad_org_connections
  for each row execute function public.dialpad_cti_touch_connection();

create or replace function public.dialpad_cti_guard_connection()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_org_connections cannot be deleted; set status to disabled' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.id <> old.id) then
    raise exception 'dialpad_org_connections identity is immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.webhook_secret_version < old.webhook_secret_version then
    raise exception 'webhook_secret_version cannot decrease' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists dialpad_org_connections_guard on public.dialpad_org_connections;
create trigger dialpad_org_connections_guard
  before update or delete on public.dialpad_org_connections
  for each row execute function public.dialpad_cti_guard_connection();

create or replace function public.dialpad_cti_guard_binding()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_member_bindings are append-only identity evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.verified_at is not null or new.verification_kind is not null
       or new.verification_ref is not null or new.revoked_at is not null then
      raise exception 'a Dialpad binding must be created pending' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.org_id <> old.org_id or new.user_id <> old.user_id
     or new.dialpad_user_id <> old.dialpad_user_id or new.claimed_at <> old.claimed_at
     or new.created_at <> old.created_at then
    raise exception 'Dialpad binding identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'revoked' and new is distinct from old then
    raise exception 'a revoked Dialpad binding is terminal' using errcode = '42501';
  end if;
  if old.status = 'verified' and new.status = 'pending' then
    raise exception 'a verified Dialpad binding cannot return to pending' using errcode = '42501';
  end if;
  if old.status = 'verified' and new.status = 'verified'
     and (new.verified_at is distinct from old.verified_at or new.verification_kind is distinct from old.verification_kind
          or new.verification_ref is distinct from old.verification_ref) then
    raise exception 'verification evidence is immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dialpad_member_bindings_guard on public.dialpad_member_bindings;
create trigger dialpad_member_bindings_guard
  before insert or update or delete on public.dialpad_member_bindings
  for each row execute function public.dialpad_cti_guard_binding();

create or replace function public.dialpad_cti_guard_grant()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_number_grants are append-only' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'active' or new.revoked_at is not null or new.revoked_by is not null then
      raise exception 'a caller grant must be created active' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'revoked_at', 'revoked_by']) <> (to_jsonb(old) - array['status', 'revoked_at', 'revoked_by']) then
    raise exception 'caller grant identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'revoked' and new is distinct from old then
    raise exception 'a revoked caller grant is terminal' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists dialpad_number_grants_guard on public.dialpad_number_grants;
create trigger dialpad_number_grants_guard
  before insert or update or delete on public.dialpad_number_grants
  for each row execute function public.dialpad_cti_guard_grant();

create or replace function public.dialpad_cti_guard_intent()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['status', 'matched_provider_call_id', 'matched_event_id', 'matched_at', 'cancelled_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_call_intents are immutable evidence' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'prepared' or new.matched_provider_call_id is not null or new.matched_event_id is not null
       or new.matched_at is not null or new.cancelled_at is not null then
      raise exception 'a call intent must be created prepared' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'call intent attribution is immutable' using errcode = '42501';
  end if;
  if old.status <> 'prepared' and new is distinct from old then
    raise exception 'a % call intent is terminal', old.status using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists dialpad_call_intents_guard on public.dialpad_call_intents;
create trigger dialpad_call_intents_guard
  before insert or update or delete on public.dialpad_call_intents
  for each row execute function public.dialpad_cti_guard_intent();

create or replace function public.dialpad_cti_guard_event()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_mutable constant text[] := array['disposition', 'disposition_reason', 'matched_intent_id', 'disposed_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'dialpad_call_events are a durable inbox and cannot be deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.disposition not in ('received', 'conflict') or new.matched_intent_id is not null then
      raise exception 'an inbox event must be inserted received or conflict' using errcode = '42501';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_mutable) <> (to_jsonb(old) - v_mutable) then
    raise exception 'inbox event evidence is immutable' using errcode = '42501';
  end if;
  if old.disposition in ('matched', 'conflict') and new is distinct from old then
    raise exception 'a % inbox event is terminal', old.disposition using errcode = '42501';
  end if;
  if new.disposition = 'received' and old.disposition <> 'received' then
    raise exception 'an inbox event cannot return to received' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists dialpad_call_events_guard on public.dialpad_call_events;
create trigger dialpad_call_events_guard
  before insert or update or delete on public.dialpad_call_events
  for each row execute function public.dialpad_cti_guard_event();

-- ----------------------------------------------------------------------------
-- Privileged functions (service role only)
-- ----------------------------------------------------------------------------

create or replace function public.fn_claim_dialpad_member_binding(
  p_org_id uuid, p_user_id uuid, p_dialpad_user_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.dialpad_member_bindings%rowtype;
  v_new public.dialpad_member_bindings%rowtype;
begin
  if p_org_id is null or p_user_id is null or p_dialpad_user_id is null or p_dialpad_user_id !~ '^[0-9]{1,20}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('dialpad-binding:' || p_org_id::text || ':' || p_user_id::text, 0));
  if not exists (select 1 from public.dialpad_org_connections where org_id = p_org_id and status = 'active') then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'connection_inactive';
  end if;
  if not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_user_id and m.acquisitions_enabled)
     or not public.dialpad_cti_member_is_active(p_org_id, p_user_id) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'rep_not_active';
  end if;
  select * into v_existing from public.dialpad_member_bindings
    where org_id = p_org_id and user_id = p_user_id and status <> 'revoked';
  if found then
    if v_existing.dialpad_user_id = p_dialpad_user_id then
      return jsonb_build_object('bindingId', v_existing.id, 'status', v_existing.status,
        'dialpadUserId', v_existing.dialpad_user_id, 'replayed', true);
    end if;
    if v_existing.status = 'verified' then
      raise exception 'FORBIDDEN' using errcode = '42501', detail = 'binding_exists';
    end if;
    update public.dialpad_member_bindings
      set status = 'revoked', revoked_at = now(), revoked_reason = 'superseded_by_new_claim'
      where id = v_existing.id;
  end if;
  insert into public.dialpad_member_bindings (org_id, user_id, dialpad_user_id)
    values (p_org_id, p_user_id, p_dialpad_user_id) returning * into v_new;
  return jsonb_build_object('bindingId', v_new.id, 'status', v_new.status,
    'dialpadUserId', v_new.dialpad_user_id, 'replayed', false);
end;
$$;

create or replace function public.fn_verify_dialpad_member_binding(
  p_binding_id uuid, p_verification_kind text, p_verification_ref text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_binding public.dialpad_member_bindings%rowtype;
begin
  if p_binding_id is null or p_verification_kind not in ('provider_directory', 'signed_call_event', 'owner_attestation')
     or p_verification_ref is null or length(p_verification_ref) not between 1 and 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_binding from public.dialpad_member_bindings where id = p_binding_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_binding.status = 'verified' then
    return jsonb_build_object('bindingId', v_binding.id, 'status', 'verified', 'replayed', true);
  end if;
  if v_binding.status <> 'pending' then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'binding_not_pending';
  end if;
  if not public.dialpad_cti_member_is_active(v_binding.org_id, v_binding.user_id) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'rep_not_active';
  end if;
  begin
    update public.dialpad_member_bindings
      set status = 'verified', verified_at = now(),
          verification_kind = p_verification_kind, verification_ref = p_verification_ref
      where id = p_binding_id;
  exception when unique_violation then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'dialpad_user_already_bound';
  end;
  return jsonb_build_object('bindingId', p_binding_id, 'status', 'verified', 'replayed', false);
end;
$$;

create or replace function public.fn_revoke_dialpad_member_binding(
  p_binding_id uuid, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_binding public.dialpad_member_bindings%rowtype;
  v_cancelled integer;
begin
  if p_binding_id is null or p_reason is null or length(p_reason) not between 1 and 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_binding from public.dialpad_member_bindings where id = p_binding_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_binding.status = 'revoked' then
    return jsonb_build_object('bindingId', v_binding.id, 'status', 'revoked', 'cancelledIntents', 0, 'replayed', true);
  end if;
  update public.dialpad_member_bindings
    set status = 'revoked', revoked_at = now(), revoked_reason = p_reason where id = p_binding_id;
  -- Unmatched intents can no longer be used to start a call; matched ones keep
  -- their frozen attribution.
  update public.dialpad_call_intents set status = 'cancelled', cancelled_at = now()
    where binding_id = p_binding_id and status = 'prepared';
  get diagnostics v_cancelled = row_count;
  return jsonb_build_object('bindingId', p_binding_id, 'status', 'revoked', 'cancelledIntents', v_cancelled, 'replayed', false);
end;
$$;

create or replace function public.fn_grant_dialpad_caller(
  p_org_id uuid, p_user_id uuid, p_caller_number_e164 text, p_identity_type text, p_identity_id text, p_granted_by uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_grant public.dialpad_number_grants%rowtype;
begin
  if p_org_id is null or p_user_id is null or p_granted_by is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_granted_by and m.role = 'owner')
     or not public.dialpad_cti_member_is_active(p_org_id, p_granted_by) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'granter_not_owner';
  end if;
  if not public.dialpad_cti_member_is_active(p_org_id, p_user_id) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'rep_not_active';
  end if;
  select * into v_grant from public.dialpad_number_grants
    where org_id = p_org_id and user_id = p_user_id and caller_number_e164 = p_caller_number_e164
      and identity_type is not distinct from p_identity_type and identity_id is not distinct from p_identity_id
      and status = 'active';
  if found then
    return jsonb_build_object('grantId', v_grant.id, 'replayed', true);
  end if;
  insert into public.dialpad_number_grants (org_id, user_id, caller_number_e164, identity_type, identity_id, granted_by)
    values (p_org_id, p_user_id, p_caller_number_e164, p_identity_type, p_identity_id, p_granted_by)
    returning * into v_grant;
  return jsonb_build_object('grantId', v_grant.id, 'replayed', false);
end;
$$;

create or replace function public.fn_revoke_dialpad_caller_grant(p_grant_id uuid, p_revoked_by uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_grant public.dialpad_number_grants%rowtype;
  v_cancelled integer;
begin
  if p_grant_id is null or p_revoked_by is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_grant from public.dialpad_number_grants where id = p_grant_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.memberships m where m.org_id = v_grant.org_id and m.user_id = p_revoked_by and m.role = 'owner')
     or not public.dialpad_cti_member_is_active(v_grant.org_id, p_revoked_by) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'revoker_not_owner';
  end if;
  if v_grant.status = 'revoked' then
    return jsonb_build_object('grantId', v_grant.id, 'cancelledIntents', 0, 'replayed', true);
  end if;
  update public.dialpad_number_grants set status = 'revoked', revoked_at = now(), revoked_by = p_revoked_by
    where id = p_grant_id;
  update public.dialpad_call_intents set status = 'cancelled', cancelled_at = now()
    where number_grant_id = p_grant_id and status = 'prepared';
  get diagnostics v_cancelled = row_count;
  return jsonb_build_object('grantId', p_grant_id, 'cancelledIntents', v_cancelled, 'replayed', false);
end;
$$;

create or replace function public.fn_prepare_dialpad_call_intent(
  p_org_id uuid,
  p_rep_user_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_phone_slot smallint,
  p_idempotency_key uuid,
  p_number_grant_id uuid default null,
  p_ttl_seconds integer default 600
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_intent public.dialpad_call_intents%rowtype;
  v_conn public.dialpad_org_connections%rowtype;
  v_binding public.dialpad_member_bindings%rowtype;
  v_property public.properties%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_contact public.contacts%rowtype;
  v_grant public.dialpad_number_grants%rowtype;
  v_raw text;
  v_phone text;
  v_replayed boolean := false;
begin
  if p_org_id is null or p_rep_user_id is null or p_property_id is null or p_contact_id is null
     or p_idempotency_key is null or p_phone_slot is null or p_phone_slot not between 1 and 3
     or p_ttl_seconds is null or p_ttl_seconds not between 60 and 1800 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_object('propertyId', p_property_id, 'contactId', p_contact_id,
    'phoneSlot', p_phone_slot, 'grantId', p_number_grant_id, 'ttl', p_ttl_seconds)::text, 'utf8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('dialpad-intent:' || p_org_id::text || ':' || p_rep_user_id::text || ':' || p_idempotency_key::text, 0));

  select * into v_intent from public.dialpad_call_intents
    where org_id = p_org_id and rep_user_id = p_rep_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_intent.request_hash <> v_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
    v_replayed := true;
  end if;

  -- Authorization is re-proven on every call, including replays, so a rep who
  -- lost their binding or assignment cannot retrieve a live intent token.
  select * into v_conn from public.dialpad_org_connections where org_id = p_org_id;
  if not found or v_conn.status <> 'active' then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'connection_inactive';
  end if;
  if not exists (select 1 from public.acquisition_org_settings where org_id = p_org_id and my_leads_enabled) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'my_leads_disabled';
  end if;
  if not public.dialpad_cti_member_is_active(p_org_id, p_rep_user_id)
     or not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_rep_user_id and m.acquisitions_enabled) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'rep_not_active';
  end if;
  select * into v_binding from public.dialpad_member_bindings
    where org_id = p_org_id and user_id = p_rep_user_id and status = 'verified';
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'binding_not_verified';
  end if;

  select * into v_property from public.properties where id = p_property_id and org_id = p_org_id for share;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.deleted_at is not null then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'property_unavailable';
  end if;
  if coalesce(v_property.is_dnc_locked, false) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'property_dnc_locked';
  end if;
  select * into v_episode from public.acquisition_assignment_episodes
    where org_id = p_org_id and property_id = p_property_id and ended_at is null for share;
  if not found or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible
     or v_property.assigned_user_id is distinct from p_rep_user_id then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'not_assigned_rep';
  end if;

  select * into v_contact from public.contacts where id = p_contact_id and org_id = p_org_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.homeowner_contact_id is distinct from p_contact_id and not exists (
       select 1 from public.property_contacts pc
       where pc.org_id = p_org_id and pc.property_id = p_property_id and pc.contact_id = p_contact_id) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'contact_not_on_property';
  end if;
  if v_contact.do_not_contact then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'contact_do_not_contact';
  end if;
  v_raw := case p_phone_slot when 1 then v_contact.phone_1 when 2 then v_contact.phone_2 else v_contact.phone_3 end;
  v_phone := public.dialpad_cti_normalize_us_phone(v_raw);
  if v_phone is null then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'phone_unavailable';
  end if;
  if exists (select 1 from public.global_phone_dnc_registry r where r.org_id = p_org_id and r.phone_e164 = v_phone) then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'phone_dnc';
  end if;
  if p_number_grant_id is not null then
    select * into v_grant from public.dialpad_number_grants
      where id = p_number_grant_id and org_id = p_org_id and user_id = p_rep_user_id and status = 'active';
    if not found then
      raise exception 'FORBIDDEN' using errcode = '42501', detail = 'caller_grant_unavailable';
    end if;
  end if;

  if not v_replayed then
    insert into public.dialpad_call_intents (
      org_id, connection_id, rep_user_id, binding_id, dialpad_user_id, property_id, contact_id, phone_slot,
      destination_e164, assignment_episode_id, number_grant_id, caller_number_e164, caller_identity_type,
      caller_identity_id, custom_data, idempotency_key, request_hash, expires_at
    ) values (
      p_org_id, v_conn.id, p_rep_user_id, v_binding.id, v_binding.dialpad_user_id, p_property_id, p_contact_id, p_phone_slot,
      v_phone, v_episode.id, v_grant.id, v_grant.caller_number_e164, v_grant.identity_type,
      v_grant.identity_id, 'sandra.dialpad.v1.' || encode(extensions.gen_random_bytes(24), 'hex'), p_idempotency_key, v_hash,
      now() + make_interval(secs => p_ttl_seconds)
    ) returning * into v_intent;
  end if;

  return jsonb_build_object(
    'intentId', v_intent.id, 'customData', v_intent.custom_data, 'status', v_intent.status,
    'preparedAt', v_intent.prepared_at, 'expiresAt', v_intent.expires_at,
    'destinationE164', v_intent.destination_e164, 'phoneSlot', v_intent.phone_slot,
    'callerNumberE164', v_intent.caller_number_e164, 'callerIdentityType', v_intent.caller_identity_type,
    'callerIdentityId', v_intent.caller_identity_id, 'dialpadUserId', v_intent.dialpad_user_id,
    'propertyId', v_intent.property_id, 'contactId', v_intent.contact_id,
    'assignmentEpisodeId', v_intent.assignment_episode_id, 'replayed', v_replayed);
end;
$$;

create or replace function public.fn_cancel_dialpad_call_intent(
  p_org_id uuid, p_rep_user_id uuid, p_intent_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.dialpad_call_intents%rowtype;
begin
  select * into v_intent from public.dialpad_call_intents
    where id = p_intent_id and org_id = p_org_id and rep_user_id = p_rep_user_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_intent.status = 'cancelled' then
    return jsonb_build_object('intentId', v_intent.id, 'status', 'cancelled', 'replayed', true);
  end if;
  if v_intent.status <> 'prepared' then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'intent_already_matched';
  end if;
  update public.dialpad_call_intents set status = 'cancelled', cancelled_at = now() where id = p_intent_id;
  return jsonb_build_object('intentId', p_intent_id, 'status', 'cancelled', 'replayed', false);
end;
$$;

-- The caller verifies the HS256 JWT signature against the secret named by the
-- connection before calling this. Unverified deliveries must never reach it.
-- The raw JSON text is parsed here so 64-bit call ids keep every digit.
create or replace function public.fn_ingest_dialpad_call_event(
  p_org_id uuid, p_connection_id uuid, p_secret_version integer, p_payload text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_payload jsonb;
  v_conn public.dialpad_org_connections%rowtype;
  v_call text;
  v_state text;
  v_ts_text text;
  v_ts bigint;
  v_hash text;
  v_existing public.dialpad_call_events%rowtype;
  v_first public.dialpad_call_events%rowtype;
  v_row public.dialpad_call_events%rowtype;
begin
  if p_payload is null or length(p_payload) > 262144 or p_org_id is null or p_connection_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  begin
    v_payload := p_payload::jsonb;
  exception when others then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'payload_not_json';
  end;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'payload_not_object';
  end if;
  v_call := v_payload ->> 'call_id';
  v_state := v_payload ->> 'state';
  v_ts_text := v_payload ->> 'event_timestamp';
  if v_call is null or v_call !~ '^[0-9]{1,20}$' or v_state is null or length(v_state) not between 1 and 64
     or v_ts_text is null or v_ts_text !~ '^[0-9]{13,14}$' then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'missing_event_identity';
  end if;
  v_ts := v_ts_text::bigint;

  select * into v_conn from public.dialpad_org_connections
    where id = p_connection_id and org_id = p_org_id and status = 'active';
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501', detail = 'connection_inactive';
  end if;
  if p_secret_version is null or p_secret_version < 1 or p_secret_version > v_conn.webhook_secret_version then
    raise exception 'INVALID_INPUT' using errcode = '22023', detail = 'secret_version';
  end if;

  v_hash := encode(sha256(convert_to(v_payload::text, 'utf8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('dialpad-event:' || p_org_id::text || ':' || v_call || ':' || v_state || ':' || v_ts::text, 0));

  select * into v_existing from public.dialpad_call_events
    where org_id = p_org_id and provider_call_id = v_call and event_state = v_state
      and event_timestamp_ms = v_ts and payload_sha256 = v_hash;
  if found then
    return jsonb_build_object('eventId', v_existing.id, 'disposition', v_existing.disposition,
      'replayed', true, 'conflict', v_existing.disposition = 'conflict');
  end if;

  select * into v_first from public.dialpad_call_events
    where org_id = p_org_id and provider_call_id = v_call and event_state = v_state
      and event_timestamp_ms = v_ts and disposition <> 'conflict';
  if found then
    insert into public.dialpad_call_events (org_id, connection_id, provider_call_id, event_state, event_timestamp_ms,
        payload, payload_sha256, secret_version, disposition, disposition_reason, conflicts_with_event_id, disposed_at)
      values (p_org_id, p_connection_id, v_call, v_state, v_ts, v_payload, v_hash, p_secret_version,
        'conflict', 'same_event_key_different_payload', v_first.id, now())
      returning * into v_row;
    return jsonb_build_object('eventId', v_row.id, 'disposition', 'conflict', 'replayed', false, 'conflict', true);
  end if;

  insert into public.dialpad_call_events (org_id, connection_id, provider_call_id, event_state, event_timestamp_ms,
      payload, payload_sha256, secret_version)
    values (p_org_id, p_connection_id, v_call, v_state, v_ts, v_payload, v_hash, p_secret_version)
    returning * into v_row;
  return jsonb_build_object('eventId', v_row.id, 'disposition', 'received', 'replayed', false, 'conflict', false);
end;
$$;

-- Matches one inbox event to a prepared intent. It reads only frozen intent
-- attribution, never the rep's current binding or assignment, so a later
-- revocation cannot rewrite who a call belongs to. Safe to call again for
-- received or quarantined events (for example after an out-of-order arrival).
create or replace function public.fn_match_dialpad_call_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.dialpad_call_events%rowtype;
  v_intent public.dialpad_call_intents%rowtype;
  v_custom text;
  v_reason text;
  v_found boolean := false;
  c_skew_ms constant bigint := 5000;
begin
  select * into v_event from public.dialpad_call_events where id = p_event_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_event.disposition in ('matched', 'conflict') then
    return jsonb_build_object('eventId', v_event.id, 'disposition', v_event.disposition,
      'intentId', v_event.matched_intent_id, 'reason', v_event.disposition_reason, 'replayed', true);
  end if;

  v_custom := nullif(v_event.payload ->> 'custom_data', '');
  if v_custom is not null then
    select * into v_intent from public.dialpad_call_intents
      where org_id = v_event.org_id and custom_data = v_custom for update;
    v_found := found;
    if not v_found then v_reason := 'unknown_custom_data'; end if;
  else
    select * into v_intent from public.dialpad_call_intents
      where org_id = v_event.org_id and matched_provider_call_id = v_event.provider_call_id for update;
    v_found := found;
    if not v_found then v_reason := 'no_custom_data'; end if;
  end if;

  if v_found then
    if v_intent.status = 'cancelled' then
      v_reason := 'intent_cancelled';
    elsif v_intent.matched_provider_call_id is not null and v_intent.matched_provider_call_id <> v_event.provider_call_id then
      v_reason := 'intent_already_matched';
    elsif lower(coalesce(v_event.payload -> 'target' ->> 'type', '')) <> 'user'
       or (v_event.payload -> 'target' ->> 'id') is distinct from v_intent.dialpad_user_id then
      v_reason := 'target_mismatch';
    elsif (v_event.payload ->> 'external_number') is distinct from v_intent.destination_e164 then
      v_reason := 'number_mismatch';
    elsif v_intent.matched_provider_call_id is null and (
        v_event.event_timestamp_ms < floor(extract(epoch from v_intent.prepared_at) * 1000)::bigint - c_skew_ms
        or v_event.event_timestamp_ms > floor(extract(epoch from v_intent.expires_at) * 1000)::bigint) then
      v_reason := 'outside_intent_window';
    end if;
  end if;

  if v_reason is not null then
    update public.dialpad_call_events
      set disposition = 'quarantined', disposition_reason = v_reason, disposed_at = now()
      where id = v_event.id;
    return jsonb_build_object('eventId', v_event.id, 'disposition', 'quarantined', 'intentId', null,
      'reason', v_reason, 'replayed', false);
  end if;

  if v_intent.matched_provider_call_id is null then
    update public.dialpad_call_intents
      set status = 'matched', matched_provider_call_id = v_event.provider_call_id,
          matched_event_id = v_event.id, matched_at = now()
      where id = v_intent.id;
  end if;
  update public.dialpad_call_events
    set disposition = 'matched', disposition_reason = null, matched_intent_id = v_intent.id, disposed_at = now()
    where id = v_event.id;
  return jsonb_build_object('eventId', v_event.id, 'disposition', 'matched', 'intentId', v_intent.id,
    'reason', null, 'replayed', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- Row level security and grants
-- ----------------------------------------------------------------------------

alter table public.dialpad_org_connections enable row level security;
alter table public.dialpad_member_bindings enable row level security;
alter table public.dialpad_number_grants enable row level security;
alter table public.dialpad_call_intents enable row level security;
alter table public.dialpad_call_events enable row level security;

revoke all on table public.dialpad_org_connections from public, anon, authenticated, service_role;
revoke all on table public.dialpad_member_bindings from public, anon, authenticated, service_role;
revoke all on table public.dialpad_number_grants from public, anon, authenticated, service_role;
revoke all on table public.dialpad_call_intents from public, anon, authenticated, service_role;
revoke all on table public.dialpad_call_events from public, anon, authenticated, service_role;

-- Active members read only the non-secret connection columns of an active
-- connection; the secret reference and version stay service-only.
grant select (id, org_id, status, cti_client_id, allowed_origins) on public.dialpad_org_connections to authenticated;
grant select, insert, update on public.dialpad_org_connections to service_role;
grant select on public.dialpad_member_bindings to authenticated, service_role;
grant select on public.dialpad_number_grants to authenticated, service_role;
grant select on public.dialpad_call_intents to authenticated, service_role;
grant select on public.dialpad_call_events to service_role;

drop policy if exists dialpad_org_connections_member_select on public.dialpad_org_connections;
create policy dialpad_org_connections_member_select on public.dialpad_org_connections
  for select to authenticated
  using (status = 'active' and public.dialpad_cti_caller_is_active_member(org_id));

drop policy if exists dialpad_member_bindings_own_select on public.dialpad_member_bindings;
create policy dialpad_member_bindings_own_select on public.dialpad_member_bindings
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists dialpad_number_grants_own_select on public.dialpad_number_grants;
create policy dialpad_number_grants_own_select on public.dialpad_number_grants
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists dialpad_call_intents_own_select on public.dialpad_call_intents;
create policy dialpad_call_intents_own_select on public.dialpad_call_intents
  for select to authenticated
  using (rep_user_id = (select auth.uid()));

revoke all on function public.dialpad_cti_origins_valid(text[]) from public, anon, authenticated;
revoke all on function public.dialpad_cti_normalize_us_phone(text) from public, anon, authenticated;
revoke all on function public.dialpad_cti_member_is_active(uuid, uuid) from public, anon, authenticated;
revoke all on function public.dialpad_cti_caller_is_active_member(uuid) from public, anon;
grant execute on function public.dialpad_cti_caller_is_active_member(uuid) to authenticated;
grant execute on function public.dialpad_cti_origins_valid(text[]) to service_role;

revoke all on function public.dialpad_cti_touch_connection() from public, anon, authenticated;
revoke all on function public.dialpad_cti_guard_connection() from public, anon, authenticated;
revoke all on function public.dialpad_cti_guard_binding() from public, anon, authenticated;
revoke all on function public.dialpad_cti_guard_grant() from public, anon, authenticated;
revoke all on function public.dialpad_cti_guard_intent() from public, anon, authenticated;
revoke all on function public.dialpad_cti_guard_event() from public, anon, authenticated;

revoke all on function public.fn_claim_dialpad_member_binding(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fn_verify_dialpad_member_binding(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fn_revoke_dialpad_member_binding(uuid, text) from public, anon, authenticated;
revoke all on function public.fn_grant_dialpad_caller(uuid, uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.fn_revoke_dialpad_caller_grant(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_prepare_dialpad_call_intent(uuid, uuid, uuid, uuid, smallint, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.fn_cancel_dialpad_call_intent(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.fn_ingest_dialpad_call_event(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.fn_match_dialpad_call_event(uuid) from public, anon, authenticated;

grant execute on function public.fn_claim_dialpad_member_binding(uuid, uuid, text) to service_role;
grant execute on function public.fn_verify_dialpad_member_binding(uuid, text, text) to service_role;
grant execute on function public.fn_revoke_dialpad_member_binding(uuid, text) to service_role;
grant execute on function public.fn_grant_dialpad_caller(uuid, uuid, text, text, text, uuid) to service_role;
grant execute on function public.fn_revoke_dialpad_caller_grant(uuid, uuid) to service_role;
grant execute on function public.fn_prepare_dialpad_call_intent(uuid, uuid, uuid, uuid, smallint, uuid, uuid, integer) to service_role;
grant execute on function public.fn_cancel_dialpad_call_intent(uuid, uuid, uuid) to service_role;
grant execute on function public.fn_ingest_dialpad_call_event(uuid, uuid, integer, text) to service_role;
grant execute on function public.fn_match_dialpad_call_event(uuid) to service_role;

commit;
