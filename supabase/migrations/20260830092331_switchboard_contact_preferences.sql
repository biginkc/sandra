-- Authenticated, replay-safe contact preferences from Switchboard.
-- The function keeps caller matching, preference mutation, sequence pausing,
-- and audit completion in one transaction. It never accepts a DNC clear.

begin;

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_check;
alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array[
    'lead',
    'provider',
    'jitter_writeback',
    'closer_practice',
    'bmh_institute_course',
    'switchboard_contact_preference'
  ]));

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_source_match_check;
alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type in (
      'provider',
      'jitter_writeback',
      'closer_practice',
      'bmh_institute_course',
      'switchboard_contact_preference'
    ) and default_source is null)
  );

create table if not exists public.global_phone_dnc_registry (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  phone_e164 text not null,
  first_webhook_event_id uuid references public.webhook_events(id),
  first_consumer_id uuid not null,
  first_source_event_id text not null,
  first_evidence_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint global_phone_dnc_registry_phone_check
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint global_phone_dnc_registry_evidence_check
    check (first_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  constraint global_phone_dnc_registry_org_phone_key unique (org_id, phone_e164)
);

alter table public.global_phone_dnc_registry enable row level security;
revoke all on table public.global_phone_dnc_registry
  from public, anon, authenticated;

create or replace function public.reject_global_phone_dnc_registry_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'GLOBAL_PHONE_DNC_LOCKED: registry entries are append-only'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists global_phone_dnc_registry_append_only
  on public.global_phone_dnc_registry;
create trigger global_phone_dnc_registry_append_only
  before update or delete on public.global_phone_dnc_registry
  for each row execute function public.reject_global_phone_dnc_registry_mutation();

create or replace function public.apply_global_phone_dnc_to_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.global_phone_dnc_registry registry
    where registry.org_id = new.org_id
      and registry.phone_e164 in (new.phone_1, new.phone_2, new.phone_3)
  ) then
    new.do_not_contact := true;
  end if;
  return new;
end;
$$;

-- This name deliberately sorts after the existing PR #310 guards. An import
-- may add a registered phone as an ordinary contact change; the final guard
-- ratchets DNC without making the earlier mixed-update guard reject the row.
drop trigger if exists zz_apply_global_phone_dnc_to_contact on public.contacts;
create trigger zz_apply_global_phone_dnc_to_contact
  before insert or update of org_id, phone_1, phone_2, phone_3
  on public.contacts
  for each row execute function public.apply_global_phone_dnc_to_contact();

-- PostgreSQL UPDATE OF triggers are based on the statement target list, so
-- the historical do_not_contact propagation trigger does not run when the
-- before-trigger above changes NEW. This phone-targeted after trigger closes
-- that gap and preserves contact-then-property lock ordering.
drop trigger if exists global_phone_dnc_propagate_contact_lock on public.contacts;
create trigger global_phone_dnc_propagate_contact_lock
  after update of org_id, phone_1, phone_2, phone_3
  on public.contacts
  for each row
  when (new.do_not_contact and not old.do_not_contact)
  execute function public.contacts_propagate_true_dnc_lock();

create or replace function public.apply_global_dnc_to_sequence_enrollment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.properties property
    where property.id = new.property_id
      and property.org_id = new.org_id
      and property.is_dnc_locked
  ) then
    new.status := 'opted_out';
    new.pause_reason := 'dnc';
    new.next_run_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists aa_apply_global_dnc_to_sequence_enrollment
  on public.sequence_enrollments;
create trigger aa_apply_global_dnc_to_sequence_enrollment
  before insert on public.sequence_enrollments
  for each row execute function public.apply_global_dnc_to_sequence_enrollment();

-- Preserve the existing one-way enrollment guard while allowing the
-- preceding trigger to turn a late insert into its only compliant state.
create or replace function public.guard_locked_property_sequence_enrollment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  property_id uuid;
  property_is_locked boolean;
