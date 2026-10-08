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
