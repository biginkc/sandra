begin;

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

-- BEGIN call activity session identity correction.
-- This block is deliberately self-contained so a test database that applied
-- the branch-only earlier draft can rehearse the corrected schema and RPC with
-- psql --single-transaction. Do not add a second migration-ledger version.
-- Jitter attempt ids restart at attempt_0001 for every run. Preserve old
-- rows under a deterministic legacy session before making session identity a
-- required part of the durable writeback key.
update public.call_activities
set jitter_session_id = case
  when jitter_session_id is null or btrim(jitter_session_id) = ''
    then 'legacy:' || id::text
  else btrim(jitter_session_id)
end
where provider = 'jitter'
  and (
    jitter_session_id is null
    or btrim(jitter_session_id) = ''
    or jitter_session_id is distinct from btrim(jitter_session_id)
  );

alter table public.call_activities
  drop constraint if exists call_activities_jitter_session_id_trimmed_check;
alter table public.call_activities
  add constraint call_activities_jitter_session_id_trimmed_check
  check (
    provider <> 'jitter'
    or (
      jitter_session_id is not null
      and jitter_session_id <> ''
      and jitter_session_id = btrim(jitter_session_id)
    )
  );

-- Build the replacement before removing the old three-column index so there
-- is never a write window without a usable uniqueness fence.
create unique index idx_call_activities_org_provider_session_attempt
  on public.call_activities (
    org_id,
    provider,
    jitter_session_id,
    jitter_attempt_id
  );

drop index if exists public.idx_call_activities_org_provider_attempt;

-- BEGIN legacy Jitter consent identity correction.
-- Existing DNC evidence already carries the session in source_detail. Bring
-- its generated external id onto the same session-scoped key used by the new
-- RPC so the first post-deploy replay does not create duplicate evidence.
update public.consent_events
set source_detail = jsonb_set(
  source_detail,
  '{externalId}',
  to_jsonb(
    btrim(source_detail ->> 'jitter_session_id')
    || ':'
    || (source_detail ->> 'externalId')
  )
)
where source = 'jitter_writeback'
  and nullif(btrim(source_detail ->> 'jitter_session_id'), '') is not null
  and nullif(source_detail ->> 'externalId', '') is not null
  and left(
    source_detail ->> 'externalId',
    length(btrim(source_detail ->> 'jitter_session_id')) + 1
  ) is distinct from btrim(source_detail ->> 'jitter_session_id') || ':';
-- END legacy Jitter consent identity correction.

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

  if p_attempt_id is null or btrim(p_attempt_id) = ''
     or (p_body ->> 'provider') is distinct from 'jitter'
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

  select a.* into v_existing
  from public.call_activities as a
  where a.org_id = p_org_id
    and a.provider = 'jitter'
    and a.jitter_session_id = v_jitter_session_id
    and a.jitter_attempt_id = p_attempt_id
  for update;
  if found and (
    v_existing.property_id is distinct from v_property_id
    or v_existing.contact_id is distinct from v_contact_id
    or v_existing.dialer_batch_item_id is distinct from v_item_id
  ) then
    raise exception 'jitter coherence check failed';
  end if;

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
      and a.jitter_session_id = v_jitter_session_id
      and a.jitter_attempt_id = p_attempt_id
    limit 1;
  end if;

  if v_existing_id is null then
    insert into public.call_activities (
      org_id, property_id, contact_id, dialer_batch_item_id,
      jitter_attempt_id, jitter_session_id, operator_user_id,
      started_at, ended_at, duration_seconds, outcome, disposition,
      do_not_call_requested, provider, provider_call_id, error_code,
      error_message, notes, recording_path, raw_event_count
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
      'jitter',
      nullif(p_body ->> 'provider_call_id', ''),
      nullif(p_body ->> 'error_code', ''),
      nullif(p_body ->> 'error_message', ''),
      p_notes,
      p_recording_path,
      1
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
      raise exception 'jitter coherence check failed';
    end if;
  else
    select * into v_activity
    from public.call_activities
    where id = v_existing_id;
  end if;

  -- A prior-session DNC locks related lead sidecars. The new session still
  -- needs its own immutable activity/consent evidence, but must not repoint
  -- the locked batch item away from the activity that established the lock.
  if v_item_id is not null and v_existing_id is null and not v_contact_dnc then
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
-- END call activity session identity correction.

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

commit;
