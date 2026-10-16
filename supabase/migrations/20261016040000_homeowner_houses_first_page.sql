-- "Owns N houses" first paint for a page of homeowners in one round trip: each owner's exact house count plus
-- their first 50 houses ordered by address, then id (the same order "Show more" pages in).
-- SECURITY INVOKER: the caller's properties RLS (054) still keeps the read inside the caller's orgs;
-- p_org_id narrows a multi-org member to the org being viewed. More than 100 ids is refused.
begin;

create or replace function public.fn_homeowner_houses_first_page(p_org_id uuid, p_contact_ids uuid[])
returns table(
  homeowner_contact_id uuid,
  house_count bigint,
  id uuid,
  address text,
  city text,
  state text,
  assigned_user_id uuid
)
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
    select r.homeowner_contact_id, r.house_count, r.id, r.address, r.city, r.state, r.assigned_user_id
    from (
      select
        p.homeowner_contact_id,
        count(*) over (partition by p.homeowner_contact_id) as house_count,
        row_number() over (partition by p.homeowner_contact_id order by p.address, p.id) as rn,
        p.id,
        p.address::text as address,
        p.city::text as city,
        p.state::text as state,
        p.assigned_user_id
      from public.properties p
      where p.org_id = p_org_id
        and p.homeowner_contact_id = any(p_contact_ids)
        and p.deleted_at is null
    ) r
    where r.rn <= 50
    order by r.homeowner_contact_id, r.rn;
end;
$$;

revoke all on function public.fn_homeowner_houses_first_page(uuid, uuid[]) from public, anon, service_role;
grant execute on function public.fn_homeowner_houses_first_page(uuid, uuid[]) to authenticated;

commit;
