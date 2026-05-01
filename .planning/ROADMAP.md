# Roadmap — Milestone v2.0

**Milestone:** v2.0 — Cross-table UX consistency + market refactor
**Created:** 2026-04-30
**Phases:** 2

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

**Build order suggestion:**
1. SPEC step: capture old → new mapping table (Jarrad's call)
2. Add new market enum values + migration; keep old values valid temporarily
3. Update all code references (type, const, validation, UI)
4. Run migration to update existing prod rows
5. Drop old enum values (cleanup migration)

---

## Out of Scope (this milestone)

See REQUIREMENTS.md > Out of Scope for the full list and rationale.
