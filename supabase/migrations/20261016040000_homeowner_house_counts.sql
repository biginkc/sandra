-- Exact "Owns N houses" counts for a page of homeowners in one round trip.
-- SECURITY INVOKER: the caller's properties RLS (054) still keeps the read inside the caller's orgs;
-- p_org_id narrows a multi-org member to the org being viewed. More than 100 ids is refused.
begin;

create or replace function public.fn_homeowner_house_counts(p_org_id uuid, p_contact_ids uuid[])
returns table(homeowner_contact_id uuid, house_count bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_contact_ids), 0) > 100 then
    raise exception 'Too many homeowners in one read' using errcode = '22023';
  end if;
  return query
    select p.homeowner_contact_id, count(*)::bigint
    from public.properties p
    where p.org_id = p_org_id
      and p.homeowner_contact_id = any(p_contact_ids)
      and p.deleted_at is null
    group by p.homeowner_contact_id;
end;
$$;

revoke all on function public.fn_homeowner_house_counts(uuid, uuid[]) from public, anon, service_role;
grant execute on function public.fn_homeowner_house_counts(uuid, uuid[]) to authenticated;

commit;
