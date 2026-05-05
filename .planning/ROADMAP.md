# Roadmap — Milestone v2.0

**Milestone:** v2.0 — Cross-table UX consistency + market refactor
**Created:** 2026-04-30
**Phases:** 3

---

## Phase 1: Cross-Table UX Consistency

**Goal:** Extract the search/sort/filter pattern from `/properties` into reusable primitives, then apply to `/lists`, `/jobs`, and `/templates` so all CRM index pages share the same toolbar shape and URL-state machine.

**Requirements:** TABLE-01, TABLE-02, TABLE-03, TABLE-04, TABLE-05, TABLE-06, TABLE-07

**Success criteria:**
1. `<TableToolbar>` + `<SortableHeader>` components live in `src/components/ui/` with prop-driven labels and URL-builder injection
2. `/lists`, `/jobs`, `/templates` each render the unified toolbar with at least one search field and all column headers sortable
3. Skeleton loader appears during URL-driven navigation on each of those pages
4. URL params (`?search=`, `?sort=`, `?dir=`, `?page=`) round-trip correctly through pagination + back-button
5. RTL coverage: at least one render-the-toolbar test per page, plus the existing /properties tests still green

**Build order suggestion:**
1. Extract reusable components from `prospects-table.tsx`
2. Migrate `/properties` to use the extracted components (no behavior change; smoke-test)
3. Apply to `/lists` (smallest of the three; surface ground rules)
4. Apply to `/jobs`
5. Apply to `/templates`

**Out of scope (intentionally deferred to Phase 1.5):** Adopting `@sandra/tokens` or registry components (`SearchInputPill`, `DataTableShell`, `CircularPagination`). Phase 1 builds against the existing shadcn primitives so URL-state extraction can ship without bundling a visual overhaul. The new components in `src/components/table/` are designed to swap their inner primitives later without changing call sites.

---

## Phase 1.5: Sandra Design System Retrofit

**Goal:** Adopt `@sandra/tokens` (Layer 1) and the relevant Layer 2 registry components (`SearchInputPill`, `DataTableShell`, `DataTableFooter`, `CircularPagination`) into Sandra CRM. Visual-overhaul-only phase — no behavior change, no new features. Isolates visual regression risk from URL-state work.

**Requirements:** DS-01, DS-02, DS-03, DS-04, DS-05 (added in REQUIREMENTS.md as part of this phase)

**Success criteria:**
1. `package.json` declares `@sandra/tokens` via `file:` reference; `npm install` materializes the symlink
2. `src/app/globals.css` imports `@sandra/tokens/theme.css` and the local `:root { ... }` token block is removed (no competing definitions)
3. `<TableToolbar.Search>` renders `<SearchInputPill>` (replacing the bare `<input>` from Phase 1) — call site signature unchanged
4. Every CRM table (`/properties`, `/lists`, `/jobs`, `/templates`) is wrapped in `<DataTableShell>` + `<DataTableFooter>`; pagination strip uses `<CircularPagination>`
5. Visual verification: Playwright golden paths green; manual screenshot diff against baseline shows only intended token shifts (no layout/spacing regressions on any dashboard route)
6. CI green: typecheck + unit + RTL + Playwright

**Plans:** 5 plans

Plans:
- [x] 01.5-01-PLAN.md — Wire @sandra/tokens (package.json + globals.css import + remove :root block)
- [x] 01.5-02-PLAN.md — Copy 3 registry components into src/components/ui/
- [x] 01.5-03-PLAN.md — Swap TableToolbarSearch inner input to SearchInputPill
- [x] 01.5-04-PLAN.md — DataTableShell + DataTableFooter + CircularPagination on /properties
- [x] 01.5-05-PLAN.md — DataTableShell + DataTableFooter (count-only) on /lists, /jobs, /templates

**Depends on:** Phase 1

---

## Phase 2: Market Vocabulary Refactor

**Goal:** Rename market values from city-shaped (Kansas City, St. Louis, Dayton, Lake of the Ozarks) to county-shaped names matching how BMH actually segments operations. Refactor type + const + validation + UI + existing data.

**Requirements:** MARKET-01, MARKET-02, MARKET-03, MARKET-04, MARKET-05

**Success criteria:**
1. New county-shaped names locked via the SPEC step (with Jarrad's input on the operational mapping)
2. `WizardMarket` type and `KNOWN_MARKETS` const reference the new names
3. Database migration updates `properties.market` 1-to-1 (mapped from old → new); no orphan rows
4. Every UI surface that renders market labels (Wizard dropdown, prospects filter dropdown, lead cards, dashboard cards) shows the new names
5. CI is green: typecheck + unit + RTL + Playwright golden paths

**Plans:** 5 plans

Plans:
**Wave 1**
- [x] 02-01-PLAN.md — Migration 043: drop CHECK constraints on counties.market + properties.market; add counties.fips_code column + partial unique index

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 02-02-PLAN.md — Migration 044: seed BMH Group's counties (18 confirmed + 3 pending Jarrad PR-review confirmation) with fips_code lookup via fips_codes JOIN
- [x] 02-03-PLAN.md — Refactor: eliminate KNOWN_MARKETS + WizardMarket; wire RSC counties fetch through wizard, properties filter, leads/new form; add county_id to csv ingest + leads/create write paths

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 02-04-PLAN.md — Migration 045: backfill properties.county_id + market via fips_code JOIN (~1,149 rows) + cass_raw_response jsonb fallback (~26 rows); leave ~1,358 unresolved rows alone per D-05

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 02-05-PLAN.md — Tests + Playwright smokes (wizard dropdown, properties filter pill) + 045 integration test + post-merge schema_migrations verification on prod + test

---

## Out of Scope (this milestone)

See REQUIREMENTS.md > Out of Scope for the full list and rationale.
