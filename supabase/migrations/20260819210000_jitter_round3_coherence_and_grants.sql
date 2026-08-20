-- Sandra/Jitter route hardening, round 3.
--
-- This is a forward repair for databases that already ran the earlier
-- claim/idempotency migrations.  Each route mutation has exactly one
-- SECURITY DEFINER RPC.  The RPC is callable by service_role only and owns
-- the coherence checks, mutation, and response receipt in one transaction.

begin;

-- Only hashes that are malformed as hashes are legacy-ambiguous.  A valid
-- 64-character hash is retained, including a valid hash from an older route
-- implementation; pending rows are not blanket-reset.
update public.webhook_events
set request_hash = null
where provider = 'jitter'
  and processing_status = 'pending'
  and request_hash is not null
  and request_hash !~ '^[0-9a-f]{64}$';

-- webhook_events is an internal receipt/idempotency table.  Authenticated
-- org members may read their own rows, but may not create, alter, or delete
-- receipts.  The Jitter RPCs run as service_role and write their own receipt.
drop policy if exists webhook_events_org_insert on public.webhook_events;
drop policy if exists webhook_events_org_update on public.webhook_events;
drop policy if exists webhook_events_org_delete on public.webhook_events;
revoke insert, update, delete on table public.webhook_events
  from public, anon, authenticated;
grant select on table public.webhook_events to authenticated;
grant all on table public.webhook_events to service_role;

-- Remove the mutation-only helper overloads.  The remaining signatures below
-- are the sole SECURITY DEFINER function for each mutation.
drop function if exists public.jitter_claim_dialer_batch(uuid, uuid, text);
drop function if exists public.jitter_patch_dialer_batch_item(uuid, uuid, text, bigint, text);

create or replace function public.jitter_claim_dialer_batch(
  p_batch_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_external_id text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.dialer_batches%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  -- Lock and validate the complete parent/item/property/contact chain before
  -- changing the batch.  Unknown and foreign batches remain indistinguishable
  -- to the route; malformed tenant graphs fail closed with one error.
  select b.* into v_batch
  from public.dialer_batches as b
  where b.id = p_batch_id
    and b.org_id = p_org_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if exists (
    select 1
    from public.dialer_batch_items as i
    left join public.dialer_batches as b on b.id = i.batch_id
    left join public.properties as p on p.id = i.property_id
    left join public.contacts as c on c.id = i.contact_id
    where i.batch_id = v_batch.id
      and (
        b.org_id is distinct from p_org_id
        or p.org_id is distinct from p_org_id
        or c.org_id is distinct from p_org_id
      )
  ) then
    raise exception 'jitter coherence check failed';
  end if;

  if v_batch.status = 'pending' then
    update public.dialer_batches as b
    set status = 'claimed',
        jitter_session_id = p_session_id,
        claimed_at = statement_timestamp(),
        claim_generation = b.claim_generation + 1,
        updated_at = statement_timestamp()
    where b.id = v_batch.id
    returning b.* into v_batch;

    update public.webhook_events
    set payload = jsonb_build_object('batch', jsonb_build_object(
          'id', v_batch.id,
          'org_id', v_batch.org_id,
          'status', v_batch.status,
          'jitter_session_id', v_batch.jitter_session_id,
          'claimed_at', v_batch.claimed_at,
          'claim_generation', v_batch.claim_generation
        )),
        processing_status = 'processed',
        processed_at = statement_timestamp()
    where org_id = p_org_id
      and provider = 'jitter'
      and event_type = 'dialer_batch_claim'
      and external_id = p_external_id
      and processing_status = 'pending'
      and request_hash = p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;

    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_batch.id,
        'org_id', v_batch.org_id,
        'status', v_batch.status,
        'jitter_session_id', v_batch.jitter_session_id,
        'claimed_at', v_batch.claimed_at,
        'claim_generation', v_batch.claim_generation
      )
    );
  end if;

  if v_batch.status = 'claimed'
     and v_batch.jitter_session_id = p_session_id then
    update public.webhook_events
    set payload = jsonb_build_object('batch', jsonb_build_object(
          'id', v_batch.id,
          'org_id', v_batch.org_id,
          'status', v_batch.status,
          'jitter_session_id', v_batch.jitter_session_id,
          'claimed_at', v_batch.claimed_at,
          'claim_generation', v_batch.claim_generation
        )),
        processing_status = 'processed',
        processed_at = statement_timestamp()
    where org_id = p_org_id
      and provider = 'jitter'
      and event_type = 'dialer_batch_claim'
      and external_id = p_external_id
      and processing_status = 'pending'
      and request_hash = p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;

    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_batch.id,
        'org_id', v_batch.org_id,
        'status', v_batch.status,
        'jitter_session_id', v_batch.jitter_session_id,
        'claimed_at', v_batch.claimed_at,
        'claim_generation', v_batch.claim_generation
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', 'conflict',
    'status', v_batch.status,
    'jitter_session_id', v_batch.jitter_session_id,
    'claim_generation', v_batch.claim_generation
  );