begin
  for property_id in
    select distinct candidate
    from unnest(array[
      case when tg_op <> 'INSERT' then old.property_id else null end,
      case when tg_op <> 'DELETE' then new.property_id else null end
    ]) as candidates(candidate)
    where candidate is not null
    order by candidate
  loop
    select p.is_dnc_locked into property_is_locked
    from public.properties p
    where p.id = property_id
    for no key update;
    if coalesce(property_is_locked, false) then
      if tg_op = 'INSERT'
        and new.status = 'opted_out'
        and new.pause_reason = 'dnc'
        and new.next_run_at is null
      then
        return new;
      end if;
      if tg_op = 'UPDATE'
        and old.status in ('active', 'paused')
        and new.status = 'opted_out'
        and new.pause_reason in ('dnc', 'consent_revoked')
        and new.next_run_at is null
        and (
          to_jsonb(new) - array[
            'status', 'pause_reason', 'next_run_at', 'updated_at'
          ]::text[]
        ) = (
          to_jsonb(old) - array[
            'status', 'pause_reason', 'next_run_at', 'updated_at'
          ]::text[]
        )
      then
        return new;
      end if;
      raise exception using
        errcode = 'P0001',
        message = 'DNC_LOCKED: sequence enrollment is immutable except for the compliance opt-out';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.acquire_global_dnc_write_barrier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'switchboard-global-dnc-write-barrier-v1',
      0
    )
  );
  return null;
end;
$$;

drop trigger if exists global_dnc_contacts_write_barrier on public.contacts;
create trigger global_dnc_contacts_write_barrier
  before insert or update or delete on public.contacts
  for each statement execute function public.acquire_global_dnc_write_barrier();

drop trigger if exists global_dnc_properties_write_barrier on public.properties;
create trigger global_dnc_properties_write_barrier
  before insert or update or delete on public.properties
  for each statement execute function public.acquire_global_dnc_write_barrier();

drop trigger if exists global_dnc_enrollments_write_barrier
  on public.sequence_enrollments;
create trigger global_dnc_enrollments_write_barrier
  before insert or update or delete on public.sequence_enrollments
  for each statement execute function public.acquire_global_dnc_write_barrier();

drop function if exists public.apply_switchboard_contact_preferences(
  uuid, uuid, text, text, text, text, text, text, text, text,
  timestamptz, text, text, text, boolean, boolean, text, text,
  text, text, text, text
);

