-- 046_backfill_property_county_id_from_fips.sql
--
-- Phase 02 — Market Vocabulary Refactor (per CONTEXT.md D-05).
-- Originally written as 045; renumbered to 046 because 045 was taken by
-- 045_outreach_dispo.sql (which landed on prod first via PR #105).
--
-- Backfill properties.county_id (and properties.market as the synced cache
-- per D-04) for the existing 2,533 production properties. Two source signals,
-- applied in order:
--
--   Step 1: properties.fips_code -> counties.fips_code (JOIN)
--           Expected ~1,149 rows (canonical from CONTEXT.md D-05).
--   Step 2: cass_raw_response[0].metadata.county_fips -> counties.fips_code
--           Expected ~26 rows (canonical from CONTEXT.md D-05).
--
-- Properties with neither signal (~1,358 rows) are LEFT ALONE per D-05 -- they
-- retain market='Kansas City' and county_id=NULL until next CASS verify
-- catches them. Per D-09 there is NO catch-all "Kansas City" county row.
-- Outliers (TX/CA/CO test data) naturally fall through the JOIN with no match.
--
-- Idempotent: each step's WHERE clause includes `p.county_id IS NULL` so
-- re-running the migration is a no-op for already-backfilled rows. Manual
-- corrections to county_id between runs are preserved.
--
-- Atomic: wrapped in BEGIN/COMMIT -- partial failure rolls back step 1's
-- updates if step 2 errors.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml to both
--   - prod (copflsklaefwzipsrjqz)
--   - test (ncsngxlcyxylaeskiteu)

begin;

-- 1. Backfill from properties.fips_code -> counties.fips_code.
update properties p
set county_id  = c.id,
    market     = c.market,
    updated_at = now()
from counties c
where c.fips_code = p.fips_code
  and p.fips_code is not null
  and p.county_id is null;

-- 2. Backfill from cass_raw_response jsonb fallback.
update properties p
set county_id  = c.id,
    market     = c.market,
    updated_at = now()
from counties c
where c.fips_code = (p.cass_raw_response->0->'metadata'->>'county_fips')
  and p.fips_code is null
  and p.cass_raw_response is not null
  and p.county_id is null;

-- 3. INTENTIONAL NO-OP: ~1,358 rows with neither signal keep market='Kansas City',
--    county_id=NULL. They resolve on next CASS verify. No synthetic Kansas City
--    county row (D-05 + D-09). No DB trigger (sync is application-layer per D-04).

commit;
