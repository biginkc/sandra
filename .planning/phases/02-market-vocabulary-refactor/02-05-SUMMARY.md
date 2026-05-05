---
phase: 02-market-vocabulary-refactor
plan: 05
subsystem: tests
tags: [rtl, vitest, playwright, e2e, integration, backfill, county-vocabulary, ci-verify]

requires:
  - phase: 02-04
    provides: Migration 046 backfill (1,096 props), migration 047 fips_codes seed, prod+test DBs green

provides:
  - filter.test.ts updated: county-shaped + legacy "Kansas City" fixtures coexist; all 524 unit tests green
  - Migration 046 integration test: 4 behavioral assertions (happy path, leave-alone, CASS jsonb, idempotency)
  - Playwright smoke spec: import wizard market dropdown asserts county-shaped strings, negates legacy strings
  - Playwright smoke spec: /properties market filter pill asserts county-shaped data-testids, negates legacy
  - PENDING (Task 3): human sign-off on 7-step post-merge verification checklist

affects: [STATE.md, ROADMAP.md — orchestrator owns those writes after wave completes]

tech-stack:
  added: []
  patterns: [tdd-red-green, integration-test-behavioral-semantics, playwright-e2e-smoke]

key-files:
  created:
    - supabase/migrations/046_backfill_property_county_id_from_fips.integration.test.ts
    - e2e/import-wizard-counties.spec.ts
    - e2e/properties-market-filter.spec.ts
  modified:
    - src/app/(dashboard)/leads/filter.test.ts
    - vitest.integration.config.ts

key-decisions:
  - "Plan referenced tests/playwright/ but testDir=./e2e; Playwright specs placed in e2e/ (Rule 3 deviation)"
  - "vitest.integration.config.ts extended to include supabase/migrations/**/*.integration.test.ts (Rule 3 deviation)"
  - "Integration test uses ORM-style JS client to replicate migration 046 SQL semantics (no raw SQL executor in test suite)"
  - "filter.test.ts homeowner-first-name test uses two-token query (john smith) to avoid false match on Johnson County KS"
  - "D-05 coexistence: legacy Kansas City fixture retained in filter.test.ts; lists/tags integration tests untouched"

duration: ~30min
completed: 2026-05-05
---

# Phase 02-05: Market Vocabulary Refactor — Test Wave Summary

**PARTIAL — paused at Task 3 checkpoint (human sign-off required to close Phase 02)**

**Updated filter.test.ts with county-shaped + legacy "Kansas City" fixtures; added migration 046 integration test covering 4 behaviors; added 2 Playwright smoke specs asserting county vocabulary in wizard + filter pill; all 524 unit tests green**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-05-05T20:03:00Z
- **Completed (tasks 1+2):** 2026-05-05T20:35:00Z
- **Tasks executed:** 2 of 3 (paused at Task 3 checkpoint)
- **Files modified:** 2
- **Files created:** 3

## Accomplishments

### Task 1 (TDD — filter.test.ts + migration 046 integration test)

**RED phase (commit 977e735):** Updated filter.test.ts fixtures — 2 of 4 leads now carry county-shaped market strings (Jackson County MO, Johnson County KS). 1 lead retains legacy "Kansas City" (D-05 coexistence). 5 assertions failed as expected.

**GREEN phase (commit 0af3d5a):** Fixed stale assertions:
- ZIP test: 63101 (St. Louis, removed) → 64108 (Kansas City MO, retained Lead 2)
- "dayton" assertion: 1 → 0 (legacy city fixture removed)
- AND-token test: "MO st" now yields 1 (Lead 0 has "Jackson County MO" state + "123 Main St")
- Homeowner first-name test: "john" → "john smith" (two-token to avoid false match on "Johnson County KS")
- AND multi-token test: "kansas smith" → "jackson smith" (cross-field AND with new vocab)

All 524 unit tests green.

**lists.integration.test.ts + tags.integration.test.ts:** Unchanged per PATTERNS option (b). No KNOWN_MARKETS or WizardMarket imports found — no changes needed.

**Migration 046 integration test (commit 44cc313):**
- `supabase/migrations/046_backfill_property_county_id_from_fips.integration.test.ts`
- Test 3 (happy path): fips_code JOIN → county_id + market set for Jackson County MO (FIPS 29095)
- Test 4 (leave-alone): NULL fips_code + NULL cass_raw_response → county_id stays NULL, market "Kansas City" unchanged (D-05)
- Test 5 (CASS jsonb): cass_raw_response[0].metadata.county_fips → county_id resolved via county JOIN
- Test 6 (idempotency): re-running both UPDATE steps on already-backfilled rows is a no-op

**vitest.integration.config.ts:** Extended `include` glob to `supabase/migrations/**/*.integration.test.ts` (Rule 3 — without this, the new test file would be unreachable).

### Task 2 (Playwright smoke specs)

**e2e/import-wizard-counties.spec.ts (commit 8f67a04):**
- Navigates: `/import` → `mode-add` → Next → opens Market select trigger
- Positive: asserts "Buchanan County MO", "Johnson County KS", "Lincoln Parish LA" are visible as options
- Negative: asserts "St. Louis", "Dayton", "Lake of the Ozarks" have count 0
- Bonus: selecting "Jackson County MO" updates the trigger label

