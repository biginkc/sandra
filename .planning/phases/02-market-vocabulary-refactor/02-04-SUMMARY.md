---
phase: 02-market-vocabulary-refactor
plan: 04
subsystem: database
tags: [supabase-migration, backfill, properties, fips, jsonb, idempotent]

requires:
  - phase: 02-01
    provides: counties.fips_code column + csv_imports.county_id FK (migration 043)
  - phase: 02-02
    provides: 21 counties seeded with fips_code (migration 044)
provides:
  - Migration 046 — idempotent backfill of properties.county_id + market via FIPS JOIN and CASS jsonb
  - Migration 047 — seeds fips_codes reference table + fixes counties.fips_code + re-runs backfill
  - 1,096 prod properties now have county_id set
  - 1,437 legacy 'Kansas City' properties intentionally left alone (D-05)
affects: [02-05]

tech-stack:
  added: []
  patterns: [idempotent-backfill, begin-commit-wrap, jsonb-path-extraction]

key-files:
  created:
    - supabase/migrations/046_backfill_property_county_id_from_fips.sql
    - supabase/migrations/047_seed_fips_codes_and_fix_county_backfill.sql
  modified:
    - .github/workflows/db-migrate.yml

key-decisions:
  - "Migration renamed 046 (045 was taken by outreach_dispo PR #105)"
  - "Migration 047 seeds fips_codes + re-runs backfill — root cause was fips_codes table empty since initial schema"
  - "db-migrate.yml --include-all flag added to handle out-of-order migration inserts"
  - "1,437 'Kansas City' properties left alone per D-05 — county_id=NULL until next CASS verify"

patterns-established:
  - "Idempotent backfill: WHERE county_id IS NULL gates both UPDATE steps"
  - "Two-source backfill: fips_code JOIN first, CASS jsonb fallback second"
  - "Root-cause fix via new migration rather than re-running existing one"

requirements-completed: [MARKET-03]

duration: 45min
completed: 2026-05-05
---

# Phase 02-04: Market Vocabulary Refactor — Backfill Summary

**BEGIN/COMMIT-wrapped migration 046 backfills 1,096 properties.county_id via FIPS JOIN + CASS jsonb; migration 047 fixes the root cause (empty fips_codes table) and re-runs the backfill successfully**

## Performance

- **Duration:** ~45 min (including root-cause investigation)
- **Started:** 2026-05-05T19:00:00Z
- **Completed:** 2026-05-05T19:48:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Migration 046 written: idempotent two-step backfill (FIPS JOIN → CASS jsonb fallback), wrapped in BEGIN/COMMIT
- Root cause discovered: `fips_codes` reference table was empty since initial schema — 046 subqueries returned null, touching 0 rows initially
- Migration 047 written: seeds fips_codes (21 BMH counties), updates counties.fips_code from that table, then re-runs the 046 backfill logic
- db-migrate.yml updated with `--include-all` flag (required for out-of-order migration inserts)
- Prod result: 1,096 properties backfilled; 1,437 legacy 'Kansas City' intentional no-ops (D-05)
- Both prod (`copflsklaefwzipsrjqz`) and test (`ncsngxlcyxylaeskiteu`) have migrations 043-047 green

## Task Commits

1. **Task 1: Pre-flight row counts** — verified via MCP read-only before writing migration
2. **Task 2: Write migration 046** — `d404408` (feat(02-04): add migration 046)
   - Discovery mid-execution: fips_codes empty → 047 created as root-cause fix
   - **Migration 047** — `bb179d4` (feat(02): migration 047 — seed fips_codes + fix county/property backfill)
   - **CI fix** — `5630f4b` (ci(db-migrate): add --include-all flag to supabase db push)

## Files Created/Modified
- `supabase/migrations/046_backfill_property_county_id_from_fips.sql` — idempotent two-step backfill
- `supabase/migrations/047_seed_fips_codes_and_fix_county_backfill.sql` — seeds fips_codes, fixes counties.fips_code, re-runs backfill
- `.github/workflows/db-migrate.yml` — added `--include-all` flag

## Decisions Made
- Migration renumbered 046 (045 was taken by outreach_dispo feature PR #105 that merged concurrently)
- Root-cause fix isolated to a separate migration (047) rather than modifying 046 — keeps 046 semantically correct for integration testing
- `--include-all` added to `supabase db push` in db-migrate.yml so out-of-order inserts (like 047 added after 046) apply correctly

## Deviations from Plan

### Auto-fixed Issues

**1. fips_codes reference table was empty — silent 0-row backfill**
- **Found during:** Task 1 pre-flight (JOIN matched 0 rows despite counties table seeded)
- **Issue:** `fips_codes` created in 001_initial.sql but never seeded; 046's UPDATE...FROM JOIN returned nothing
- **Fix:** Created migration 047 to seed fips_codes (21 counties), update counties.fips_code via JOIN, then re-run backfill UPDATE logic
- **Files modified:** supabase/migrations/047_seed_fips_codes_and_fix_county_backfill.sql (new), .github/workflows/db-migrate.yml
- **Verification:** SELECT count(*) FROM properties WHERE county_id IS NOT NULL → 1,096 on prod
- **Committed in:** bb179d4, 5630f4b

---

**Total deviations:** 1 auto-fixed (root-cause discovery → new migration)
**Impact on plan:** No scope creep — still satisfies MARKET-03. Migration 046 is semantically correct for integration testing (it holds the backfill logic); 047 is infrastructure prep.

## Issues Encountered
- Migration 045 name collision with outreach_dispo (PR #105 merged during this session) — resolved by renaming backfill to 046
- db-migrate.yml lacked `--include-all` flag, causing 047 (inserted after 046) to not apply — added flag and verified CI green

## Next Phase Readiness
- 1,096 properties have county_id set on prod + test
- 1,437 legacy 'Kansas City' properties ready for CASS re-verify (deferred, per D-05)
- Integration test for 046 and Playwright smokes are the next deliverable (plan 02-05)

---
*Phase: 02-market-vocabulary-refactor*
*Completed: 2026-05-05*
