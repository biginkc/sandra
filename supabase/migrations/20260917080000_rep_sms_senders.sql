begin;

-- Independent of Dialpad voice identities: shared numbers are explicit grants.
create table public.rep_sms_sender_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  provider text not null default 'dialpad' check(provider = 'dialpad'),
  phone_e164 text not null check(phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  label text not null check(length(label) between 1 and 120),
  is_default boolean not null default false,
  active boolean not null default true,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  unique(org_id,user_id,provider,phone_e164)
);
create unique index rep_sms_one_default on public.rep_sms_sender_assignments(org_id,user_id)
  where active and is_default;
alter table public.rep_sms_sender_assignments enable row level security;
revoke all on public.rep_sms_sender_assignments from anon,authenticated;
grant select on public.rep_sms_sender_assignments to authenticated;
grant all on public.rep_sms_sender_assignments to service_role;
create policy rep_sms_read on public.rep_sms_sender_assignments for select to authenticated using (
  exists(select 1 from public.memberships m where m.org_id=rep_sms_sender_assignments.org_id
    and m.user_id=auth.uid() and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>now())
    and (m.role='owner' or rep_sms_sender_assignments.user_id=auth.uid()))
);

create function public.fn_set_rep_sms_sender(p_org_id uuid,p_user_id uuid,p_phone text,p_label text,p_default boolean,p_active boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if auth.uid() is null or not exists(select 1 from public.memberships m where m.org_id=p_org_id
    and m.user_id=auth.uid() and m.role='owner' and m.access_status='active' and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at>statement_timestamp())) then
    raise exception 'Only an active owner can assign texting numbers' using errcode='42501';
  end if;
  if p_active and not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_user_id
    and access_status='active' and deletion_prepared_at is null
    and (access_expires_at is null or access_expires_at>statement_timestamp())) then
    raise exception 'Choose an active member of this organization' using errcode='42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text||p_user_id::text,0));
  if p_default and p_active then
    update public.rep_sms_sender_assignments set is_default=false,updated_at=now(),updated_by=auth.uid()
      where org_id=p_org_id and user_id=p_user_id and is_default;
  end if;
  insert into public.rep_sms_sender_assignments(org_id,user_id,phone_e164,label,is_default,active,updated_by)
    values(p_org_id,p_user_id,p_phone,btrim(p_label),p_default and p_active,p_active,auth.uid())
    on conflict(org_id,user_id,provider,phone_e164) do update set label=excluded.label,
      is_default=excluded.is_default,active=excluded.active,updated_by=excluded.updated_by,updated_at=now()
    returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.fn_set_rep_sms_sender(uuid,uuid,text,text,boolean,boolean) from public,anon;
grant execute on function public.fn_set_rep_sms_sender(uuid,uuid,text,text,boolean,boolean) to authenticated;

create function public.fn_get_rep_sms_context(p_property_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_org uuid; v_contact uuid; v_senders jsonb;
begin
  select p.org_id,p.homeowner_contact_id into v_org,v_contact from public.properties p where p.id=p_property_id;
  if v_org is null or auth.uid() is null then raise exception 'Lead unavailable' using errcode='42501'; end if;
  perform public.my_leads_require_read_scope(v_org,auth.uid());
  if not exists(select 1 from public.memberships m where m.org_id=v_org and m.user_id=auth.uid()
    and (m.acquisitions_enabled or m.role='owner')) then
    raise exception 'Acquisitions access required' using errcode='42501';
  end if;
  -- Reuse the authoritative queue, including open episode and archive checks.
  if not exists(select 1 from public.my_leads_queue_rows(v_org,auth.uid(),statement_timestamp()) q
    where q.property_id=p_property_id) then
    raise exception 'You can text only leads currently in your queue' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.phone_e164,'label',s.label,
    'isDefault',s.is_default) order by s.is_default desc,s.label,s.id),'[]'::jsonb)
    into v_senders from public.rep_sms_sender_assignments s
    where s.org_id=v_org and s.user_id=auth.uid() and s.active;
  return jsonb_build_object('orgId',v_org,'actorId',auth.uid(),'contactId',v_contact,'senders',v_senders);
end;
$$;
revoke all on function public.fn_get_rep_sms_context(uuid) from public,anon;
grant execute on function public.fn_get_rep_sms_context(uuid) to authenticated;

commit;
