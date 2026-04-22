-- ============================================================================
-- Fix ordering bug in merge_duplicate_properties().
--
-- The previous implementation updated the keeper's columns (coalescing
-- from the loser) *before* deleting the loser. When keeper and loser
-- shared a value on any unique index (zpid, mls_number, regrid_id,
-- attom_id, address_normalized, or apn+fips), the UPDATE tripped
-- `properties_*_key` with "duplicate key value violates unique
-- constraint" — same value lived on both rows for a moment.
--
-- Fix: snapshot the loser into `property_merges`, re-point dependents,
-- DELETE the loser to free the unique indexes, THEN UPDATE the keeper.
-- All happens in the single SECURITY DEFINER function body, so it's
-- still atomic.
--
-- Caught by tests in `src/lib/sql/merge-duplicate-properties.integration.test.ts`.
-- ============================================================================

create or replace function merge_duplicate_properties(keeper_id uuid, loser_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  keeper_row properties%rowtype;
  loser_row  properties%rowtype;
begin
  select * into keeper_row from properties where id = keeper_id for update;
  select * into loser_row  from properties where id = loser_id  for update;

  if keeper_row.id is null or loser_row.id is null then
    raise exception 'merge_duplicate_properties: one or both rows not found (keeper=%, loser=%)',
      keeper_id, loser_id;
  end if;

  -- Snapshot + re-point + delete the loser FIRST so the unique indexes
  -- it held are free when we update the keeper below.
  insert into property_merges (keeper_id, loser_id, merged_at, loser_snapshot)
  values (keeper_id, loser_id, now(), to_jsonb(loser_row));

  update messages  set property_id = keeper_id where property_id = loser_id;
  update job_items set property_id = keeper_id where property_id = loser_id;

  delete from properties where id = loser_id;

  -- Now coalesce the loser's non-null fields into the keeper.
  update properties set
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
  where id = keeper_id;
end;
$$;
