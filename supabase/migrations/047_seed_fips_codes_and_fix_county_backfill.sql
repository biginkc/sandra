-- 047_seed_fips_codes_and_fix_county_backfill.sql
--
-- Phase 02 — Market Vocabulary Refactor (follow-up to 044 + 046).
--
-- Root cause: migration 044 populated counties.fips_code via subqueries against
-- the fips_codes reference table, but fips_codes was never seeded (it was
-- created empty in 001_initial.sql and no subsequent migration filled it).
-- All 044 subqueries returned null, so counties.fips_code stayed null.
-- Migration 046 (backfill) then ran against null fips_code on every county and
-- touched 0 properties.
--
-- This migration:
--   1. Seeds the fips_codes reference table with the 21 BMH counties (ON CONFLICT
--      DO NOTHING — safe to re-run on any DB that already has partial data).
--   2. Updates counties.fips_code from the now-populated fips_codes table
--      (re-does what 044 tried but failed — gated on fips_code IS NULL so
--      already-correct rows are never touched).
--   3. Re-runs the property backfill from 046 (idempotent — gated on
--      p.county_id IS NULL, so any correctly backfilled rows are preserved).
--      Includes both the fips_code JOIN path and the CASS jsonb fallback.
--
-- Idempotent at every step; atomic via BEGIN/COMMIT.
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml.

begin;

-- ============================================================================
-- Step 1: Seed fips_codes reference table for BMH's 21 active counties.
--   county_name stored WITHOUT "County"/"Parish" suffix per the convention in
--   src/lib/csv/fips.ts (resolveFipsFromCountyName strips the suffix before lookup).
--   FIPS codes follow the US Census 5-digit format: SS_CCC (state + county).
-- ============================================================================
insert into public.fips_codes (fips_code, state_code, county_name) values
  -- Arkansas (05)
  ('05015', 'AR', 'Carroll'),
  ('05051', 'AR', 'Garland'),
  -- Illinois (17)
  ('17119', 'IL', 'Madison'),
  ('17163', 'IL', 'Saint Clair'),
  -- Kansas (20)
  ('20091', 'KS', 'Johnson'),
  ('20161', 'KS', 'Riley'),
  ('20209', 'KS', 'Wyandotte'),
  -- Louisiana (22) — parishes use same format
  ('22061', 'LA', 'Lincoln'),
  -- Missouri (29)
  ('29019', 'MO', 'Boone'),
  ('29021', 'MO', 'Buchanan'),
  ('29029', 'MO', 'Camden'),
  ('29037', 'MO', 'Cass'),
  ('29047', 'MO', 'Clay'),
  ('29071', 'MO', 'Franklin'),
  ('29077', 'MO', 'Greene'),
  ('29095', 'MO', 'Jackson'),
  ('29099', 'MO', 'Jefferson'),
  ('29165', 'MO', 'Platte'),
  ('29183', 'MO', 'Saint Charles'),
  ('29189', 'MO', 'Saint Louis'),
  ('29213', 'MO', 'Taney')
on conflict (fips_code) do nothing;

-- ============================================================================
-- Step 2: Update counties.fips_code by joining back to the now-seeded
--   fips_codes table. Strips the "County"/"Parish" suffix from counties.name
--   (e.g. "Buchanan County" → "Buchanan") to match fips_codes.county_name.
--   Gated on c.fips_code IS NULL — already-correct rows are preserved.
-- ============================================================================
update counties c
set fips_code = f.fips_code
from fips_codes f
where f.state_code = c.state
  and lower(f.county_name) = lower(
    regexp_replace(c.name, '\s+(County|Parish|Borough|Municipality|City)$', '', 'i')
  )
  and c.fips_code is null;

-- ============================================================================
-- Step 3: Re-run the property backfill from migration 046 (which touched 0
--   rows because counties.fips_code was null). Now that counties.fips_code is
--   populated, both paths will find matches.
--   Both steps are gated on p.county_id IS NULL — idempotent.
-- ============================================================================

-- 3a. Primary path: properties.fips_code → counties.fips_code JOIN
update properties p
set county_id  = c.id,
    market     = c.market,
    updated_at = now()
from counties c
where c.fips_code = p.fips_code
  and p.fips_code is not null
  and p.county_id is null;

-- 3b. CASS jsonb fallback: county_fips from cass_raw_response[0].metadata
update properties p
set county_id  = c.id,
    market     = c.market,
    updated_at = now()
from counties c
where c.fips_code = (p.cass_raw_response->0->'metadata'->>'county_fips')
  and p.fips_code is null
  and p.cass_raw_response is not null
  and p.county_id is null;

commit;