**e2e/properties-market-filter.spec.ts (commit 8f67a04):**
- Navigates: `/properties` → clicks `data-testid="filter-market"` trigger
- Positive: asserts `filter-market-Buchanan-County-MO`, `filter-market-Johnson-County-KS`, `filter-market-Jackson-County-MO` visible
- Negative: asserts `filter-market-Kansas-City`, `filter-market-St.-Louis` have count 0
- Bonus: Anywhere option present; selecting market updates trigger label

## Task Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 (TDD RED) | 977e735 | test(02-05): RED — update filter.test.ts fixtures to county-shaped strings |
| Task 1 (TDD GREEN) | 0af3d5a | feat(02-05): GREEN — fix filter.test.ts assertions for county-shaped fixtures |
| Task 1 (integration) | 44cc313 | test(02-05): add migration 046 integration test + extend vitest integration config |
| Task 2 | 8f67a04 | feat(02-05): add Playwright smoke specs for wizard county dropdown + properties market filter |

## Checkpoint (Task 3 — BLOCKING)

**Status: Awaiting human sign-off before Phase 02 can be closed.**

Task 3 is a `checkpoint:human-verify` gate. The orchestrator will present a 7-step checklist:

1. Confirm Phase 02 PR is merged (`gh pr list --state merged --limit 1`)
2. Confirm db-migrate.yml succeeded on merge commit (both migrate-prod + migrate-test jobs)
3. MCP read-only query against PROD (`copflsklaefwzipsrjqz`) — confirm schema_migrations has versions 043, 044, 045
4. Same query against TEST (`ncsngxlcyxylaeskiteu`) — expect 3 rows
5. PROD sanity SELECT: ~1,096 properties with county_id IS NOT NULL; ~1,437 with county_id=NULL + market='Kansas City'
6. Browser visual check: `/import` wizard market dropdown shows county-shaped names; `/properties` Market filter same
7. Jarrad replies "approved"

**Note on migration version numbering:** The plan was written with "043/044/045" in the checkpoint checklist. The actual migration chain is 043, 044, 045 (outreach_dispo), 046 (backfill), 047 (fips seed fix). The MCP query for the checkpoint should verify 043, 044, 046, 047 are all present (045 is outreach_dispo — not Phase 02 market work but still required). When Jarrad runs the checkpoint verification, checking for 043-047 inclusive is the correct scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Playwright specs placed in e2e/ not tests/playwright/**
- **Found during:** Task 2 setup
- **Issue:** Plan specified `tests/playwright/` but `playwright.config.ts` sets `testDir: "./e2e"` — specs in `tests/playwright/` would never be picked up by `npx playwright test`
- **Fix:** Placed both specs in `e2e/` where Playwright finds them
- **Files modified:** e2e/import-wizard-counties.spec.ts, e2e/properties-market-filter.spec.ts
- **Commit:** 8f67a04

**2. [Rule 3 — Blocking] vitest integration config did not include supabase/migrations/**
- **Found during:** Task 1 integration test writing
- **Issue:** `vitest.integration.config.ts` only included `src/**/*.integration.test.ts`; the required `supabase/migrations/046_backfill_property_county_id_from_fips.integration.test.ts` would never run
- **Fix:** Extended `include` array with `supabase/migrations/**/*.integration.test.ts`
- **Files modified:** vitest.integration.config.ts
- **Commit:** 44cc313

**3. [Rule 1 — Design] "john" token would false-match Lead 1's "Johnson County KS"**
- **Found during:** Task 1 GREEN phase, tracing assertion failures
- **Issue:** The homeowner first-name test queried `filterLeads(leads, "john")` — with the new fixture "Johnson County KS" (Lead 1), "john" appears in "johnson", yielding 2 results instead of 1
- **Fix:** Changed query to `filterLeads(leads, "john smith")` — two-token AND ensures only Lead 0 matches (both first + last name tokens required)
- **Files modified:** src/app/(dashboard)/leads/filter.test.ts
- **Commit:** 0af3d5a

## Known Stubs

None — all new test files assert against real seeded data. The Playwright specs depend on:
- `e2e/.auth/user.json` (auth setup) — must be created by `auth.setup.ts` before specs run
- The counties table being seeded in the test DB (migrations 044 + 047 applied)

Both preconditions are satisfied in the test DB (`ncsngxlcyxylaeskiteu`) per the .continue-here.md state.

## Threat Surface Scan

No new production code paths introduced. New files are test-only:
- Integration test: read + write against test DB (ncsngxlcyxylaeskiteu) via service role key — existing threat model
- Playwright specs: read-only browser automation against dev server with test DB — existing threat model
- vitest.integration.config.ts: build/test tooling only, no runtime surface

No threat flags.

## Self-Check

Files created:
- supabase/migrations/046_backfill_property_county_id_from_fips.integration.test.ts ✓
- e2e/import-wizard-counties.spec.ts ✓
- e2e/properties-market-filter.spec.ts ✓

Files modified:
- src/app/(dashboard)/leads/filter.test.ts ✓
- vitest.integration.config.ts ✓

Commits:
- 977e735 ✓ (test RED)
- 0af3d5a ✓ (feat GREEN)
- 44cc313 ✓ (test integration + config)
- 8f67a04 ✓ (feat Playwright specs)

Unit tests: 524/524 pass ✓
Typecheck: clean ✓

## Self-Check: PASSED

---
*Phase: 02-market-vocabulary-refactor*
*Plan: 05 (Wave 4 — Verification)*
*Status: PARTIAL — paused at Task 3 human checkpoint*
*Completed tasks: 2/3*
