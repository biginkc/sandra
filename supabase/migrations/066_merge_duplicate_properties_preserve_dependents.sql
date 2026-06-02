-- 066_merge_duplicate_properties_preserve_dependents.sql
--
-- 062 was fetched from remote migration history. Keep it intact and repair the
-- merge function additively so property merges preserve dependent activity rows.

create or replace function public.merge_duplicate_properties(keeper_id uuid, loser_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  keeper_row public.properties%rowtype;
  loser_row public.properties%rowtype;
  caller_id uuid := auth.uid();
begin
  if keeper_id = loser_id then
    raise exception 'merge_duplicate_properties: keeper and loser must differ'
      using errcode = '22023';
  end if;

  if caller_id is null then
    raise exception 'merge_duplicate_properties: authenticated user required'
      using errcode = '28000';
  end if;

  select * into keeper_row from public.properties where id = $1 for update;
  select * into loser_row  from public.properties where id = $2 for update;

  if keeper_row.id is null or loser_row.id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found (keeper=%, loser=%)',
      $1, $2;
  end if;

  if keeper_row.org_id <> loser_row.org_id then
    raise exception 'merge_duplicate_properties: properties must belong to the same org'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = caller_id
      and m.org_id = keeper_row.org_id
  ) then
    raise exception 'merge_duplicate_properties: caller is not authorized for org %',
      keeper_row.org_id
      using errcode = '42501';
  end if;

  insert into public.property_merges (
    org_id,
    keeper_id,
    loser_id,
    merged_at,
    merged_by,
    loser_snapshot
  )
  values (
    keeper_row.org_id,
    $1,
    $2,
    now(),
    caller_id,
    to_jsonb(loser_row)
  );

  update public.messages
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  update public.job_items ji
    set property_id = $1
    from public.jobs j
    where ji.job_id = j.id
      and ji.property_id = $2
      and j.org_id = keeper_row.org_id;

  delete from public.sequence_enrollments loser_enrollment
    where loser_enrollment.property_id = $2
      and loser_enrollment.org_id = keeper_row.org_id
      and loser_enrollment.status in ('active', 'paused')
      and exists (
        select 1
        from public.sequence_enrollments keeper_enrollment
        where keeper_enrollment.sequence_id = loser_enrollment.sequence_id
          and keeper_enrollment.property_id = $1
          and keeper_enrollment.status in ('active', 'paused')
      );

  update public.sequence_enrollments
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  delete from public.property_lists loser_list
    where loser_list.property_id = $2
      and loser_list.org_id = keeper_row.org_id
      and exists (
        select 1
        from public.property_lists keeper_list
        where keeper_list.list_id = loser_list.list_id
          and keeper_list.property_id = $1
      );

  update public.property_lists
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  delete from public.property_tags loser_tag
    where loser_tag.property_id = $2
      and loser_tag.org_id = keeper_row.org_id
      and exists (
        select 1
        from public.property_tags keeper_tag
        where keeper_tag.tag_id = loser_tag.tag_id
          and keeper_tag.property_id = $1
      );

  update public.property_tags
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  update public.lead_notes
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  update public.dialer_batch_items dbi
    set property_id = $1
    from public.dialer_batches db
    where dbi.batch_id = db.id
      and dbi.property_id = $2
      and db.org_id = keeper_row.org_id;

  update public.call_activities
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  update public.tasks
    set related_property_id = $1
    where related_property_id = $2
      and org_id = keeper_row.org_id;

  update public.closer_practice_outcomes
    set property_id = $1
    where property_id = $2
      and org_id = keeper_row.org_id;

  delete from public.properties where id = $2;

  update public.properties set
    apn                  = coalesce(properties.apn, loser_row.apn),
    apn_normalized       = coalesce(properties.apn_normalized, loser_row.apn_normalized),
    fips_code            = coalesce(properties.fips_code, loser_row.fips_code),
    regrid_id            = coalesce(properties.regrid_id, loser_row.regrid_id),
    attom_id             = coalesce(properties.attom_id, loser_row.attom_id),
    zpid                 = coalesce(properties.zpid, loser_row.zpid),
    mls_number           = coalesce(properties.mls_number, loser_row.mls_number),
    lat                  = coalesce(properties.lat, loser_row.lat),
    lon                  = coalesce(properties.lon, loser_row.lon),
    address_normalized   = coalesce(properties.address_normalized, loser_row.address_normalized),
    county_id            = coalesce(properties.county_id, loser_row.county_id),
    market               = coalesce(properties.market, loser_row.market),
    beds                 = coalesce(properties.beds, loser_row.beds),
    baths                = coalesce(properties.baths, loser_row.baths),
    sqft                 = coalesce(properties.sqft, loser_row.sqft),
    year_built           = coalesce(properties.year_built, loser_row.year_built),
    listing_price        = coalesce(properties.listing_price, loser_row.listing_price),
    arv                  = coalesce(properties.arv, loser_row.arv),
    repair_estimate      = coalesce(properties.repair_estimate, loser_row.repair_estimate),
    mortgage_balance     = coalesce(properties.mortgage_balance, loser_row.mortgage_balance),
    equity_estimate      = coalesce(properties.equity_estimate, loser_row.equity_estimate),
    homeowner_contact_id = coalesce(properties.homeowner_contact_id, loser_row.homeowner_contact_id),
    agent_contact_id     = coalesce(properties.agent_contact_id, loser_row.agent_contact_id),
    is_vacant            = coalesce(properties.is_vacant, loser_row.is_vacant),
    is_seasonal          = coalesce(properties.is_seasonal, loser_row.is_seasonal),
    is_residential       = coalesce(properties.is_residential, loser_row.is_residential),
    vacant_since         = coalesce(properties.vacant_since, loser_row.vacant_since),
    owner_moved_at       = coalesce(properties.owner_moved_at, loser_row.owner_moved_at),
    absentee_flag        = coalesce(properties.absentee_flag, loser_row.absentee_flag),
    cass_verified_at     = greatest(properties.cass_verified_at, loser_row.cass_verified_at),
    ncoa_verified_at     = greatest(properties.ncoa_verified_at, loser_row.ncoa_verified_at),
    updated_at           = now()
  where id = $1;
end;
$$;

revoke execute on function public.merge_duplicate_properties(uuid, uuid) from public;
grant execute on function public.merge_duplicate_properties(uuid, uuid) to authenticated;