create or replace function public.apply_switchboard_contact_preferences(
  p_org_id uuid,
  p_consumer_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_event_source text,
  p_event_type text,
  p_source_event_id text,
  p_provider_call_id text,
  p_intent_marker_id text,
  p_conversation_id text,
  p_provider_timestamp timestamptz,
  p_correlation_id text,
  p_caller_phone_e164 text,
  p_property_disposition text,
  p_global_dnc_requested boolean,
  p_manual_review_required boolean,
  p_evidence_category text,
  p_evidence_sha256 text,
  p_address_normalized text,
  p_address_city text,
  p_address_state text,
  p_address_postal_code text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_existing_event record;
  v_contact_ids uuid[];
  v_contact_count integer := 0;
  v_property_ids uuid[] := '{}'::uuid[];
  v_resolved_property_id uuid;
  v_resolved_property_count integer := 0;
  v_prior_disposition text;
  v_new_disposition text;
  v_property_disposition_applied boolean := false;
  v_contacts_ratcheted integer := 0;
  v_properties_locked integer := 0;
  v_property_enrollments_paused integer := 0;
  v_global_enrollments_paused integer := 0;
  v_global_suppression_preexisting boolean := false;
  v_global_registry_preexisting boolean := false;
  v_resolution text := 'phone_matched';
  v_response jsonb;
  v_audit jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  if p_idempotency_key is null
    or length(p_idempotency_key) not between 1 and 128
    or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_caller_phone_e164 !~ '^\+[1-9][0-9]{7,14}$'
    or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or p_global_dnc_requested is null
    or p_manual_review_required is null
    or length(coalesce(p_event_source, '')) not between 1 and 128
    or length(coalesce(p_event_type, '')) not between 1 and 128
    or length(coalesce(p_source_event_id, '')) not between 1 and 128
    or length(coalesce(p_provider_call_id, '')) not between 1 and 128
    or length(coalesce(p_intent_marker_id, '')) not between 1 and 128
    or length(coalesce(p_correlation_id, '')) not between 1 and 128
    or p_event_source <> 'provider_call'
    or p_event_type <> 'contact_preference.explicit'
    or p_provider_timestamp < statement_timestamp() - interval '7 days'
    or p_provider_timestamp > statement_timestamp() + interval '5 minutes'
    or p_evidence_category not in (
      'explicit_not_interested',
      'explicit_do_not_contact',
      'explicit_not_interested_and_do_not_contact'
    )
    or (
      p_evidence_category = 'explicit_not_interested'
      and p_intent_marker_id <> 'analysis:property_disposition'
    )
    or (
      p_evidence_category = 'explicit_do_not_contact'
      and p_intent_marker_id <> 'analysis:global_dnc_requested'
    )
    or (
      p_evidence_category = 'explicit_not_interested_and_do_not_contact'
      and p_intent_marker_id <> 'analysis:both'
    )
    or p_evidence_sha256 <> encode(
      extensions.digest(
        convert_to('switchboard_contact_preference_v1', 'UTF8')
        || decode('00', 'hex')
        || convert_to(p_idempotency_key, 'UTF8')
        || decode('00', 'hex')
        || convert_to(p_evidence_category, 'UTF8')
        || decode('00', 'hex')
        || convert_to(p_intent_marker_id, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
    or (
      p_evidence_category = 'explicit_not_interested'
      and (
        p_property_disposition is distinct from 'not_interested'
        or p_global_dnc_requested
      )
    )
    or (
      p_evidence_category = 'explicit_do_not_contact'
      and (
        p_property_disposition is not null
        or not p_global_dnc_requested
      )
    )
    or (
      p_evidence_category = 'explicit_not_interested_and_do_not_contact'
      and (
        not p_global_dnc_requested
        or (
          not p_manual_review_required
          and p_property_disposition is distinct from 'not_interested'
        )
        or (
          p_manual_review_required
          and p_property_disposition is not null
          and p_property_disposition <> 'not_interested'
        )
      )
    )
    or p_property_disposition = 'not_interested'
       and p_evidence_category not in (
         'explicit_not_interested',
         'explicit_not_interested_and_do_not_contact'
       )
    or p_global_dnc_requested
       and p_evidence_category not in (
         'explicit_do_not_contact',
         'explicit_not_interested_and_do_not_contact'
       )
    or p_property_disposition not in ('not_interested')
       and p_property_disposition is not null
    or coalesce(p_global_dnc_requested, false) is false
       and p_property_disposition is null
  then
    raise exception 'invalid switchboard preference request'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.webhook_consumers consumer
    where consumer.id = p_consumer_id
      and consumer.org_id = p_org_id
      and consumer.consumer_type = 'switchboard_contact_preference'
      and consumer.enabled
      and consumer.revoked_at is null
  ) then
    raise exception 'invalid switchboard consumer' using errcode = '42501';
  end if;

  if p_manual_review_required
    and p_property_disposition = 'not_interested'
    and not p_global_dnc_requested
  then
    return jsonb_build_object('outcome', 'preference_not_applied');
  end if;

  insert into public.webhook_events (
    org_id,
    provider,
    event_type,
    external_id,
    signature_verified,
    request_hash,
    processing_status,
    payload
  ) values (
    p_org_id,
    'switchboard',
    'contact_preference',
    p_idempotency_key,
    true,
    p_request_hash,
    'pending',
    jsonb_build_object(
      'consumer_id', p_consumer_id,
      'request', jsonb_build_object(
        'event_source', p_event_source,
        'event_type', p_event_type,
        'source_event_id', p_source_event_id,
        'provider_call_id', p_provider_call_id,
        'intent_marker_id', p_intent_marker_id,
        'conversation_id', p_conversation_id,
        'provider_timestamp', p_provider_timestamp,
        'correlation_id', p_correlation_id,
        'property_disposition', p_property_disposition,
        'global_dnc_requested', p_global_dnc_requested,
        'manual_review_required', p_manual_review_required,
        'evidence_category', p_evidence_category,
        'evidence_sha256', p_evidence_sha256,
        'address_supplied', p_address_normalized is not null
      )
    )
  )
  on conflict (org_id, provider, event_type, external_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select event.id, event.request_hash, event.processing_status, event.payload
    into v_existing_event
    from public.webhook_events event
    where event.org_id = p_org_id
      and event.provider = 'switchboard'
      and event.event_type = 'contact_preference'
      and event.external_id = p_idempotency_key
    for update;

    if not found or v_existing_event.request_hash is distinct from p_request_hash then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    if v_existing_event.processing_status = 'processed' then
      if v_existing_event.payload -> 'response' ->> 'error'
        = 'preference_not_applied'
      then
        return jsonb_build_object('outcome', 'preference_not_applied');
      end if;
      return jsonb_build_object('outcome', 'replayed');
    end if;
    v_event_id := v_existing_event.id;
  end if;

  if p_global_dnc_requested then
    -- All relevant DML statements acquire this same transaction-scoped
    -- barrier before row triggers or row locks. It serializes the low-volume
    -- v1 compliance boundary without imposing a cross-table lock order that
    -- can invert against existing property-first/contact-second writers.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'switchboard-global-dnc-write-barrier-v1',
        0
      )
    );
  end if;

  select exists (
    select 1
    from public.global_phone_dnc_registry registry
    where registry.org_id = p_org_id
      and registry.phone_e164 = p_caller_phone_e164
  ) into v_global_registry_preexisting;

  if p_global_dnc_requested then
    insert into public.global_phone_dnc_registry (
      org_id,
      phone_e164,
      first_webhook_event_id,
      first_consumer_id,
      first_source_event_id,
      first_evidence_sha256
    ) values (
      p_org_id,
      p_caller_phone_e164,
      v_event_id,
      p_consumer_id,
      p_source_event_id,
      p_evidence_sha256
    )
    on conflict (org_id, phone_e164) do nothing;
  end if;

  -- Every preference request takes locks in contact-id then property-id order.
  -- This makes concurrent property and global preferences converge on DNC.
  perform 1
  from public.contacts contact
  where contact.org_id = p_org_id
    and p_caller_phone_e164 in (
      contact.phone_1,
      contact.phone_2,
      contact.phone_3
    )
  order by contact.id
  for update;

  select coalesce(array_agg(contact.id order by contact.id), '{}'::uuid[])
  into v_contact_ids
  from public.contacts contact
  where contact.org_id = p_org_id
    and p_caller_phone_e164 in (
      contact.phone_1,
      contact.phone_2,
      contact.phone_3
    );
  v_contact_count := cardinality(v_contact_ids);

  if v_contact_count = 0 then
    v_resolution := 'phone_registry_only';
    if not p_global_dnc_requested then
      v_response := jsonb_build_object('error', 'preference_not_applied');
      update public.webhook_events
      set processing_status = 'processed',
          processed_at = statement_timestamp(),
          payload = payload || jsonb_build_object(
            'resolution', jsonb_build_object('status', 'unmatched'),
            'response', v_response
          )
      where id = v_event_id
        and request_hash = p_request_hash;
      return jsonb_build_object('outcome', 'preference_not_applied');
    end if;
  end if;

  perform 1
  from public.properties property
  where property.org_id = p_org_id
    and property.deleted_at is null
    and property.homeowner_contact_id = any(v_contact_ids)
  order by property.id
  for update;

  select coalesce(array_agg(property.id order by property.id), '{}'::uuid[])
  into v_property_ids
  from public.properties property
  where property.org_id = p_org_id
    and property.deleted_at is null
    and property.homeowner_contact_id = any(v_contact_ids);

  select exists (
    select 1
    from public.contacts contact
    where contact.id = any(v_contact_ids)
      and contact.do_not_contact
  ) or exists (
    select 1
    from public.properties property
    where property.id = any(v_property_ids)
      and property.is_dnc_locked
  ) or v_global_registry_preexisting
  into v_global_suppression_preexisting;

  if p_property_disposition = 'not_interested'
    and not p_manual_review_required
  then
    if p_address_normalized is null then
      select count(*), min(property.id::text)::uuid
      into v_resolved_property_count, v_resolved_property_id
      from public.properties property
      where property.id = any(v_property_ids);
    else
      select count(*), min(property.id::text)::uuid
      into v_resolved_property_count, v_resolved_property_id
      from public.properties property
      where property.id = any(v_property_ids)
        and property.address_normalized = p_address_normalized
        and (
          p_address_city is null
          or lower(btrim(coalesce(property.city, ''))) = lower(btrim(p_address_city))
        )
        and (
          p_address_state is null
          or upper(btrim(coalesce(property.state, ''))) = upper(btrim(p_address_state))
        )
        and (
          p_address_postal_code is null
          or btrim(coalesce(property.zip, '')) = btrim(p_address_postal_code)
        );
    end if;

    if v_resolved_property_count <> 1 then
      v_resolution := 'ambiguous_or_conflicting';
      v_resolved_property_id := null;
      if not p_global_dnc_requested then
        v_response := jsonb_build_object('error', 'preference_not_applied');
        update public.webhook_events
        set processing_status = 'processed',
            processed_at = statement_timestamp(),
            payload = payload || jsonb_build_object(
              'resolution', jsonb_build_object(
                'status', v_resolution,
                'phone_match_count', v_contact_count
              ),
              'response', v_response
            )
        where id = v_event_id
          and request_hash = p_request_hash;
        return jsonb_build_object('outcome', 'preference_not_applied');
      end if;
    elsif not v_global_suppression_preexisting then
      select property.outreach_dispo
      into v_prior_disposition
      from public.properties property
      where property.id = v_resolved_property_id;

      if v_prior_disposition is null or v_prior_disposition = 'not_interested' then
        update public.properties property
        set outreach_dispo = 'not_interested',
            follow_up_at = null,
            updated_at = statement_timestamp()
        where property.id = v_resolved_property_id
          and property.org_id = p_org_id
          and not property.is_dnc_locked
          and property.outreach_dispo is null;
        v_property_disposition_applied := found;

        update public.sequence_enrollments enrollment
        set status = 'paused',
            pause_reason = 'not_interested',
            updated_at = statement_timestamp()
        where enrollment.org_id = p_org_id
          and enrollment.property_id = v_resolved_property_id
          and enrollment.status = 'active';
        get diagnostics v_property_enrollments_paused = row_count;
      end if;

      if v_property_disposition_applied then
        insert into public.lead_events (
          org_id,
          property_id,
          actor_type,
          event_type,
          payload,
          source_type,
          source_id
        ) values (
          p_org_id,
          v_resolved_property_id,
          'system',
          'dispo_set',
          jsonb_build_object(
            'from', v_prior_disposition,
            'to', 'not_interested',
            'trigger', 'switchboard_contact_preference',
            'provider_call_id', p_provider_call_id,
            'intent_marker_id', p_intent_marker_id,
            'evidence_category', p_evidence_category,
            'evidence_sha256', p_evidence_sha256,
            'manual_review_required', p_manual_review_required
          ),
          'webhook_events.switchboard_contact_preference',
          v_event_id
        )
        on conflict (source_type, source_id)
          where source_id is not null do nothing;
      end if;
    end if;
  end if;

  if p_global_dnc_requested then
    update public.contacts contact
    set do_not_contact = true
    where contact.id = any(v_contact_ids)
      and contact.org_id = p_org_id
      and not contact.do_not_contact;
    get diagnostics v_contacts_ratcheted = row_count;

    -- Defense in depth for an already-DNC contact linked after the historical
    -- propagation migration: the property lock is also a one-way ratchet.
    update public.properties property
    set is_dnc_locked = true
    where property.id = any(v_property_ids)
      and property.org_id = p_org_id
      and not property.is_dnc_locked;
    get diagnostics v_properties_locked = row_count;

    update public.sequence_enrollments enrollment
    set status = 'opted_out',
        pause_reason = 'dnc',
        next_run_at = null,
        updated_at = statement_timestamp()
    where enrollment.org_id = p_org_id
      and enrollment.property_id = any(v_property_ids)
      and enrollment.status in ('active', 'paused');
    get diagnostics v_global_enrollments_paused = row_count;
  end if;

  if v_resolved_property_id is not null then
    select property.outreach_dispo
    into v_new_disposition
    from public.properties property
    where property.id = v_resolved_property_id;
  end if;

  v_response := jsonb_build_object('status', 'applied');
  v_audit := jsonb_build_object(
    'status', v_resolution,
    'phone_match_count', v_contact_count,
    'linked_property_count', cardinality(v_property_ids),
    'resolved_property_id', v_resolved_property_id,
    'prior_property_disposition', v_prior_disposition,
    'new_property_disposition', v_new_disposition,
    'property_disposition_requested', p_property_disposition,
    'property_disposition_applied', v_property_disposition_applied,
    'global_dnc_requested', p_global_dnc_requested,
    'global_suppression_preexisting', v_global_suppression_preexisting,
    'global_suppression_effective', (
      v_global_suppression_preexisting or p_global_dnc_requested
    ),
    'contacts_ratcheted', v_contacts_ratcheted,
    'properties_locked', v_properties_locked,
    'property_enrollments_paused', v_property_enrollments_paused,
    'global_enrollments_paused', v_global_enrollments_paused
  );

  update public.webhook_events
  set processing_status = 'processed',
      processed_at = statement_timestamp(),
      payload = payload || jsonb_build_object(
        'resolution', v_audit,
        'response', v_response
      )
  where id = v_event_id
    and request_hash = p_request_hash;
  if not found then
    raise exception 'switchboard idempotency reservation missing or changed';
  end if;

  return jsonb_build_object('outcome', 'applied');
end;
$$;

revoke all on function public.apply_switchboard_contact_preferences(
  uuid, uuid, text, text, text, text, text, text, text, text,
  timestamptz, text, text, text, boolean, boolean, text, text,
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_switchboard_contact_preferences(
  uuid, uuid, text, text, text, text, text, text, text, text,
  timestamptz, text, text, text, boolean, boolean, text, text,
  text, text, text, text
) to service_role;

commit;
