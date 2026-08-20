-- Backfill safety metadata for installations that already applied the claim
-- fencing functions before the legacy-row hardening was added.

update public.dialer_batches
set claim_generation = 1
where status = 'claimed'
  and claim_generation = 0;

-- Repair only malformed legacy hashes. Valid route/resource-bound SHA-256
-- hashes already carry trustworthy request identity and must be preserved;
-- the first retry adopts its app-computed hash only for malformed rows.
update public.webhook_events
set request_hash = null
where provider = 'jitter'
  and processing_status = 'pending'
  and request_hash is not null
  and request_hash !~ '^[0-9a-f]{64}$';

-- The route-level idempotency response is written in the same transaction as
-- the mutation. The original three-argument claim function remains the CAS
-- implementation; this overload wraps it and records the committed response
-- before the transaction can return.
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
    p_item_id,
    p_org_id,
    p_session_id,
    p_claim_generation,
    p_status
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
