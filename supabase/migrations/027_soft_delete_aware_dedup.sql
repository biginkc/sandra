-- 027_soft_delete_aware_dedup.sql
--
-- Make every dedup-key unique index on `properties` soft-delete-aware.
-- Without this, a soft-deleted property with `address_normalized = X`
-- still occupies the unique slot — re-importing the same address after
-- a soft-delete fails with a duplicate-key violation, even though the
-- application-layer dedup query (findExistingProperty in ingest.ts)
-- correctly skips soft-deleted rows.
--
-- The fix: append `AND deleted_at IS NULL` to each partial unique index.
-- Soft-deleted rows release their slot; re-imports create fresh rows
-- that own the address again. If you want to *resurrect* instead of
-- create-fresh, that's a separate explicit flow (not implemented today;
-- see findExistingProperty in src/lib/csv/ingest.ts).

drop index if exists public.properties_fips_apn_key;
create unique index properties_fips_apn_key
  on public.properties (fips_code, apn_normalized)
  where fips_code is not null
    and apn_normalized is not null
    and deleted_at is null;

drop index if exists public.properties_regrid_key;
create unique index properties_regrid_key
  on public.properties (regrid_id)
  where regrid_id is not null
    and deleted_at is null;

drop index if exists public.properties_attom_key;
create unique index properties_attom_key
  on public.properties (attom_id)
  where attom_id is not null
    and deleted_at is null;

drop index if exists public.properties_zpid_key;
create unique index properties_zpid_key
  on public.properties (zpid)
  where zpid is not null
    and deleted_at is null;

drop index if exists public.properties_mls_number_key;
create unique index properties_mls_number_key
  on public.properties (mls_number)
  where mls_number is not null
    and deleted_at is null;

drop index if exists public.properties_address_normalized_key;
create unique index properties_address_normalized_key
  on public.properties (address_normalized)
  where address_normalized is not null
    and deleted_at is null;
