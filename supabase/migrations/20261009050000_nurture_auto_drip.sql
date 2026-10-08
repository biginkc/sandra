-- Messages v2: per-org switch that lets Jev's auto-applied `nurture` outcome
-- also enrol the lead in a drip (what a person did ~95% of the time by clicking
-- "start drip" after setting nurture). Default OFF: no behaviour change until
-- an org owner turns it on AND maps every route to a drip.
--
-- The human "start drip" button asks the person to pick a drip each time, so
-- there is no existing org default to reuse. The owner therefore maps each
-- nurture route (Book appointment for hot leads, Maybe later / Check in every 60 days / Listed, not selling)
-- to a drip here; the code never chooses a drip on its own.
begin;

alter table public.ai_responder_configs
  add column if not exists nurture_auto_drip boolean not null default false,
  add column if not exists nurture_drip_maybe_later_sequence_id uuid
    references public.sequences (id) on delete set null,
  add column if not exists nurture_drip_check_in_60_sequence_id uuid
    references public.sequences (id) on delete set null,
  add column if not exists nurture_drip_listed_not_selling_sequence_id uuid
    references public.sequences (id) on delete set null,
  add column if not exists nurture_drip_hot_book_appointment_sequence_id uuid
    references public.sequences (id) on delete set null;

-- Turning it on without all four drips would only ever produce holds.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_responder_configs_nurture_auto_drip_sequences_check'
  ) then
    alter table public.ai_responder_configs
      add constraint ai_responder_configs_nurture_auto_drip_sequences_check
      check (
        not nurture_auto_drip
        or (
          nurture_drip_maybe_later_sequence_id is not null
          and nurture_drip_check_in_60_sequence_id is not null
          and nurture_drip_listed_not_selling_sequence_id is not null
          and nurture_drip_hot_book_appointment_sequence_id is not null
        )
      );
  end if;
end $$;

-- Hard-deleting a drip the live switch points at would otherwise fail with a raw
-- constraint error (set null + the check above). Say what to do instead.
create or replace function public.fn_guard_nurture_mapped_sequence_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.ai_responder_configs c
    where c.nurture_auto_drip
      and old.id in (
        c.nurture_drip_maybe_later_sequence_id,
        c.nurture_drip_check_in_60_sequence_id,
        c.nurture_drip_listed_not_selling_sequence_id,
        c.nurture_drip_hot_book_appointment_sequence_id
      )
  ) then
    raise exception 'NURTURE_DRIP_IN_USE: this drip is used by nurture auto-drip. Turn the switch off or pick another drip first.'
      using errcode = '23503';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_guard_nurture_mapped_sequence_delete on public.sequences;
create trigger trg_guard_nurture_mapped_sequence_delete
  before delete on public.sequences
  for each row execute function public.fn_guard_nurture_mapped_sequence_delete();

-- Which auto-route created an enrolment. Immutable identity for takeover pauses:
-- remapping the owner's Book appointment drip later must not strip protection from
-- enrolments already running.
alter table public.sequence_enrollments
  add column if not exists auto_enrolled_route text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sequence_enrollments_auto_route_check') then
    alter table public.sequence_enrollments
      add constraint sequence_enrollments_auto_route_check
      check (auto_enrolled_route is null or auto_enrolled_route in
        ('maybe_later', 'check_in_60', 'listed_not_selling', 'hot_book_appointment'));
  end if;
end $$;

-- Durable "a person took over" marker. Takeover writes it BEFORE pausing; the hot-lead
-- enrolment checks it AFTER inserting. Whichever order a race lands in, the
-- enrolment ends up paused.
alter table public.properties
  add column if not exists last_person_takeover_at timestamptz;

