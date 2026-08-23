alter table public.call_transcripts
  add column summary text,
  add column summary_status text not null default 'none'
    constraint call_transcripts_summary_status_check
    check (summary_status in ('none', 'pending', 'available', 'failed')),
  add column summary_error_code text,
  add column summary_error_message text;

alter table public.call_activities
  add column summary_status text not null default 'none'
    constraint call_activities_summary_status_check
    check (summary_status in ('none', 'pending', 'available', 'failed'));

create or replace function public.bump_call_activities_on_child_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if (tg_table_name = 'call_recordings') then
    update public.call_activities
       set recording_status = new.status,
           updated_at = now()
     where id = new.call_activity_id;
  elsif (tg_table_name = 'call_transcripts') then
    update public.call_activities
       set transcript_status = new.status,
           summary_status = new.summary_status,
           updated_at = now()
     where id = new.call_activity_id;
  end if;

  return new;
end;
$fn$;

drop function if exists public.jitter_upsert_call_transcript(
  uuid, uuid, text, text, text, text, text, text, text
);

create function public.jitter_upsert_call_transcript(
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

  select t.id into v_transcript_id
  from public.call_transcripts as t
  where t.call_activity_id = v_activity.id
  order by t.created_at desc
  limit 1
  for update;

  if v_transcript_id is null then
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
    ) returning * into v_transcript;
  else
    update public.call_transcripts
    set status = p_status,
        text = p_text,
        language = p_language,
        error_code = p_error_code,
        error_message = p_error_message,
        summary = p_summary,
        summary_status = p_summary_status,
        summary_error_code = p_summary_error_code,
        summary_error_message = p_summary_error_message
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
