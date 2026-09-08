begin;
alter table public.properties add column is_training boolean not null default false;
create index properties_training_contact_idx on public.properties (homeowner_contact_id) where is_training;

-- Trigger-only lookup sees protected rows even when an ordinary caller cannot.
create function public.is_training_target(p_property uuid, p_contact uuid, p_phone text default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.properties p left join public.contacts c on c.id=p.homeowner_contact_id
    where p.is_training and (p.id=p_property or p.homeowner_contact_id=p_contact or
      (p_phone is not null and p_phone in (c.phone_1,c.phone_2,c.phone_3)))
  );
$$;
revoke all on function public.is_training_target(uuid,uuid,text) from public, anon, authenticated;

create function public.guard_training_property() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP='INSERT' then
    if new.is_training then
      if coalesce(auth.role(),'') <> 'service_role' then
        raise exception 'TRAINING_PROTECTED: server-only training creation' using errcode='42501';
      end if;
      if exists(select 1 from public.properties where homeowner_contact_id=new.homeowner_contact_id) then
        raise exception 'TRAINING_PROTECTED: seed requires a dedicated contact' using errcode='23514';
      end if;
      if new.homeowner_contact_id is null or new.is_dnc_locked or new.outreach_dispo is not null
        or new.status <> 'new_lead' then
        raise exception 'TRAINING_PROTECTED: invalid training seed' using errcode='23514';
      end if;
    end if;
    if not new.is_training and public.is_training_target(null,new.homeowner_contact_id) then
      raise exception 'TRAINING_PROTECTED: training contact cannot become a customer' using errcode='23514';
    end if;
    return new;
  end if;
  if TG_OP='DELETE' then
    if old.is_training then raise exception 'TRAINING_PROTECTED: training identity is permanent' using errcode='23514'; end if;
    return old;
  end if;
  if new.is_training is distinct from old.is_training then
    raise exception 'TRAINING_PROTECTED: training marker is immutable' using errcode='23514';
  end if;
  if not new.is_training and new.homeowner_contact_id is distinct from old.homeowner_contact_id
    and public.is_training_target(null,new.homeowner_contact_id) then
    raise exception 'TRAINING_PROTECTED: training contact cannot become a customer' using errcode='23514';
  end if;
  if old.is_training and (new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.homeowner_contact_id is distinct from old.homeowner_contact_id
    or new.is_dnc_locked is distinct from old.is_dnc_locked or new.outreach_dispo is distinct from old.outreach_dispo
    or new.status is distinct from old.status) then
    raise exception 'TRAINING_PROTECTED: identity and customer disposition cannot change' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_training_property before insert or update or delete on public.properties
for each row execute function public.guard_training_property();

create function public.guard_training_contact() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_training_target(null,old.id) then
    if TG_OP='DELETE' then raise exception 'TRAINING_PROTECTED: training contact cannot be deleted' using errcode='23514'; end if;
    if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.phone_1 is distinct from old.phone_1
      or new.phone_2 is distinct from old.phone_2 or new.phone_3 is distinct from old.phone_3
      or new.do_not_contact is distinct from old.do_not_contact or new.sms_opted_out is distinct from old.sms_opted_out
      or new.sms_opted_out_at is distinct from old.sms_opted_out_at then
      raise exception 'TRAINING_PROTECTED: contact identity and consent cannot change' using errcode='23514';
    end if;
  end if;
  if TG_OP='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger guard_training_contact before update or delete on public.contacts
for each row execute function public.guard_training_contact();

create function public.guard_training_customer_action() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  row_data jsonb := to_jsonb(new);
  property_ref uuid;
  contact_ref uuid;
  target_phone text;
begin
  if TG_TABLE_NAME='messages' and row_data->>'direction' <> 'outbound' then return new; end if;
  property_ref := coalesce(row_data->>'property_id',row_data->>'related_property_id')::uuid;
  contact_ref := (row_data->>'contact_id')::uuid;
  if TG_TABLE_NAME='messages' then target_phone := row_data->>'to_address'; end if;
  if public.is_training_target(property_ref,contact_ref,target_phone) then
    raise exception 'TRAINING_PROTECTED: customer workflow unavailable for training' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_training_messages before insert or update on public.messages
for each row execute function public.guard_training_customer_action();
create trigger guard_training_enrollments before insert or update on public.sequence_enrollments
for each row execute function public.guard_training_customer_action();
create trigger guard_training_tasks before insert or update on public.tasks
for each row execute function public.guard_training_customer_action();
create trigger guard_training_esign before insert or update on public.esign_requests
for each row execute function public.guard_training_customer_action();
create trigger guard_training_consent before insert or update on public.consent_events
for each row execute function public.guard_training_customer_action();

revoke all on function public.guard_training_property(), public.guard_training_contact(), public.guard_training_customer_action() from public, anon, authenticated;
comment on column public.properties.is_training is 'Server-created fictional practice lead. Ordinary Call keeps null customer references; customer workflows are prohibited.';
commit;
