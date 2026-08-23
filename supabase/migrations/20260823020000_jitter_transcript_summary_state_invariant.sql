begin;

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
