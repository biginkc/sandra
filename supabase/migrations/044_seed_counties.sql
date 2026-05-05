-- 044_seed_counties.sql
--
-- Phase 02 — Market Vocabulary Refactor (per CONTEXT.md D-02, D-03).
-- Seeds the counties table with the 18 BMH-active counties confirmed in the
-- Drive folder, plus 3 counties present in prod FIPS data (Cass MO,
-- Wyandotte KS, Riley KS) that are PENDING JARRAD CONFIRMATION at PR review.
--
-- Format (per D-03): counties.market = "{name} {state}" (e.g.
--   "Johnson County KS", "Lincoln Parish LA"). counties.fips_code populated
--   via subquery against the static fips_codes lookup added in migration 043.
--
-- Idempotent: ON CONFLICT (name, state) DO UPDATE — re-running the migration
-- corrects market labels and fips_code on existing rows. Targets the unique
-- (name, state) constraint from 001_initial.sql:33.
--
-- fips_codes shape (verified in plan 02-02 Task 1, /tmp/02-02-fips-spike.txt):
--   - county_name stored WITHOUT "County"/"Parish"/"Borough" suffix
--     (verified by inspecting src/lib/csv/normalize.ts::normalizeCountyName +
--      src/lib/csv/fips.ts::resolveFipsFromCountyName, the production code path
--      that talks to this table today — it strips the suffix before lookup).
--   - case-insensitive match via lower(county_name) (the unique index
--     fips_codes_state_county_key already lowers the column).
--   - "Saint" vs "St." defensive: for the three Saint counties, the subquery
--     accepts EITHER stored form via an IN-list. MCP read-only verification
--     of the live table was not available to the executor agent (same
--     constraint as plan 02-01 Task 1); the IN-list bounds the risk.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml to both
--   - prod (copflsklaefwzipsrjqz)
--   - test (ncsngxlcyxylaeskiteu)
-- Per project memory feedback_migrations_only_via_ci.md: this file lands via
-- PR merge to main only; no local CLI push, no MCP-driven apply.

DO $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT id INTO v_org_id
  FROM public.organizations
  WHERE name = 'BMH Group'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE NOTICE 'BMH Group org not found — skipping county seed (test DB without seeded org)';
    RETURN;
  END IF;

  -- 18 confirmed BMH counties (Drive folder, active outreach — D-02).
  INSERT INTO public.counties (org_id, name, state, market, fips_code) VALUES
    (v_org_id, 'Buchanan County',       'MO', 'Buchanan County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Buchanan') LIMIT 1)),
    (v_org_id, 'Boone County',          'MO', 'Boone County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Boone') LIMIT 1)),
    (v_org_id, 'Clay County',           'MO', 'Clay County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Clay') LIMIT 1)),
    (v_org_id, 'Jackson County',        'MO', 'Jackson County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Jackson') LIMIT 1)),
    (v_org_id, 'Camden County',         'MO', 'Camden County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Camden') LIMIT 1)),
    -- Defensive Saint/St. IN-list: fips_codes may store either form.
    (v_org_id, 'Saint Charles County',  'MO', 'Saint Charles County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO'
         AND lower(county_name) IN (lower('Saint Charles'), lower('St. Charles'), lower('St Charles'))
       LIMIT 1)),
    (v_org_id, 'Saint Louis County',    'MO', 'Saint Louis County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO'
         AND lower(county_name) IN (lower('Saint Louis'), lower('St. Louis'), lower('St Louis'))
       LIMIT 1)),
    (v_org_id, 'Platte County',         'MO', 'Platte County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Platte') LIMIT 1)),
    (v_org_id, 'Taney County',          'MO', 'Taney County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Taney') LIMIT 1)),
    (v_org_id, 'Franklin County',       'MO', 'Franklin County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Franklin') LIMIT 1)),
    (v_org_id, 'Jefferson County',      'MO', 'Jefferson County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Jefferson') LIMIT 1)),
    (v_org_id, 'Greene County',         'MO', 'Greene County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Greene') LIMIT 1)),
    (v_org_id, 'Johnson County',        'KS', 'Johnson County KS',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'KS' AND lower(county_name) = lower('Johnson') LIMIT 1)),
    (v_org_id, 'Lincoln Parish',        'LA', 'Lincoln Parish LA',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'LA' AND lower(county_name) = lower('Lincoln') LIMIT 1)),
    (v_org_id, 'Garland County',        'AR', 'Garland County AR',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'AR' AND lower(county_name) = lower('Garland') LIMIT 1)),
    (v_org_id, 'Carroll County',        'AR', 'Carroll County AR',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'AR' AND lower(county_name) = lower('Carroll') LIMIT 1)),
    (v_org_id, 'Madison County',        'IL', 'Madison County IL',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'IL' AND lower(county_name) = lower('Madison') LIMIT 1)),
    -- Defensive Saint/St. IN-list (same pattern as the MO Saint counties).
    (v_org_id, 'Saint Clair County',    'IL', 'Saint Clair County IL',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'IL'
         AND lower(county_name) IN (lower('Saint Clair'), lower('St. Clair'), lower('St Clair'))
       LIMIT 1)),

    -- TODO(jarrad): confirm before merge — these 3 counties are present in
    -- prod FIPS data but NOT YET CONFIRMED as active markets in the Drive
    -- folder. Decision (per CONTEXT.md D-02): include with TODO so PR review
    -- is the gate.
    --
    -- If you DO want them, leave these rows in place (the trailing comma on
    -- the "Saint Clair County" row above must stay).
    -- If you DO NOT want them, delete these 3 lines AND remove the trailing
    -- comma on the "Saint Clair County" row above.
    (v_org_id, 'Cass County',           'MO', 'Cass County MO',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'MO' AND lower(county_name) = lower('Cass') LIMIT 1)),
    (v_org_id, 'Wyandotte County',      'KS', 'Wyandotte County KS',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'KS' AND lower(county_name) = lower('Wyandotte') LIMIT 1)),
    (v_org_id, 'Riley County',          'KS', 'Riley County KS',
      (SELECT fips_code FROM public.fips_codes
       WHERE state_code = 'KS' AND lower(county_name) = lower('Riley') LIMIT 1))
  ON CONFLICT (name, state) DO UPDATE SET
    market    = EXCLUDED.market,
    fips_code = EXCLUDED.fips_code;
END;
$$;
