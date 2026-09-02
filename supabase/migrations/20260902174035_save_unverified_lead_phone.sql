-- Keep the default rule from migration 080: a normal contacts write may not
-- save a new phone whose line type is unknown. Lead intake gets one narrow
-- exception so a temporary line-type lookup outage does not delete a valid
-- phone number.

begin;

create or replace function public.enforce_phone_type_on_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  allow_unverified_lead_phone boolean :=
    coalesce(current_setting('sandra.allow_unverified_lead_phone', true), '') = 'on';
begin
  if new.phone_1 is not null
     and (tg_op = 'INSERT' or new.phone_1 is distinct from old.phone_1)
     and new.phone_1_type = 'unknown'
     and not allow_unverified_lead_phone then
    raise exception 'phone_1 requires a line type (mobile or landline) — unlabeled phone numbers are not saved';
  end if;

  if new.phone_2 is not null
     and (tg_op = 'INSERT' or new.phone_2 is distinct from old.phone_2)
     and new.phone_2_type = 'unknown'
     and not allow_unverified_lead_phone then
    raise exception 'phone_2 requires a line type (mobile or landline) — unlabeled phone numbers are not saved';
  end if;

  if new.phone_3 is not null
     and (tg_op = 'INSERT' or new.phone_3 is distinct from old.phone_3)
     and new.phone_3_type = 'unknown'
     and not allow_unverified_lead_phone then
    raise exception 'phone_3 requires a line type (mobile or landline) — unlabeled phone numbers are not saved';
  end if;

  return new;
end;
$$;

drop trigger if exists contacts_phone_type_required on public.contacts;
create trigger contacts_phone_type_required
  before insert or update on public.contacts
  for each row
  execute function public.enforce_phone_type_on_write();

create or replace function public.save_unverified_lead_phone(
  p_org_id uuid,
  p_phone text,
  p_contact_id uuid default null,
  p_first_name text default null,
  p_last_name text default null,
  p_email text default null
)
returns table (
  contact_id uuid,
  outcome text,
  phone_slot smallint
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_contact public.contacts%rowtype;
  v_contact_id uuid;
  v_phone text := btrim(coalesce(p_phone, ''));
  v_slot smallint;
begin
  if v_phone !~ '^\+1[2-9][0-9]{9}$' then
    raise exception using
      errcode = '22023',
      message = 'INVALID_PHONE: expected a normalized US phone number';
  end if;

  if p_contact_id is null then
    perform set_config('sandra.allow_unverified_lead_phone', 'on', true);

    insert into public.contacts (
      org_id,
      contact_type,
      first_name,
      last_name,
      email,
      phone_1,
      phone_1_type
    ) values (
      p_org_id,
      'person',
      nullif(btrim(p_first_name), ''),
      nullif(btrim(p_last_name), ''),
      nullif(btrim(p_email), ''),
      v_phone,
      'unknown'
    )
    returning id into v_contact_id;

    return query select v_contact_id, 'inserted'::text, 1::smallint;
    return;
  end if;

  select contact.*
    into v_contact
  from public.contacts contact
  where contact.id = p_contact_id
    and contact.org_id = p_org_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'CONTACT_NOT_FOUND';
  end if;

  if v_phone = v_contact.phone_1 then
    return query select v_contact.id, 'already_present'::text, 1::smallint;
    return;
  elsif v_phone = v_contact.phone_2 then
    return query select v_contact.id, 'already_present'::text, 2::smallint;
    return;
  elsif v_phone = v_contact.phone_3 then
    return query select v_contact.id, 'already_present'::text, 3::smallint;
    return;
  end if;

  if v_contact.do_not_contact or exists (
    select 1
    from public.properties property
    where property.homeowner_contact_id = v_contact.id
      and property.org_id = v_contact.org_id
      and property.is_dnc_locked
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'DNC_LOCKED: unverified phone was not added';
  end if;

  v_slot := case
    when v_contact.phone_1 is null then 1
    when v_contact.phone_2 is null then 2
    when v_contact.phone_3 is null then 3
    else null
  end;

  if v_slot is null then
    return query select v_contact.id, 'no_open_phone_slot'::text, null::smallint;
    return;
  end if;

  perform set_config('sandra.allow_unverified_lead_phone', 'on', true);

  if v_slot = 1 then
    update public.contacts
    set phone_1 = v_phone, phone_1_type = 'unknown'
    where id = v_contact.id and org_id = p_org_id and phone_1 is null;
  elsif v_slot = 2 then
    update public.contacts
    set phone_2 = v_phone, phone_2_type = 'unknown'
    where id = v_contact.id and org_id = p_org_id and phone_2 is null;
  else
    update public.contacts
    set phone_3 = v_phone, phone_3_type = 'unknown'
    where id = v_contact.id and org_id = p_org_id and phone_3 is null;
  end if;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'PHONE_SLOT_CHANGED: retry lead intake';
  end if;

  return query select v_contact.id, 'appended'::text, v_slot;
end;
$$;

revoke all on function public.save_unverified_lead_phone(
  uuid, text, uuid, text, text, text
) from public, anon;
grant execute on function public.save_unverified_lead_phone(
  uuid, text, uuid, text, text, text
) to authenticated, service_role;

comment on function public.save_unverified_lead_phone(
  uuid, text, uuid, text, text, text
) is
  'Lead-intake-only path that preserves a normalized phone when line-type lookup is unavailable. Normal contacts writes still reject unknown phone types.';

commit;
