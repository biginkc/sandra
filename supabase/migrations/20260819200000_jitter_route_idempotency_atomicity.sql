-- Forward migration for installations that already applied the initial
-- Jitter claim-fencing migrations. The historical 20260819151000 and
-- 20260819152000 files are corrected for fresh installs, but an applied
-- migration cannot be edited into an existing database.

-- Repair only malformed legacy hashes. Valid route/resource-bound SHA-256
-- hashes already carry trustworthy request identity and must be preserved;
-- the first retry adopts its app-computed hash only for malformed rows.
update public.webhook_events
set request_hash = null
where provider = 'jitter'
  and processing_status = 'pending'
  and request_hash is not null
  and request_hash !~ '^[0-9a-f]{64}$';

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
  v_result jsonb;
  v_payload jsonb;
begin
  v_result := public.jitter_claim_dialer_batch(p_batch_id, p_org_id, p_session_id);
  if v_result ->> 'outcome' <> 'claimed' then
    return v_result;
  end if;

  v_payload := jsonb_build_object('batch', v_result -> 'batch');
  update public.webhook_events
  set payload = v_payload,
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

  return v_result;
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
  v_result jsonb;
  v_payload jsonb;
begin
  v_result := public.jitter_patch_dialer_batch_item(
    p_item_id, p_org_id, p_session_id, p_claim_generation, p_status
  );
  if v_result ->> 'outcome' <> 'updated' then
    return v_result;
  end if;

  v_payload := jsonb_build_object('item', v_result -> 'item');
  update public.webhook_events
  set payload = v_payload,
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

  return v_result;
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
  v_activity_id uuid;
  v_recording_id uuid;
  v_recording public.call_recordings%rowtype;
  v_payload jsonb;
begin
  select a.id into v_activity_id
  from public.call_activities as a
  where a.id = p_call_activity_id
    and a.org_id = p_org_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select r.id into v_recording_id
  from public.call_recordings as r
  where r.call_activity_id = v_activity_id
  order by r.created_at desc
  limit 1;

  if v_recording_id is null then
    insert into public.call_recordings (
      call_activity_id, status, storage_path, duration_seconds,
      error_code, error_message
    ) values (
      v_activity_id, p_status, p_storage_path, p_duration_seconds,
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
      and call_activity_id = v_activity_id
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
  v_activity_id uuid;
  v_transcript_id uuid;
  v_transcript public.call_transcripts%rowtype;
  v_payload jsonb;
begin
  select a.id into v_activity_id
  from public.call_activities as a
  where a.id = p_call_activity_id
    and a.org_id = p_org_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select t.id into v_transcript_id
  from public.call_transcripts as t
  where t.call_activity_id = v_activity_id
  order by t.created_at desc
  limit 1;

  if v_transcript_id is null then
    insert into public.call_transcripts (
      call_activity_id, status, text, language, error_code, error_message
    ) values (
      v_activity_id, p_status, p_text, p_language, p_error_code, p_error_message
    ) returning * into v_transcript;
  else
    update public.call_transcripts
    set status = p_status,
        text = p_text,
        language = p_language,
        error_code = p_error_code,
        error_message = p_error_message
    where id = v_transcript_id
      and call_activity_id = v_activity_id
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

-- The writeback route has several related mutations. Keep them, including
-- callback-task and DNC side effects, in the same transaction as its response
-- record so a process crash cannot leave a committed call with a pending
-- reservation that is unsafe to replay.
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
  v_provider text := coalesce(nullif(p_body ->> 'provider', ''), 'jitter');
  v_property_id uuid := (p_body ->> 'property_id')::uuid;
  v_contact_id uuid := (p_body ->> 'contact_id')::uuid;
  v_item_id uuid := nullif(p_body ->> 'dialer_batch_item_id', '')::uuid;
  v_activity public.call_activities%rowtype;
  v_existing_activity_id uuid;
  v_contact_dnc boolean;
  v_callback_task_id uuid;
  v_callback_at timestamptz;
  v_payload jsonb;
begin
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
    raise exception 'DNC writeback contact not found';
  end if;

  if coalesce((p_body ->> 'do_not_call_requested')::boolean, false)
     and v_contact_dnc then
    select a.id into v_existing_activity_id
    from public.call_activities as a
    where a.org_id = p_org_id
      and a.provider = v_provider
      and a.jitter_attempt_id = p_attempt_id
    limit 1;
  end if;

  if v_existing_activity_id is null then
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
      v_provider,
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
    where id = v_existing_activity_id;
  end if;

  if v_item_id is not null and v_existing_activity_id is null then
    update public.dialer_batch_items as i
    set last_call_activity_id = v_activity.id
    from public.dialer_batches as b
    where i.id = v_item_id
      and b.id = i.batch_id
      and b.org_id = p_org_id;
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
