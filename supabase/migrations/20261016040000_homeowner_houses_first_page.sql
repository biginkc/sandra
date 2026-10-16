-- "Owns N houses" first paint for a page of homeowners in one round trip: ONE row per owner with the exact house count
-- and a jsonb array of their first 50 houses ordered by address, then id (the same order "Show more" pages in).
-- One row per owner keeps the response at most 100 rows, well under PostgREST's 1,000-row response cap.
-- SECURITY INVOKER: the caller's properties RLS (054) still keeps the read inside the caller's orgs;
-- p_org_id narrows a multi-org member to the org being viewed. More than 100 ids is refused.
begin;

create or replace function public.fn_homeowner_houses_first_page(p_org_id uuid, p_contact_ids uuid[])
returns table(homeowner_contact_id uuid, house_count bigint, houses jsonb)
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
    select o.homeowner_contact_id, o.house_count, first_page.houses
    from (
      select p.homeowner_contact_id, count(*)::bigint as house_count
      from public.properties p
      where p.org_id = p_org_id
        and p.homeowner_contact_id = any(p_contact_ids)
        and p.deleted_at is null
      group by p.homeowner_contact_id
    ) o
    cross join lateral (
      select coalesce(
        jsonb_agg(
          jsonb_build_object('id', h.id, 'address', h.address, 'city', h.city, 'state', h.state, 'assigned_user_id', h.assigned_user_id)
          order by h.address, h.id
        ),
        '[]'::jsonb
      ) as houses
      from (
        select q.id, q.address, q.city, q.state, q.assigned_user_id
        from public.properties q
        where q.org_id = p_org_id
          and q.homeowner_contact_id = o.homeowner_contact_id
          and q.deleted_at is null
        order by q.address, q.id
        limit 50
      ) h
    ) first_page
    order by o.homeowner_contact_id;
end;
$$;

revoke all on function public.fn_homeowner_houses_first_page(uuid, uuid[]) from public, anon, service_role;
grant execute on function public.fn_homeowner_houses_first_page(uuid, uuid[]) to authenticated;

commit;
