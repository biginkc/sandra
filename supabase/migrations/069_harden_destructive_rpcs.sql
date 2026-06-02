-- 069_harden_destructive_rpcs.sql
--
-- Lock destructive helper RPCs to their intended callers.

begin;

create or replace function public.delete_contact(p_contact_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  contact_row public.contacts%rowtype;
  caller_id uuid := auth.uid();
begin
  if caller_id is null then
    raise exception 'delete_contact: authenticated user required'
      using errcode = '28000';
  end if;

  select *
    into contact_row
    from public.contacts
    where id = p_contact_id
    for update;

  if contact_row.id is null then
    raise exception 'delete_contact: contact not found (%)', p_contact_id
      using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = caller_id
      and m.org_id = contact_row.org_id
  ) then
    raise exception 'delete_contact: caller is not authorized for org %',
      contact_row.org_id
      using errcode = '42501';
  end if;

  update public.messages
    set contact_id = null,
        body = '[contact deleted: ' || coalesce(p_reason, 'unspecified') || ']'
    where contact_id = p_contact_id
      and org_id = contact_row.org_id;

  delete from public.contacts
    where id = p_contact_id
      and org_id = contact_row.org_id;
end;
$$;

revoke execute on function public.delete_contact(uuid, text) from public;
revoke execute on function public.delete_contact(uuid, text) from anon;
grant execute on function public.delete_contact(uuid, text) to authenticated;
grant execute on function public.delete_contact(uuid, text) to service_role;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from anon;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;

commit;