end;
$$;

revoke all on function public.jitter_claim_dialer_batch(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_claim_dialer_batch(uuid, uuid, text, text, text)
  to service_role;

create or replace function public.jitter_patch_dialer_batch_item(
  p_item_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_claim_generation bigint,
  p_status text,
  p_external_id text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.dialer_batches%rowtype;
  v_item public.dialer_batch_items%rowtype;
  v_property_org uuid;
  v_contact_org uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  select b.* into v_batch
  from public.dialer_batches as b
  join public.dialer_batch_items as i on i.batch_id = b.id
  where i.id = p_item_id
    and b.org_id = p_org_id
  for update of b;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select i.* into v_item
  from public.dialer_batch_items as i
  where i.id = p_item_id
    and i.batch_id = v_batch.id;
  select p.org_id into v_property_org
  from public.properties as p
  where p.id = v_item.property_id;
  select c.org_id into v_contact_org
  from public.contacts as c
  where c.id = v_item.contact_id;

  if v_property_org is distinct from p_org_id
     or v_contact_org is distinct from p_org_id
     or v_batch.org_id is distinct from p_org_id then
    raise exception 'jitter coherence check failed';
  end if;

  if v_batch.status <> 'claimed'
     or v_batch.jitter_session_id is distinct from p_session_id
     or v_batch.claim_generation is distinct from p_claim_generation then
    return jsonb_build_object('outcome', 'stale_claim');
  end if;

  update public.dialer_batch_items as i
  set status = p_status,
      updated_at = statement_timestamp()
  where i.id = v_item.id
    and i.batch_id = v_batch.id
  returning i.* into v_item;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  update public.webhook_events
  set payload = jsonb_build_object('item', jsonb_build_object(
        'id', v_item.id,
        'batch_id', v_item.batch_id,
        'property_id', v_item.property_id,
        'contact_id', v_item.contact_id,
        'phone_e164', v_item.phone_e164,
        'status', v_item.status
      )),
      processing_status = 'processed',
      processed_at = statement_timestamp()
  where org_id = p_org_id
    and provider = 'jitter'
    and event_type = 'dialer_batch_item_patch'
    and external_id = p_external_id
    and processing_status = 'pending'
    and request_hash = p_request_hash;
  if not found then
    raise exception 'idempotency reservation missing or hash mismatch';
  end if;

  return jsonb_build_object(
    'outcome', 'updated',
    'item', jsonb_build_object(
      'id', v_item.id,
      'batch_id', v_item.batch_id,
      'property_id', v_item.property_id,
      'contact_id', v_item.contact_id,
      'phone_e164', v_item.phone_e164,
      'status', v_item.status
    )
  );
end;
$$;

revoke all on function public.jitter_patch_dialer_batch_item(uuid, uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_patch_dialer_batch_item(uuid, uuid, text, bigint, text, text, text)
  to service_role;

create or replace function public.jitter_upsert_call_recording(
  p_call_activity_id uuid,
  p_org_id uuid,
  p_status text,
  p_storage_path text,
  p_duration_seconds integer,
  p_error_code text,
  p_error_message text,
  p_external_id text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.call_activities%rowtype;
  v_item record;
  v_recording_id uuid;
  v_recording public.call_recordings%rowtype;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  select a.* into v_activity
  from public.call_activities as a
  where a.id = p_call_activity_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_activity.org_id is distinct from p_org_id
     or v_activity.provider is distinct from 'jitter' then
    raise exception 'jitter coherence check failed';
  end if;

  if v_activity.dialer_batch_item_id is not null then
    select i.id, i.batch_id, i.property_id as item_property_id,
           i.contact_id as item_contact_id, b.org_id as batch_org_id,
           p.org_id as property_org_id, c.org_id as contact_org_id
      into v_item
    from public.dialer_batch_items as i
    join public.dialer_batches as b on b.id = i.batch_id
    left join public.properties as p on p.id = i.property_id
    left join public.contacts as c on c.id = i.contact_id
    where i.id = v_activity.dialer_batch_item_id;

    if not found
       or v_item.batch_org_id is distinct from p_org_id
       or v_item.property_org_id is distinct from p_org_id
       or v_item.contact_org_id is distinct from p_org_id
       or v_item.item_property_id is distinct from v_activity.property_id
       or v_item.item_contact_id is distinct from v_activity.contact_id then
      raise exception 'jitter coherence check failed';
    end if;
  end if;

  select r.id into v_recording_id
  from public.call_recordings as r
  where r.call_activity_id = v_activity.id
  order by r.created_at desc
  limit 1
  for update;

  if v_recording_id is null then
    insert into public.call_recordings (
      call_activity_id, status, storage_path, duration_seconds,
      error_code, error_message
    ) values (
      v_activity.id, p_status, p_storage_path, p_duration_seconds,
      p_error_code, p_error_message
    ) returning * into v_recording;
  else
    update public.call_recordings
    set status = p_status,
        storage_path = p_storage_path,
        duration_seconds = p_duration_seconds,
        error_code = p_error_code,
        error_message = p_error_message
    where id = v_recording_id
      and call_activity_id = v_activity.id
    returning * into v_recording;
  end if;

  v_payload := jsonb_build_object(
    'recording', jsonb_build_object(
      'id', v_recording.id,
      'call_activity_id', v_recording.call_activity_id,
      'status', v_recording.status,
      'storage_path', v_recording.storage_path,
      'duration_seconds', v_recording.duration_seconds,
      'error_code', v_recording.error_code,
      'error_message', v_recording.error_message
    )
  );

  update public.webhook_events
  set payload = v_payload,
      processing_status = 'processed',
      processed_at = statement_timestamp()
  where org_id = p_org_id
    and provider = 'jitter'
    and event_type = 'call_recording_writeback'
    and external_id = p_external_id
    and processing_status = 'pending'
    and request_hash = p_request_hash;
  if not found then
    raise exception 'idempotency reservation missing or hash mismatch';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.jitter_upsert_call_recording(uuid, uuid, text, text, integer, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_upsert_call_recording(uuid, uuid, text, text, integer, text, text, text, text)
  to service_role;

create or replace function public.jitter_upsert_call_transcript(
  p_call_activity_id uuid,
  p_org_id uuid,
  p_status text,
  p_text text,
  p_language text,
  p_error_code text,
  p_error_message text,
  p_external_id text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.call_activities%rowtype;
  v_item record;
  v_transcript_id uuid;
  v_transcript public.call_transcripts%rowtype;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  select a.* into v_activity
  from public.call_activities as a
  where a.id = p_call_activity_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_activity.org_id is distinct from p_org_id
     or v_activity.provider is distinct from 'jitter' then
    raise exception 'jitter coherence check failed';
  end if;

  if v_activity.dialer_batch_item_id is not null then
    select i.id, i.batch_id, i.property_id as item_property_id,
           i.contact_id as item_contact_id, b.org_id as batch_org_id,
           p.org_id as property_org_id, c.org_id as contact_org_id
      into v_item
    from public.dialer_batch_items as i
    join public.dialer_batches as b on b.id = i.batch_id
    left join public.properties as p on p.id = i.property_id
    left join public.contacts as c on c.id = i.contact_id
    where i.id = v_activity.dialer_batch_item_id;

    if not found
       or v_item.batch_org_id is distinct from p_org_id
       or v_item.property_org_id is distinct from p_org_id
       or v_item.contact_org_id is distinct from p_org_id
       or v_item.item_property_id is distinct from v_activity.property_id
       or v_item.item_contact_id is distinct from v_activity.contact_id then
      raise exception 'jitter coherence check failed';
    end if;
  end if;

  select t.id into v_transcript_id
  from public.call_transcripts as t
  where t.call_activity_id = v_activity.id
  order by t.created_at desc
  limit 1
  for update;

  if v_transcript_id is null then
    insert into public.call_transcripts (
      call_activity_id, status, text, language, error_code, error_message
    ) values (
      v_activity.id, p_status, p_text, p_language, p_error_code, p_error_message
    ) returning * into v_transcript;
  else
    update public.call_transcripts
    set status = p_status,
        text = p_text,
        language = p_language,
        error_code = p_error_code,
        error_message = p_error_message
    where id = v_transcript_id
      and call_activity_id = v_activity.id
    returning * into v_transcript;
  end if;

  v_payload := jsonb_build_object(
    'transcript', jsonb_build_object(
      'id', v_transcript.id,
      'call_activity_id', v_transcript.call_activity_id,
      'status', v_transcript.status,
      'text', v_transcript.text,
      'language', v_transcript.language,
      'error_code', v_transcript.error_code,
      'error_message', v_transcript.error_message
    )
  );

  update public.webhook_events
  set payload = v_payload,
      processing_status = 'processed',
      processed_at = statement_timestamp()
  where org_id = p_org_id
    and provider = 'jitter'
    and event_type = 'call_transcript_writeback'
    and external_id = p_external_id
    and processing_status = 'pending'
    and request_hash = p_request_hash;
  if not found then
    raise exception 'idempotency reservation missing or hash mismatch';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.jitter_upsert_call_transcript(uuid, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_upsert_call_transcript(uuid, uuid, text, text, text, text, text, text, text)
  to service_role;

create or replace function public.jitter_writeback_call_activity(
  p_attempt_id text,
  p_body jsonb,
  p_callback_assignee_id uuid,
  p_external_id text,
  p_org_id uuid,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_property_id uuid := nullif(p_body ->> 'property_id', '')::uuid;
  v_contact_id uuid := nullif(p_body ->> 'contact_id', '')::uuid;
  v_item_id uuid := nullif(p_body ->> 'dialer_batch_item_id', '')::uuid;
  v_activity public.call_activities%rowtype;
  v_existing public.call_activities%rowtype;
  v_existing_id uuid;
  v_item record;
  v_contact_dnc boolean;
  v_callback_task_id uuid;
  v_callback_at timestamptz;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  -- Provider and body/org identity are part of the DB-side contract; the
  -- service-role route must not be able to turn this into another provider's
  -- writeback or cross-tenant mutation.
  if p_attempt_id is null or btrim(p_attempt_id) = ''
     or (p_body ->> 'provider') is distinct from 'jitter'
     or (p_body ->> 'org_id')::uuid is distinct from p_org_id then
    raise exception 'jitter coherence check failed';
  end if;

  if v_item_id is not null then
    select i.id, i.batch_id, i.property_id as item_property_id,
           i.contact_id as item_contact_id, b.org_id as batch_org_id,
           p.org_id as property_org_id, c.org_id as contact_org_id
      into v_item
    from public.dialer_batch_items as i
    join public.dialer_batches as b on b.id = i.batch_id
    left join public.properties as p on p.id = i.property_id
    left join public.contacts as c on c.id = i.contact_id
    where i.id = v_item_id;

    if not found
       or v_item.batch_org_id is distinct from p_org_id
       or v_item.property_org_id is distinct from p_org_id
       or v_item.contact_org_id is distinct from p_org_id
       or v_item.item_property_id is distinct from v_property_id
       or v_item.item_contact_id is distinct from v_contact_id then
      raise exception 'jitter coherence check failed';
    end if;
  else
    if v_property_id is null or v_contact_id is null then
      raise exception 'jitter coherence check failed';
    end if;

    if not exists (
      select 1 from public.properties as p
      where p.id = v_property_id and p.org_id = p_org_id
    ) or not exists (
      select 1 from public.contacts as c
      where c.id = v_contact_id and c.org_id = p_org_id
    ) then
      raise exception 'jitter coherence check failed';
    end if;
  end if;

  -- If a same-attempt row already exists, it must be the same org/provider
  -- and the same item/property/contact tuple before the upsert can proceed.
  select a.* into v_existing
  from public.call_activities as a
  where a.org_id = p_org_id
    and a.provider = 'jitter'
    and a.jitter_attempt_id = p_attempt_id
  for update;
  if found and (
    v_existing.property_id is distinct from v_property_id
    or v_existing.contact_id is distinct from v_contact_id
    or v_existing.dialer_batch_item_id is distinct from v_item_id
  ) then
    raise exception 'jitter coherence check failed';
  end if;

  -- The existing row above is only a coherence witness.  Normal retries
  -- still run the upsert so a newer writeback can update the activity.  A
  -- DNC replay is the one deliberate no-op path: once the contact is already
  -- opted out, avoid creating another activity update for the same attempt.
  v_existing := null;

  if p_body ->> 'disposition' = 'callback_requested' then
    v_callback_at := (p_body ->> 'callback_at')::timestamptz;

    update public.properties
    set outreach_dispo = 'callback_requested',
        follow_up_at = v_callback_at,
        updated_at = statement_timestamp()
    where id = v_property_id
      and org_id = p_org_id
      and deleted_at is null;

    select t.id into v_callback_task_id
    from public.tasks as t
    where t.related_property_id = v_property_id
      and t.org_id = p_org_id
      and t.type = 'callback'
      and t.status = 'open'
      and t.due_at = v_callback_at
    limit 1;

    if v_callback_task_id is null then
      insert into public.tasks (
        org_id, assignee_id, related_property_id, type, title,
        due_at, created_by
      ) values (
        p_org_id,
        p_callback_assignee_id,
        v_property_id,
        'callback',
        'Callback ' || coalesce((select address from public.properties where id = v_property_id), 'property'),
        v_callback_at,
        p_callback_assignee_id
      ) returning id into v_callback_task_id;
    end if;
  end if;

  select c.do_not_contact into v_contact_dnc
  from public.contacts as c
  where c.id = v_contact_id
    and c.org_id = p_org_id
  for update;
  if not found then
    raise exception 'jitter coherence check failed';
  end if;

  if coalesce((p_body ->> 'do_not_call_requested')::boolean, false)
     and v_contact_dnc then
    select a.id into v_existing_id
    from public.call_activities as a
    where a.org_id = p_org_id
      and a.provider = 'jitter'
      and a.jitter_attempt_id = p_attempt_id
    limit 1;
  end if;

  if v_existing_id is null then
    insert into public.call_activities (
      org_id, property_id, contact_id, dialer_batch_item_id,
      jitter_attempt_id, jitter_session_id, operator_user_id,
      started_at, ended_at, duration_seconds, outcome, disposition,
      do_not_call_requested, provider, provider_call_id, error_code,
      error_message, raw_event_count
    ) values (
      p_org_id,
      v_property_id,
      v_contact_id,
      v_item_id,
      p_attempt_id,
      nullif(p_body ->> 'jitter_session_id', ''),
      nullif(p_body ->> 'operator_user_id', '')::uuid,
      nullif(p_body ->> 'started_at', '')::timestamptz,
      nullif(p_body ->> 'ended_at', '')::timestamptz,
      nullif(p_body ->> 'duration_seconds', '')::integer,
      coalesce(nullif(p_body ->> 'outcome', ''), 'unknown'),
      nullif(p_body ->> 'disposition', ''),
      coalesce((p_body ->> 'do_not_call_requested')::boolean, false),
      'jitter',
      nullif(p_body ->> 'provider_call_id', ''),
      nullif(p_body ->> 'error_code', ''),
      nullif(p_body ->> 'error_message', ''),
      1
    )
    on conflict (org_id, provider, jitter_attempt_id) do update
    set property_id = excluded.property_id,
        contact_id = excluded.contact_id,
        dialer_batch_item_id = excluded.dialer_batch_item_id,
        jitter_session_id = excluded.jitter_session_id,
        operator_user_id = excluded.operator_user_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_seconds = excluded.duration_seconds,
        outcome = excluded.outcome,
        disposition = excluded.disposition,
        do_not_call_requested = excluded.do_not_call_requested,
        provider_call_id = excluded.provider_call_id,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        raw_event_count = call_activities.raw_event_count + 1
    returning * into v_activity;
  else
    select * into v_activity
    from public.call_activities
    where id = v_existing_id;
  end if;

  if v_item_id is not null and v_existing_id is null then
    update public.dialer_batch_items as i
    set last_call_activity_id = v_activity.id
    where i.id = v_item_id
      and i.batch_id = v_item.batch_id;
  end if;

  if coalesce((p_body ->> 'do_not_call_requested')::boolean, false) then
    insert into public.consent_events (
      org_id, contact_id, channel, event_type, source,
      source_detail, occurred_at
    ) values (
      p_org_id,
      v_contact_id,
      'voice',
      'opt_out',
      'jitter_writeback',
      jsonb_build_object(
        'disposition', p_body -> 'disposition',
        'jitter_session_id', p_body -> 'jitter_session_id',
        'externalId', p_attempt_id
      ),
      coalesce(nullif(p_body ->> 'ended_at', '')::timestamptz, statement_timestamp())
    )
    on conflict (contact_id, channel, event_type, source, source_external_id)
      where source_external_id is not null
        and event_type in ('opt_out', 'help_request')
    do nothing;

    update public.contacts
    set do_not_contact = true
    where id = v_contact_id
      and org_id = p_org_id
      and not do_not_contact;
  end if;

  v_payload := jsonb_build_object(
    'call_activity', jsonb_build_object(
      'id', v_activity.id,
      'org_id', v_activity.org_id,
      'property_id', v_activity.property_id,
      'contact_id', v_activity.contact_id,
      'dialer_batch_item_id', v_activity.dialer_batch_item_id,
      'jitter_attempt_id', v_activity.jitter_attempt_id,
      'provider', v_activity.provider,
      'outcome', v_activity.outcome
    )
  );
  if v_callback_task_id is not null then
    v_payload := v_payload || jsonb_build_object(
      'callback_task', jsonb_build_object('id', v_callback_task_id)
    );
  end if;

  update public.webhook_events
  set payload = v_payload,
      processing_status = 'processed',
      processed_at = statement_timestamp()
  where org_id = p_org_id
    and provider = 'jitter'
    and event_type = 'call_activity_writeback'
    and external_id = p_external_id
    and processing_status = 'pending'
    and request_hash = p_request_hash;
  if not found then
    raise exception 'idempotency reservation missing or hash mismatch';
  end if;

  return v_payload;
end;
$$;

revoke all on function public.jitter_writeback_call_activity(text, jsonb, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.jitter_writeback_call_activity(text, jsonb, uuid, text, uuid, text)
  to service_role;

commit;
