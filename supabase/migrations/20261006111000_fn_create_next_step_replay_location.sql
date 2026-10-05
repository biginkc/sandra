-- My Leads one-call close, P1a replay fix: restores the location (and mode) comparison in the
-- idempotent replay of fn_create_next_step (tracked follow-up of #797). Redefines the function
-- in full; signature, grants and every other branch are unchanged from 20261005120500.
-- Original header: fn_create_next_step, the one SQL write path for a
-- next step (an appointment or a task). Definition only; no data is written when it applies.
--
-- Every later writer (TypeScript wrapper, Jitter, Norma, offer follow-up) calls this function
-- instead of inserting into public.tasks, so the guards, the attribution capture, the
-- calendar ledger rule and the lead event are enforced in one place.
--   * phone appointment  : end_at is always due_at + 15 minutes, no Google event, no ledger row.
--   * in-person          : end_at supplied (15 minutes to 24 hours), a 'create' ledger row is born
--                          in the same transaction exactly as fn_book_appointment does.
--   * task               : type 'custom', must be linked to a property.
-- Error messages start with a stable code (FORBIDDEN, INVALID_INPUT); the TypeScript wrapper
-- maps them. Booking side effects (prospect -> new_lead, booked_appointment dispo) are opt-in
-- for the dialer wrap-up only.
begin;

create or replace function public.fn_create_next_step(
  p_org uuid,
  p_actor uuid,
  p_assignee uuid,
  p_kind text,
  p_title text,
  p_due_at timestamptz,
  p_property uuid default null,
  p_contact uuid default null,
  p_mode text default 'phone',
  p_end_at timestamptz default null,
  p_location text default null,
  p_description text default null,
  p_source_key text default null,
  p_idempotency_key uuid default null,
  p_lead_next_action_key uuid default null,
  p_origin text default 'app',
  p_enforce_window boolean default false,
  p_apply_booking_effects boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_mode text;
  v_end timestamptz;
  v_title text := btrim(coalesce(p_title, ''));
  v_chain uuid := gen_random_uuid();
  v_task_id uuid;
  v_ledger_id uuid;
  v_old public.tasks%rowtype;
  v_existing public.tasks%rowtype;
  v_has_existing boolean := false;
  v_converted boolean := false;
  v_duplicate boolean := false;
  v_already_qualified boolean := false;
  v_promoted integer;
  v_conflict text;
  v_prev_flag text;
  v_event_type text;
  v_event_source text;
  v_actor_type text;
begin
  -- 1. Caller. Browser callers act as themselves; the service role names the actor.
  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_actor then
    raise exception 'FORBIDDEN: caller is not the actor' using errcode = '42501';
  end if;
  -- System-only knobs: a browser caller may not use source keys, system origins, or skip the
  -- booking window (those are for Jitter, Norma and the backfill running as the service role).
  if coalesce(auth.role(), '') <> 'service_role' then
    if p_source_key is not null then
      raise exception 'FORBIDDEN: source keys are service-only' using errcode = '42501';
    end if;
    if p_origin is distinct from 'app' and p_origin is distinct from 'board' and p_origin is distinct from 'offer' then
      raise exception 'FORBIDDEN: origin is service-only' using errcode = '42501';
    end if;
    if not coalesce(p_enforce_window, false) then
      raise exception 'FORBIDDEN: the booking window is mandatory for browser callers' using errcode = '42501';
    end if;
  end if;
  if p_org is null or p_actor is null or p_assignee is null then
    raise exception 'INVALID_INPUT: org, actor and assignee are required' using errcode = '22023';
  end if;
  perform 1
  from public.memberships m
  where m.user_id = p_actor and m.org_id = p_org and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
  for share of m;
  if not found then
    raise exception 'FORBIDDEN: actor has no active membership in org' using errcode = '42501';
  end if;

  -- 2. Shape (everything that does not depend on the clock).
  if p_kind is null or p_kind not in ('appointment', 'task') then
    raise exception 'INVALID_INPUT: kind must be appointment or task' using errcode = '22023';
  end if;
  if p_origin is null or p_origin not in ('app', 'jitter', 'norma', 'offer', 'board', 'offer_backfill') then
    raise exception 'INVALID_INPUT: unknown origin' using errcode = '22023';
  end if;
  if v_title = '' then
    raise exception 'INVALID_INPUT: title is required' using errcode = '22023';
  end if;
  if p_due_at is null or not isfinite(p_due_at) then
    raise exception 'INVALID_INPUT: due time must be a finite timestamp' using errcode = '22023';
  end if;
  if p_end_at is not null and not isfinite(p_end_at) then
    raise exception 'INVALID_INPUT: end time must be a finite timestamp' using errcode = '22023';
  end if;
  v_type := case p_kind when 'appointment' then 'appointment' else 'custom' end;

  if p_kind = 'task' then
    if p_property is null then
      raise exception 'INVALID_INPUT: a task needs a property' using errcode = '22023';
    end if;
    if p_mode is not null and p_mode <> 'phone' then
      raise exception 'INVALID_INPUT: a task has no mode' using errcode = '22023';
    end if;
    if p_lead_next_action_key is not null or p_idempotency_key is not null
       or p_location is not null or p_end_at is not null then
      raise exception 'INVALID_INPUT: a task cannot carry an end time, location or idempotency key'
        using errcode = '22023';
    end if;
    v_mode := 'phone';
    v_end := null;
  else
    v_mode := coalesce(p_mode, 'phone');
    if v_mode not in ('phone', 'in_person') then
      raise exception 'INVALID_INPUT: mode must be phone or in_person' using errcode = '22023';
    end if;
    if v_mode = 'phone' then
      v_end := p_due_at + interval '15 minutes';
      if p_end_at is not null and p_end_at is distinct from v_end then
        raise exception 'INVALID_INPUT: a phone appointment is always 15 minutes' using errcode = '22023';
      end if;
      if p_location is not null then
        raise exception 'INVALID_INPUT: a phone appointment has no location' using errcode = '22023';
      end if;
    else
      if p_end_at is null then
        raise exception 'INVALID_INPUT: an in-person appointment needs an end time' using errcode = '22023';
      end if;
      v_end := p_end_at;
      if v_end - p_due_at < interval '15 minutes' or v_end - p_due_at > interval '24 hours' then
        raise exception 'INVALID_INPUT: appointment duration must be between 15 minutes and 24 hours'
          using errcode = '22023';
      end if;
      if p_location is not null and length(p_location) > 500 then
        raise exception 'INVALID_INPUT: location is too long' using errcode = '22023';
      end if;
      if p_source_key is not null then
        raise exception 'INVALID_INPUT: an in-person appointment cannot use a source key' using errcode = '22023';
      end if;
    end if;
  end if;

  -- 3. Replay by idempotency key. Runs before the clock check so a harmless retry of a
  -- committed booking returns the original even when the start has since slipped out of the
  -- window. A key reused with a different request is refused, never acknowledged.
  if p_idempotency_key is not null then
    select * into v_existing from public.tasks t
    where t.org_id = p_org and t.booking_idempotency_key = p_idempotency_key;
    v_has_existing := found;
  end if;
  if not v_has_existing and p_lead_next_action_key is not null then
    select * into v_existing from public.tasks t
    where t.org_id = p_org and t.lead_next_action_idempotency_key = p_lead_next_action_key;
    v_has_existing := found;
  end if;
  if v_has_existing then
    select m.id into v_ledger_id from public.task_calendar_mutations m
    where m.org_id = p_org and m.operation = 'create' and m.source_task_id = v_existing.id;
    -- Location is compared exactly. Mode is compared too, except for the one legacy shape:
    -- fn_book_appointment stored every booking with the phone default and opened a create
    -- ledger row, so a phone row that owns a create ledger row is that legacy booking and its
    -- retry may arrive as in_person.
    if v_existing.related_property_id is distinct from p_property
       or v_existing.contact_id is distinct from p_contact
       or v_existing.assignee_id is distinct from p_assignee
       or v_existing.due_at is distinct from p_due_at
       or v_existing.end_at is distinct from v_end
       or v_existing.title is distinct from v_title
       or v_existing.description is distinct from p_description
       or v_existing.location is distinct from p_location
       or (v_existing.mode is distinct from v_mode
           and not (v_existing.mode = 'phone' and v_ledger_id is not null)) then
      raise exception 'fn_create_next_step: idempotency key reuse with different request'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'task_id', v_existing.id, 'calendar_chain_id', v_existing.calendar_chain_id,
      'ledger_id', v_ledger_id, 'duplicate', true, 'converted', false,
      'kind', p_kind, 'mode', v_existing.mode,
      'related_property_id', v_existing.related_property_id, 'contact_id', v_existing.contact_id,
      'already_qualified', false);
  end if;

  if p_enforce_window and (p_due_at < now() - interval '1 hour' or p_due_at > now() + interval '2 years') then
    raise exception 'INVALID_INPUT: start must be within 1 hour in the past and 2 years in the future'
      using errcode = '22023';
  end if;

  begin
    if p_source_key is not null then
      -- 4. Source-key upsert (Norma contract): one row per key, updated in place.
      select * into v_old from public.tasks t
      where t.org_id = p_org and t.source_key = p_source_key for update;
      if found then
        if v_old.related_property_id is distinct from p_property then
          raise exception 'fn_create_next_step: source key reuse with a different property' using errcode = 'P0001';
        end if;
        if v_old.type = 'appointment'
           and (v_old.status <> 'open'
                or exists (select 1 from public.tasks c
                           where c.org_id = p_org and c.calendar_chain_id = v_old.calendar_chain_id
                             and c.id <> v_old.id)) then
          raise exception 'fn_create_next_step: this appointment was closed, rescheduled or superseded'
            using errcode = 'P0001';
        end if;
        if v_old.type = 'appointment' and p_kind = 'task' then
          raise exception 'fn_create_next_step: an appointment cannot be downgraded to a task' using errcode = 'P0001';
        end if;
        if v_old.google_calendar_event_id is not null and v_old.due_at is distinct from p_due_at then
          raise exception 'fn_create_next_step: a row with a calendar event cannot change its time here'
            using errcode = 'P0001';
        end if;
        v_prev_flag := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
        perform set_config('sandra.allow_appointment_time_move', 'on', true);
        update public.tasks
        set type = v_type, mode = v_mode, title = v_title, due_at = p_due_at, end_at = v_end,
            location = p_location, description = p_description,
            calendar_chain_id = case when v_type = 'appointment' then coalesce(v_old.calendar_chain_id, v_chain) end,
            status = 'open', snoozed_until = null, completed_at = null, completed_by = null,
            outcome = null, reminder_claimed_at = null,
            calendar_generation = v_old.calendar_generation + 1, updated_at = now()
        where id = v_old.id and org_id = p_org;
        perform set_config('sandra.allow_appointment_time_move', v_prev_flag, true);
        v_task_id := v_old.id;
        v_chain := case when v_type = 'appointment' then coalesce(v_old.calendar_chain_id, v_chain) end;
        v_converted := v_old.type is distinct from v_type;
        if v_converted and v_type = 'appointment' and p_property is not null
           and exists (select 1 from public.acquisition_org_settings s where s.org_id = p_org) then
          -- The AFTER INSERT attribution trigger does not fire for an update.
          insert into public.acquisition_appointment_attribution (task_id, org_id, accountable_user_id, source)
          values (v_old.id, p_org, v_old.assignee_id, 'next_step_conversion')
          on conflict (task_id) do nothing;
        end if;
      end if;
    end if;

    if v_task_id is null then
      -- 5. Insert.
      if v_type <> 'appointment' then
        v_chain := null;
      end if;
      insert into public.tasks (
        org_id, assignee_id, related_property_id, contact_id, type, mode, status, title, description,
        location, due_at, end_at, calendar_chain_id, created_by, booking_idempotency_key,
        lead_next_action_idempotency_key, source_key
      ) values (
        p_org, p_assignee, p_property, p_contact, v_type, v_mode, 'open', v_title, p_description,
        p_location, p_due_at, v_end, v_chain, p_actor, p_idempotency_key,
        p_lead_next_action_key, p_source_key
      ) returning id into v_task_id;

      if p_origin = 'offer_backfill' and v_type = 'appointment' then
        update public.acquisition_appointment_attribution
        set source = 'offer_backfill'
        where task_id = v_task_id and org_id = p_org;
      end if;

      -- 6. Calendar ledger, in-person only. Phone appointments never reach Google.
      if v_type = 'appointment' and v_mode = 'in_person' then
        insert into public.task_calendar_mutations (
          org_id, calendar_chain_id, operation, phase, source_task_id, old_assignee_id, expected_generation
        ) values (p_org, v_chain, 'create', 'pending', v_task_id, p_assignee, 0)
        returning id into v_ledger_id;
        update public.task_calendar_mutations
        set client_event_id = public.fn_uuid_to_base32hex(id), updated_at = now()
        where id = v_ledger_id;
      end if;
    end if;
  exception
    when unique_violation then
      get stacked diagnostics v_conflict = constraint_name;
      v_has_existing := false;
      if v_conflict = 'idx_tasks_org_booking_idempotency_key' and p_idempotency_key is not null then
        select * into v_existing from public.tasks t
        where t.org_id = p_org and t.booking_idempotency_key = p_idempotency_key;
        v_has_existing := found;
      elsif v_conflict = 'idx_tasks_org_lead_next_action_idempotency' and p_lead_next_action_key is not null then
        select * into v_existing from public.tasks t
        where t.org_id = p_org and t.lead_next_action_idempotency_key = p_lead_next_action_key;
        v_has_existing := found;
      elsif v_conflict = 'idx_tasks_org_source_key' and p_source_key is not null then
        select * into v_existing from public.tasks t
        where t.org_id = p_org and t.source_key = p_source_key;
        v_has_existing := found;
      end if;
      if not v_has_existing then
        raise;
      end if;
      if v_existing.related_property_id is distinct from p_property
         or v_existing.contact_id is distinct from p_contact
         or v_existing.assignee_id is distinct from p_assignee
         or v_existing.due_at is distinct from p_due_at
         or v_existing.end_at is distinct from v_end
         or v_existing.title is distinct from v_title
         or v_existing.description is distinct from p_description then
        raise exception 'fn_create_next_step: idempotency key reuse with different request'
          using errcode = 'P0001';
      end if;
      select m.id into v_ledger_id from public.task_calendar_mutations m
      where m.org_id = p_org and m.operation = 'create' and m.source_task_id = v_existing.id;
      return jsonb_build_object(
        'task_id', v_existing.id, 'calendar_chain_id', v_existing.calendar_chain_id,
        'ledger_id', v_ledger_id, 'duplicate', true, 'converted', false,
        'kind', p_kind, 'mode', v_existing.mode,
        'related_property_id', v_existing.related_property_id, 'contact_id', v_existing.contact_id,
        'already_qualified', false);
  end;

  -- 7. Lead event (property-linked only), idempotent on its source identity.
  if p_property is not null then
    if p_kind = 'appointment' and p_origin in ('app', 'board', 'offer') then
      v_event_type := 'appointment_booked';
      v_event_source := 'appointments.booked';
    else
      v_event_type := 'task_created';
      v_event_source := 'tasks.created';
    end if;
    v_actor_type := case when p_origin in ('app', 'board', 'offer') then 'user' else 'system' end;
    insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
    values (
      p_org, p_property, v_actor_type, case when v_actor_type = 'user' then p_actor end, v_event_type,
      jsonb_build_object('task_id', v_task_id, 'task_type', v_type, 'due_at', p_due_at,
                         'assignee_id', p_assignee, 'mode', v_mode, 'origin', p_origin),
      v_event_source, v_task_id)
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;

  -- 8. Booking effects (dialer wrap-up only): same two updates fn_book_appointment makes.
  if p_apply_booking_effects and p_property is not null then
    update public.properties
    set status = 'new_lead', qualified_at = now(), qualified_by = p_actor::text, updated_at = now()
    where id = p_property and org_id = p_org and status = 'prospect';
    get diagnostics v_promoted = row_count;
    v_already_qualified := (v_promoted = 0);
    update public.properties
    set outreach_dispo = 'booked_appointment', follow_up_at = null, updated_at = now()
    where id = p_property and org_id = p_org;
  end if;

  return jsonb_build_object(
    'task_id', v_task_id, 'calendar_chain_id', v_chain, 'ledger_id', v_ledger_id,
    'duplicate', v_duplicate, 'converted', v_converted, 'kind', p_kind, 'mode', v_mode,
    'related_property_id', p_property, 'contact_id', p_contact,
    'already_qualified', v_already_qualified);
end $$;

revoke all on function public.fn_create_next_step(
  uuid, uuid, uuid, text, text, timestamptz, uuid, uuid, text, timestamptz, text, text, text,
  uuid, uuid, text, boolean, boolean) from public, anon;
grant execute on function public.fn_create_next_step(
  uuid, uuid, uuid, text, text, timestamptz, uuid, uuid, text, timestamptz, text, text, text,
  uuid, uuid, text, boolean, boolean) to authenticated, service_role;

comment on function public.fn_create_next_step(
  uuid, uuid, uuid, text, text, timestamptz, uuid, uuid, text, timestamptz, text, text, text,
  uuid, uuid, text, boolean, boolean) is
  'The one write path for a My Leads next step (appointment or task). Phone appointments are 15 minutes and never reach Google; in-person appointments open a create ledger row in the same transaction. Replays by idempotency key return the original with duplicate:true.';

commit;
