# Milestones

## v2.0 Cross-table UX consistency + market refactor (Shipped: 2026-05-06)

**Phases completed:** 3 phases, 16 plans, 37 tasks

**Key accomplishments:**

- Shared URL-state foundation extracted: `parseTableSearch` + `buildTableHref` pure helpers and `useTableUrlState` hook with `TableUrlStateContext`, backed by 23 tests (12 unit + 11 RTL)
- Compound toolbar primitives (TableToolbar + TableToolbarSearch + TableToolbarFilterPill) and a generic SortableHeader extracted, backed by 17 new RTL tests; prospects-table regression suite remains green.
- `/properties` consumes useTableUrlState + TableToolbar + SortableHeader — proven by 61 untouched regression tests (35 prospects-query unit + 26 prospects-table RTL) staying green byte-for-byte; full Phase 1 footprint of 101 tests all pass; `npm run verify` exits 0.
- `/lists` consumes useTableUrlState + TableToolbar + SortableHeader — proven by 7 new RTL tests covering toolbar render, search, two-direction sort, archived pill toggle (both directions), and skeleton swap; full Phase 1 footprint of 108 tests passes; `npm run verify` exits 0.
- `/jobs` consumes useTableUrlState + TableToolbar + SortableHeader in `mode: 'client'` — proven by 7 new RTL tests covering toolbar render, debounced search → URL, sort URL writes, status pill toggle in both directions, and in-memory filter over the realtime jobs array; the existing Supabase `jobs:list` realtime subscription is byte-identical (the channel block was not touched); full Phase 1 footprint of 115 tests passes; `npm run verify` exits 0.
- `/templates` consumes useTableUrlState + TableToolbar + SortableHeader in `mode: 'client'`, with the existing Base UI category Select preserved as a non-pill filter widget inside the toolbar — proven by 7 new RTL tests covering toolbar render, debounced search → URL, sort URL writes, category Select → URL (both setting and clearing), and in-memory filter over the prefetched templates array; raw `<table>` swapped to shadcn `<Table>` for visual continuity with /properties /lists /jobs; full Phase 1 footprint of 122 tests passes (104 RTL + the templates 7 included); `npm run typecheck` exits 0; `npx vitest run --config vitest.rtl.config.ts` exits 0.
- SearchInputPill, DataTableShell + DataTableFooter, and CircularPagination available under @/components/ui/ for Wave 2 retrofit consumers
- Inner input primitive of TableToolbarSearch now uses the registry's SearchInputPill — the bare shadcn Input + manual lucide Search icon are gone. External call signature unchanged.
- ProspectsTable now accepts `page` + `totalPages` as required props (server-rendered, authoritative), satisfying the Plan 01.5-04 prop contract on top of the wave2-04 visual retrofit that had previously shipped via ancestor commit `04a2c22`.
- Migration 043 drops the city-shaped CHECK constraints on counties.market and properties.market, adds counties.fips_code with a partial unique index, and adds csv_imports.county_id (ON DELETE SET NULL) so the async import worker can recover the chosen county from the persisted job row.
- Migration 044 seeds the counties table with 21 confirmed county rows for the BMH Group org — 18 BMH-active counties (confirmed in the Drive folder) plus 3 additional counties (Cass MO, Wyandotte KS, Riley KS) confirmed by Jarrad at the T-02-02-03 human-verify checkpoint. Each row's `fips_code` is populated via subquery against the static `fips_codes` lookup added in migration 043. The seed is idempotent (ON CONFLICT DO UPDATE) so re-runs correct market labels.
- Eliminated the city-shaped market enum (KNOWN_MARKETS, KnownMarket, WizardMarket) from the codebase. Switched the import wizard, the /properties filter pill, and the /leads/new form to read counties from a server-side fetch, and threaded county_id end-to-end through the async CSV-ingest pipeline so every new property write sets `properties.county_id` alongside `properties.market` (per phase 02 D-04). The createImportJob server action now validates the supplied countyId against the counties table before any persistence (T-02-03-01).
- BEGIN/COMMIT-wrapped migration 046 backfills 1,096 properties.county_id via FIPS JOIN + CASS jsonb; migration 047 fixes the root cause (empty fips_codes table) and re-runs the backfill successfully
- PARTIAL — paused at Task 3 checkpoint (human sign-off required to close Phase 02)

---