-- Atomic fence for the hot-lead enrolment. The dispatch passes `hot_fence_at` (the
-- triggering inbound's arrival time). If, at insert time, a person has taken over at/after
-- it or the seller has sent a NEWER inbound, the row is born `paused` (never runnable),
-- so no scheduler tick can send in a gap. The `for share` lock on the property row also
-- orders this against the takeover marker write (which needs the row exclusively): a takeover
-- either lands before the check (row born paused) or waits for the enrolment to commit and
-- then pauses it.
alter table public.sequence_enrollments
  add column if not exists hot_fence_at timestamptz;

create or replace function public.fn_hot_enrollment_takeover_fence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_takeover timestamptz;
begin
  if new.auto_enrolled_route is distinct from 'hot_book_appointment' or new.hot_fence_at is null then
    return new;
  end if;
  select p.last_person_takeover_at into v_takeover
  from public.properties p
  where p.id = new.property_id
  for share;
  if v_takeover is not null and v_takeover >= new.hot_fence_at then
    new.status := 'paused';
    new.pause_reason := 'person_took_over';
  elsif exists (
    select 1 from public.messages m
    where m.property_id = new.property_id
      and m.direction = 'inbound'
      and m.created_at > new.hot_fence_at
  ) then
    new.status := 'paused';
    new.pause_reason := 'inbound_reply';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hot_enrollment_takeover_fence on public.sequence_enrollments;
create trigger trg_hot_enrollment_takeover_fence
  before insert on public.sequence_enrollments
  for each row execute function public.fn_hot_enrollment_takeover_fence();

-- A PERSON assigning a lead takes over: pause the auto-enrolled "Book appointment"
-- drip ("stops the moment a person takes over"). Only a signed-in person counts
-- (auth.uid() is null for the service role / system), and only enrolments created
-- by the hot Book appointment route are touched; every other drip keeps running.
create or replace function public.fn_pause_hot_drip_on_person_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
    or new.assigned_user_id is null
    or new.assigned_user_id is not distinct from old.assigned_user_id
  then
    return new;
  end if;
  update public.properties set last_person_takeover_at = now() where id = new.id;
  with paused as (
    update public.sequence_enrollments e
    set status = 'paused', pause_reason = 'person_took_over', updated_at = now()
    where e.property_id = new.id
      and e.status = 'active'
      and e.auto_enrolled_route = 'hot_book_appointment'
    returning e.sequence_id
  )
  -- Same lead event the app's pause path writes (pausePropertyEnrollments).
  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload)
  select new.org_id, new.id, 'user', auth.uid(), 'sequence_paused',
         jsonb_build_object(
           'count', count(*),
           'sequence_ids', jsonb_agg(distinct sequence_id),
           'reason', 'person_took_over',
           'permanent', false
         )
  from paused
  having count(*) > 0;
  return new;
end;
$$;

drop trigger if exists trg_pause_hot_drip_on_person_assignment on public.properties;
create trigger trg_pause_hot_drip_on_person_assignment
  after update of assigned_user_id on public.properties
  for each row execute function public.fn_pause_hot_drip_on_person_assignment();

-- Owner-only write path (same authorization as fn_update_jev_automatic_classification).
create or replace function public.fn_set_nurture_auto_drip(
  p_config_id uuid,
  p_enabled boolean,
  p_maybe_later_sequence_id uuid,
  p_check_in_60_sequence_id uuid,
  p_listed_not_selling_sequence_id uuid,
  p_hot_book_appointment_sequence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_row public.ai_responder_configs%rowtype;
  v_seq uuid;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_config_id is null or p_enabled is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select org_id into v_org_id from public.ai_responder_configs where id = p_config_id;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor
      and m.org_id = v_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_enabled and (
    p_maybe_later_sequence_id is null
    or p_check_in_60_sequence_id is null
    or p_listed_not_selling_sequence_id is null
    or p_hot_book_appointment_sequence_id is null
  ) then
    raise exception 'DRIP_REQUIRED' using errcode = '22023';
  end if;
  foreach v_seq in array array[
    p_maybe_later_sequence_id, p_check_in_60_sequence_id, p_listed_not_selling_sequence_id,
    p_hot_book_appointment_sequence_id
  ] loop
    if v_seq is not null and not exists (
      select 1 from public.sequences s
      where s.id = v_seq and s.org_id = v_org_id
        and s.active and s.archived_at is null
    ) then
      raise exception 'DRIP_UNAVAILABLE' using errcode = '22023';
    end if;
  end loop;

  update public.ai_responder_configs
  set nurture_auto_drip = p_enabled,
      nurture_drip_maybe_later_sequence_id = p_maybe_later_sequence_id,
      nurture_drip_check_in_60_sequence_id = p_check_in_60_sequence_id,
      nurture_drip_listed_not_selling_sequence_id = p_listed_not_selling_sequence_id,
      nurture_drip_hot_book_appointment_sequence_id = p_hot_book_appointment_sequence_id,
      updated_at = now()
  where id = p_config_id and org_id = v_org_id
  returning * into v_row;
  if not found then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'nurtureAutoDrip', v_row.nurture_auto_drip,
    'maybeLaterSequenceId', v_row.nurture_drip_maybe_later_sequence_id,
    'checkIn60SequenceId', v_row.nurture_drip_check_in_60_sequence_id,
    'listedNotSellingSequenceId', v_row.nurture_drip_listed_not_selling_sequence_id,
    'hotBookAppointmentSequenceId', v_row.nurture_drip_hot_book_appointment_sequence_id
  );
end;
$$;

revoke all on function public.fn_set_nurture_auto_drip(uuid, boolean, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_set_nurture_auto_drip(uuid, boolean, uuid, uuid, uuid, uuid) to authenticated;

commit;
