begin;

-- Brief 7 (Sandra/Jitter contract item 8): accept and persist `notes` and
-- `recording_path` on the Jitter call-activities writeback. Recording
-- storage itself stays v1.1-deferred — this only persists the provenance
-- fields Jitter already sends.
alter table public.call_activities
  add column if not exists notes text,
  add column if not exists recording_path text;

drop function if exists public.jitter_writeback_call_activity(text, jsonb, uuid, text, uuid, text);

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
      error_message, notes, recording_path, raw_event_count
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
      p_notes,
      p_recording_path,
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
        notes = excluded.notes,
        recording_path = excluded.recording_path,
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

commit;
