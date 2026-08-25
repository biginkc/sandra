begin;

-- Forward-only, idempotent correction for the Jitter call-activity writeback.
-- A Sandra softphone wrap-up owns its operator-entered disposition, outcome,
-- DNC decision, and notes. Jitter may enrich that row with call/artifact
-- metadata after the call, but must not create a second call_activities row
-- or replace the wrap-up fields.
create or replace function public.jitter_writeback_call_activity(
  p_attempt_id text,
  p_body jsonb,
  p_callback_assignee_id uuid,
  p_external_id text,
  p_notes text,
  p_org_id uuid,
  p_recording_path text,
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
  v_jitter_session_id text := nullif(btrim(p_body ->> 'jitter_session_id'), '');
  -- Jitter has the raw call UUID in p_attempt_id, not Sandra's browser
  -- wrap-up idempotency token. Leave wrap_token empty here; a later wrap-up
  -- matches by provider+attempt identity and supplies the real token.
  v_wrap_token uuid := null;
  v_activity public.call_activities%rowtype;
  v_existing public.call_activities%rowtype;
  v_item record;
  v_contact_dnc boolean;
  v_callback_task_id uuid;
  v_callback_at timestamptz;
  v_softphone_payload boolean := (p_body ->> 'provider') = 'sandra_softphone';
  v_softphone_match boolean := false;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  if p_attempt_id is null or btrim(p_attempt_id) = ''
     or coalesce(p_body ->> 'provider', '') not in ('jitter', 'sandra_softphone')
     or (p_body ->> 'org_id')::uuid is distinct from p_org_id
     or v_jitter_session_id is null
     or (p_body ->> 'jitter_session_id') is distinct from v_jitter_session_id then
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

  -- A softphone payload is an artifact enrichment for Sandra's row, so it
  -- must select that provider's row first. Preserve the existing Jitter-first
  -- lookup order for batch payloads byte-for-byte, including the softphone
  -- fallback used after a Jitter row is absent.
  if v_softphone_payload then
    select a.* into v_existing
    from public.call_activities as a
    where a.org_id = p_org_id
      and a.provider = 'sandra_softphone'
      and a.jitter_attempt_id = p_attempt_id
      and (
        a.jitter_session_id is null
        or a.jitter_session_id = v_jitter_session_id
      )
    for update;
    if found then
      v_softphone_match := true;
    end if;
  else
    select a.* into v_existing
    from public.call_activities as a
    where a.org_id = p_org_id
      and a.provider = 'jitter'
      and a.jitter_session_id = v_jitter_session_id
      and a.jitter_attempt_id = p_attempt_id
    for update;

    if not found then
      select a.* into v_existing
      from public.call_activities as a
      where a.org_id = p_org_id
        and a.provider = 'sandra_softphone'
        and a.jitter_attempt_id = p_attempt_id
        and (
          a.jitter_session_id is null
          or a.jitter_session_id = v_jitter_session_id
        )
      for update;
      if found then
        v_softphone_match := true;
      end if;
    end if;
  end if;

  if found and (
    v_existing.property_id is distinct from v_property_id
    or v_existing.contact_id is distinct from v_contact_id
    or v_existing.dialer_batch_item_id is distinct from v_item_id
  ) then
    v_payload := jsonb_build_object('outcome', 'identity_conflict');
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
  end if;

  if v_softphone_match then
    -- The softphone wrap-up is authoritative for operator-entered fields.
    -- Preserve those values and only merge Jitter-owned call/artifact data.
    update public.call_activities
    set jitter_session_id = v_jitter_session_id,
        started_at = coalesce(
          nullif(p_body ->> 'started_at', '')::timestamptz,
          started_at
        ),
        ended_at = coalesce(
          nullif(p_body ->> 'ended_at', '')::timestamptz,
          ended_at
        ),
        duration_seconds = coalesce(
          nullif(p_body ->> 'duration_seconds', '')::integer,
          duration_seconds
        ),
        provider_call_id = coalesce(
          nullif(p_body ->> 'provider_call_id', ''),
          provider_call_id
        ),
        error_code = coalesce(
          nullif(p_body ->> 'error_code', ''),
          error_code
        ),
        error_message = coalesce(
          nullif(p_body ->> 'error_message', ''),
          error_message
        ),
        wrap_token = coalesce(wrap_token, v_wrap_token),
        recording_path = coalesce(
          nullif(btrim(p_recording_path), ''),
          recording_path
        ),
        raw_event_count = raw_event_count + 1
    where id = v_existing.id
    returning * into v_activity;
  else
    select c.do_not_contact into v_contact_dnc
    from public.contacts as c
    where c.id = v_contact_id
      and c.org_id = p_org_id
    for update;
    if not found then
      raise exception 'jitter coherence check failed';
    end if;

    insert into public.call_activities (
        org_id, property_id, contact_id, dialer_batch_item_id,
        jitter_attempt_id, jitter_session_id, operator_user_id,
        started_at, ended_at, duration_seconds, outcome, disposition,
        do_not_call_requested, provider, provider_call_id, error_code,
        error_message, notes, recording_path, raw_event_count, wrap_token
      ) values (
        p_org_id,
        v_property_id,
        v_contact_id,
        v_item_id,
        p_attempt_id,
        v_jitter_session_id,
        nullif(p_body ->> 'operator_user_id', '')::uuid,
        nullif(p_body ->> 'started_at', '')::timestamptz,
        nullif(p_body ->> 'ended_at', '')::timestamptz,
        nullif(p_body ->> 'duration_seconds', '')::integer,
        coalesce(nullif(p_body ->> 'outcome', ''), 'unknown'),
        nullif(p_body ->> 'disposition', ''),
        coalesce((p_body ->> 'do_not_call_requested')::boolean, false),
        p_body ->> 'provider',
        nullif(p_body ->> 'provider_call_id', ''),
        nullif(p_body ->> 'error_code', ''),
        nullif(p_body ->> 'error_message', ''),
        p_notes,
        p_recording_path,
        1,
        v_wrap_token
      )
      on conflict (org_id, provider, jitter_session_id, jitter_attempt_id) do update
      set operator_user_id = excluded.operator_user_id,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          duration_seconds = excluded.duration_seconds,
          outcome = excluded.outcome,
          disposition = excluded.disposition,
          do_not_call_requested = excluded.do_not_call_requested,
          provider_call_id = excluded.provider_call_id,
          error_code = excluded.error_code,
          error_message = excluded.error_message,
          notes = excluded.notes,
          recording_path = excluded.recording_path,
          raw_event_count = call_activities.raw_event_count + 1
      where call_activities.property_id is not distinct from excluded.property_id
        and call_activities.contact_id is not distinct from excluded.contact_id
        and call_activities.dialer_batch_item_id is not distinct from excluded.dialer_batch_item_id
    returning * into v_activity;

    if not found then
      v_payload := jsonb_build_object('outcome', 'identity_conflict');
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
    end if;
  end if;

  -- Softphone rows already applied their operator-owned wrap-up side effects.
  -- Keep callback/DNC/batch-item side effects on the existing Jitter path only.
  if not v_softphone_payload and not v_softphone_match then
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

    -- A prior-session DNC locks related lead sidecars. The new session still
    -- needs its own immutable activity/consent evidence, but must not repoint
    -- the locked batch item away from the activity that established the lock.
    if v_item_id is not null and not v_contact_dnc then
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
          'jitter_session_id', to_jsonb(v_jitter_session_id),
          'externalId', v_jitter_session_id || ':' || p_attempt_id
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
  end if;

  v_payload := jsonb_build_object(
    'call_activity', jsonb_build_object(
      'id', v_activity.id,
      'org_id', v_activity.org_id,
      'property_id', v_activity.property_id,
      'contact_id', v_activity.contact_id,
      'dialer_batch_item_id', v_activity.dialer_batch_item_id,
      'jitter_attempt_id', v_activity.jitter_attempt_id,
      'jitter_session_id', v_activity.jitter_session_id,
      'provider', v_activity.provider,
      'outcome', v_activity.outcome,
      'notes', v_activity.notes,
      'recording_path', v_activity.recording_path
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

revoke all on function public.jitter_writeback_call_activity(text, jsonb, uuid, text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_writeback_call_activity(text, jsonb, uuid, text, text, uuid, text, text)
  to service_role;

-- Artifact routes can resolve the softphone parent after the handoff. Keep
-- the existing artifact state machine and idempotency behavior, but allow
-- that provider-specific parent through the same org/lead checks.
create or replace function public.jitter_upsert_call_recording(
  p_call_activity_id uuid, p_org_id uuid, p_status text,
  p_storage_path text, p_duration_seconds integer, p_error_code text,
  p_error_message text, p_external_id text, p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activity public.call_activities%rowtype;
  v_item record;
  v_recording public.call_recordings%rowtype;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;
  if p_status = 'available' and nullif(btrim(p_storage_path), '') is null then
    raise exception 'available recording requires storage path';
  end if;

  select a.* into v_activity from public.call_activities as a
  where a.id = p_call_activity_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_activity.org_id is distinct from p_org_id
     or v_activity.provider not in ('jitter', 'sandra_softphone') then
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
  if not exists (
    select 1 from public.properties as p
    where p.id = v_activity.property_id and p.org_id = p_org_id
  ) or not exists (
    select 1 from public.contacts as c
    where c.id = v_activity.contact_id and c.org_id = p_org_id
  ) then
    raise exception 'jitter coherence check failed';
  end if;

  insert into public.call_recordings (
    call_activity_id, status, storage_path, duration_seconds,
    error_code, error_message
  ) values (
    v_activity.id, p_status, p_storage_path, p_duration_seconds,
    p_error_code, p_error_message
  )
  on conflict (call_activity_id) do update
  set status = excluded.status,
      storage_path = excluded.storage_path,
      duration_seconds = excluded.duration_seconds,
      error_code = excluded.error_code,
      error_message = excluded.error_message
  where (
    call_recordings.status = 'pending'
    and excluded.status in ('failed', 'available')
  ) or (
    call_recordings.status = 'failed'
    and excluded.status = 'available'
  ) or (
    call_recordings.status = excluded.status
    and call_recordings.storage_path is not distinct from excluded.storage_path
    and call_recordings.duration_seconds is not distinct from excluded.duration_seconds
    and call_recordings.error_code is not distinct from excluded.error_code
    and call_recordings.error_message is not distinct from excluded.error_message
  )
  returning * into v_recording;

  if not found then
    v_payload := jsonb_build_object('outcome', 'artifact_conflict');
    update public.webhook_events
    set payload = v_payload, processing_status = 'processed',
        processed_at = statement_timestamp()
    where org_id = p_org_id and provider = 'jitter'
      and event_type = 'call_recording_writeback'
      and external_id = p_external_id and processing_status = 'pending'
      and request_hash = p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;
    return v_payload;
  end if;

  v_payload := jsonb_build_object('recording', jsonb_build_object(
    'id', v_recording.id,
    'call_activity_id', v_recording.call_activity_id,
    'status', v_recording.status,
    'storage_path', v_recording.storage_path,
    'duration_seconds', v_recording.duration_seconds,
    'error_code', v_recording.error_code,
    'error_message', v_recording.error_message
  ));

  update public.webhook_events
  set payload = v_payload, processing_status = 'processed',
      processed_at = statement_timestamp()
  where org_id = p_org_id and provider = 'jitter'
    and event_type = 'call_recording_writeback'
    and external_id = p_external_id and processing_status = 'pending'
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
  p_summary text,
  p_summary_status text,
  p_summary_error_code text,
  p_summary_error_message text,
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
  v_transcript public.call_transcripts%rowtype;
  v_payload jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;
  if p_status = 'available' and nullif(btrim(p_text), '') is null then
    raise exception 'available transcript requires text';
  end if;
  if p_summary_status <> 'none' and p_status <> 'available' then
    raise exception 'summary status requires available transcript';
  end if;
  if p_summary_status = 'available'
     and nullif(btrim(p_summary), '') is null then
    raise exception 'available summary requires summary';
  end if;

  select a.* into v_activity
  from public.call_activities as a
  where a.id = p_call_activity_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_activity.org_id is distinct from p_org_id
     or v_activity.provider not in ('jitter', 'sandra_softphone') then
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

  if not exists (
    select 1
    from public.properties as p
    where p.id = v_activity.property_id
      and p.org_id = p_org_id
  ) or not exists (
    select 1
    from public.contacts as c
    where c.id = v_activity.contact_id
      and c.org_id = p_org_id
  ) then
    raise exception 'jitter coherence check failed';
  end if;

  insert into public.call_transcripts (
      call_activity_id,
      status,
      text,
      language,
      error_code,
      error_message,
      summary,
      summary_status,
      summary_error_code,
      summary_error_message
    ) values (
      v_activity.id,
      p_status,
      p_text,
      p_language,
      p_error_code,
      p_error_message,
      p_summary,
      p_summary_status,
      p_summary_error_code,
      p_summary_error_message
  )
  on conflict (call_activity_id) do update
  set status = excluded.status,
      text = excluded.text,
      language = excluded.language,
      error_code = excluded.error_code,
      error_message = excluded.error_message,
      summary = excluded.summary,
      summary_status = excluded.summary_status,
      summary_error_code = excluded.summary_error_code,
      summary_error_message = excluded.summary_error_message
  where (
    call_transcripts.status = 'pending'
    and excluded.status in ('failed', 'available')
  ) or (
    call_transcripts.status = 'failed'
    and excluded.status = 'available'
  ) or (
    call_transcripts.status = excluded.status
    and call_transcripts.text is not distinct from excluded.text
    and call_transcripts.language is not distinct from excluded.language
    and call_transcripts.error_code is not distinct from excluded.error_code
    and call_transcripts.error_message is not distinct from excluded.error_message
    and (
      (
        call_transcripts.summary_status = excluded.summary_status
        and call_transcripts.summary is not distinct from excluded.summary
        and call_transcripts.summary_error_code is not distinct from excluded.summary_error_code
        and call_transcripts.summary_error_message is not distinct from excluded.summary_error_message
      ) or (
        call_transcripts.summary_status in ('none', 'pending')
        and excluded.summary_status in ('failed', 'available')
      ) or (
        call_transcripts.summary_status = 'failed'
        and excluded.summary_status = 'available'
      )
    )
  )
  returning * into v_transcript;

  if not found then
    v_payload := jsonb_build_object('outcome', 'artifact_conflict');
    update public.webhook_events
    set payload = v_payload, processing_status = 'processed',
        processed_at = statement_timestamp()
    where org_id = p_org_id and provider = 'jitter'
      and event_type = 'call_transcript_writeback'
      and external_id = p_external_id and processing_status = 'pending'
      and request_hash = p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;
    return v_payload;
  end if;

  v_payload := jsonb_build_object(
    'transcript', jsonb_build_object(
      'id', v_transcript.id,
      'call_activity_id', v_transcript.call_activity_id,
      'status', v_transcript.status,
      'text', v_transcript.text,
      'language', v_transcript.language,
      'error_code', v_transcript.error_code,
      'error_message', v_transcript.error_message,
      'summary', v_transcript.summary,
      'summary_status', v_transcript.summary_status,
      'summary_error_code', v_transcript.summary_error_code,
      'summary_error_message', v_transcript.summary_error_message
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

revoke all on function public.jitter_upsert_call_transcript(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.jitter_upsert_call_transcript(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

commit;
