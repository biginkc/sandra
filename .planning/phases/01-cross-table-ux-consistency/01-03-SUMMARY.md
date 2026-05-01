---
phase: 01-cross-table-ux-consistency
plan: "03"
subsystem: ui
tags: [react, nextjs, url-state, migration, regression-gate, properties, rsc-boundary]

requires:
  - "01-01 (parseTableSearch + buildTableHref + useTableUrlState + TableUrlStateContext)"
  - "01-02 (TableToolbar + TableToolbarSearch + SortableHeader)"
provides:
  - "Pure helpers split into use-table-url-state.helpers.ts (server-importable, no 'use client')"
  - "/properties migrated end-to-end onto the Phase 1 primitives — proven via 61 untouched regression tests"
  - "buildProspectsFilterParams export — domain-specific filter URL emitter (stable order: vacant, cass, engagement, market, assignee)"
affects:
  - "01-04 (lists migration) — pattern proven, can begin in parallel"
  - "01-05 (jobs migration) — same"
  - "01-06 (templates migration) — same"
  - "All future cross-table UX consumers — the .helpers split is the canonical pattern for any pure-helper-plus-hook module"

tech-stack:
  added: []
  patterns:
    - "Pure helpers split out of 'use client' modules into companion .helpers files so server components can call them during SSR without hitting Next.js's RSC client-reference boundary"
    - "Domain-specific filter URL emitter (buildProspectsFilterParams) supplied as buildFilterParams config to the generic hook — preserves stable URL ordering as a domain concern"
    - "Thin-wrapper migration pattern: parseProspectsSearch / buildProspectsHref public signatures unchanged, bodies delegate to generic helpers — zero downstream churn"

key-files:
  created:
    - "src/components/table/use-table-url-state.helpers.ts"
  modified:
    - "src/app/(dashboard)/properties/prospects-query.ts"
    - "src/app/(dashboard)/properties/prospects-table.tsx"
    - "src/components/table/use-table-url-state.ts"

key-decisions:
  - "Split pure helpers into use-table-url-state.helpers.ts (no 'use client') so SSR consumers can invoke them without becoming opaque client-references; the hook module re-exports the helpers for client-side back-compat"
  - "buildProspectsFilterParams kept in prospects-query.ts (not in the generic hook) — filter shapes are domain-specific; the generic hook only knows page/search/sort/dir"
  - "Doc comments preserved verbatim across the migration — the explanatory text on engagement, address formatting, sort whitelisting carries operational wisdom that's harder to re-derive than to keep"

patterns-established:
  - "When a 'use client' module exports BOTH a hook AND pure helpers used server-side, split the pure helpers into a sibling .helpers.ts (no directive) and re-export them from the hook module for client back-compat"
  - "Existing tests are the regression contract during a migration — the goal is byte-identical URL output so consumer test files never change"

requirements-completed: ["TABLE-01", "TABLE-02", "TABLE-03", "TABLE-04", "TABLE-05", "TABLE-06", "TABLE-07"]

duration: ~10min
completed: 2026-05-01
---

# Plan 01-03: /properties Migration Onto Phase 1 Primitives

**`/properties` consumes useTableUrlState + TableToolbar + SortableHeader — proven by 61 untouched regression tests (35 prospects-query unit + 26 prospects-table RTL) staying green byte-for-byte; full Phase 1 footprint of 101 tests all pass; `npm run verify` exits 0.**

## Performance

- **Duration:** ~10 min (including the Rule 3 boundary fix)
- **Completed:** 2026-05-01
- **Tasks:** 3
- **Files created:** 1 (use-table-url-state.helpers.ts)
- **Files modified:** 3

## Accomplishments

### Task 1 — prospects-query.ts thin wrapper

`parseProspectsSearch` and `buildProspectsHref` rewritten as thin wrappers around the generic `parseTableSearch` / `buildTableHref` helpers. Public signatures byte-identical; the 35 unit tests pass without modification. New `buildProspectsFilterParams` export bridges the generic hook to the prospects-page filter set, preserving the stable URL order asserted by both the unit suite (test at lines 264-285) and the RTL suite (the "filter toggles compose" assertion expecting `?vacant=1&cass=verified&engagement=contacted`).

### Task 2 — prospects-table.tsx migration

- The URL-state machine (5 functions: `navigate`, `onSearchChange`, `onClearSearch`, `onSortClick`, plus the `searchInput` state + cleanup useEffect) replaced by a single `useTableUrlState` call.
- Toolbar markup (`<div className="border-border bg-card flex flex-wrap...">` + `<Search>` icon + `<Input>` + clear-X button at lines 673-708) replaced by `<TableToolbar><TableToolbarSearch ariaLabel="..." testId="prospects-search">...</TableToolbar>`.
- Inline `SortableHeader` function (lines 859-892) deleted; the two call sites updated to consume the imported generic with `testIdPrefix="prospects"` to preserve `prospects-sort-address` / `prospects-sort-market` testIds.
- `updateFilters` and `clearAllFilters` retained (domain-specific) but now call `ts.navigate` instead of the deleted local `navigate`.

### Task 3 — Phase 1 regression suite

Re-ran the full Phase 1 footprint plus `npm run verify` to certify zero regressions.

## Test Counts

| Suite | Type | Tests | Delta |
|---|---|---:|---:|
| `src/components/table/use-table-url-state.test.ts` | node | 12 | 0 |
| `src/components/table/use-table-url-state.hook.test.tsx` | RTL | 11 | 0 |
| `src/components/table/table-toolbar.test.tsx` | RTL | 11 | 0 |
| `src/components/table/sortable-header.test.tsx` | RTL | 6 | 0 |
| `src/app/(dashboard)/properties/prospects-query.test.ts` | node | 35 | 0 |
| `src/app/(dashboard)/properties/prospects-table.test.tsx` | RTL | 26 | 0 |
| **Phase 1 footprint** |  | **101** | **0** |
| Full repo `npm run verify` (typecheck + 478 unit + 83 RTL) | mixed | 561 | 0 |

Zero tests modified. Zero tests added. The plan's contract — that the existing 61 prospects tests would survive byte-identically — held.

## Line-Count Deltas

| File | Before | After | Delta |
|---|---:|---:|---:|
| `src/app/(dashboard)/properties/prospects-table.tsx` | 1,258 | 1,181 | **−77** |
| `src/app/(dashboard)/properties/prospects-query.ts` | 226 | 276 | +50 |
| `src/components/table/use-table-url-state.ts` | 257 | 204 | −53 |
| `src/components/table/use-table-url-state.helpers.ts` | (new) | 95 | +95 |
| **Total** | **1,741** | **1,756** | **+15** |

The plan estimated >100 lines deleted from prospects-table.tsx; actual is −77. The shortfall is real but explainable: the file's line budget is dominated by the bulk-action `<DropdownMenu>` JSX (lines 478-664 in the original — 187 lines of menu structure that's domain-specific and out of scope). The URL-state + toolbar + SortableHeader together accounted for ~120 deleted lines, partially offset by ~40 added lines for the new hook setup + `<TableToolbar>` JSX + import block.

prospects-query.ts grew (+50 lines) rather than shrunk because the doc comments were preserved verbatim — the explanatory commentary on engagement rules, address formatting, and the new RSC boundary rationale carry operational context worth keeping. Logic-line count actually shrank: ~85 lines of branching/parsing logic became a 12-line wrapper + 21-line `parseProspectsFilters` helper (the rest is comments + types).

## Decisions Made

- **Split pure helpers out of the 'use client' module.** A 'use client' file's exports become opaque client-references when imported server-side — invoking them during SSR throws. The pure `parseTableSearch` / `buildTableHref` had to be importable by `prospects-query.ts` (a server-importable module called from `page.tsx`). Solution: new `use-table-url-state.helpers.ts` (no directive) hosts the pure functions; the hook module re-exports them for client back-compat.
- **buildProspectsFilterParams stays domain-specific.** The generic hook's `buildFilterParams` callback is the contract; the prospects emitter knows the five filter keys + their stable order. Pushing this into the generic hook would couple it to every consumer's filter shape.
- **Doc comments preserved verbatim during the wrapper rewrite.** Future readers won't have to re-derive why CASS is whitelisted, why search trims, why the assignee `unassigned` sentinel exists, etc.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Split pure helpers into a non-'use client' module**

- **Found during:** Task 2 verification (orchestrator surfaced an SSR runtime crash on `/properties` after Task 1 landed)
- **Issue:** Plan 01-01 placed `parseTableSearch` + `buildTableHref` in `use-table-url-state.ts` alongside the React hook, marked `"use client"` for the hook's sake. The 12 unit tests passed because they imported the helpers directly via Vitest (no RSC compiler). When Plan 01-03 Task 1 introduced a real cross-module import path (`prospects-query.ts` → `use-table-url-state.ts`) that gets exercised on the SSR path (`page.tsx` calls `parseProspectsSearch` server-side, which calls `parseTableSearch`), Next.js surfaced the helper as an opaque client-reference and crashed when the server tried to invoke it. The original Plan 01 doc comment claiming "Next.js's RSC compiler tree-shakes correctly" was incorrect — `'use client'` is a module-graph boundary, not a per-export attribute.
- **Fix:** Created `src/components/table/use-table-url-state.helpers.ts` (no `'use client'` directive) with `parseTableSearch`, `buildTableHref`, and their type exports. `use-table-url-state.ts` now imports + re-exports them so existing client-side imports from the original path keep working unchanged. `prospects-query.ts` imports directly from `./use-table-url-state.helpers` to stay outside the client boundary.
- **Files modified:** `src/components/table/use-table-url-state.ts` (slimmed to hook + context + re-export barrel); `src/components/table/use-table-url-state.helpers.ts` (new); `src/app/(dashboard)/properties/prospects-query.ts` (import path change).
- **Commit:** `0a0503b` (rolled into the Task 2 commit since the boundary issue blocked Task 2's verification)
- **Verification:** `npx tsc --noEmit` exits 0; the 12 unit tests for `parseTableSearch`/`buildTableHref` still resolve (they import from the barrel); the 11 hook RTL tests still resolve; the 26 prospects-table RTL tests still pass.

This deviation is also a **patterns-established** entry: any future Phase 1 / 1.5 / 2 work that adds new pure helpers alongside hooks should put the pure helpers in a sibling `.helpers.ts` module from the start.

### Pre-existing warnings (out of scope)

The bulk-add-to-list test in `prospects-table.test.tsx` emits two `act(...)` warnings for Base UI's `MenuRoot` / `MenuSubmenuTrigger` portal updates. These pre-date this plan (they fired in the Plan 01-02 SUMMARY's verify run too). Out of scope per the deviation rules' scope boundary.

## Issues Encountered

The Rule 3 deviation was the only blocker. Once the helper-split was in place, the rest of Task 2 + Task 3 ran cleanly.

## TDD Gate Compliance

Both Task 1 and Task 2 were marked `tdd="true"` in the plan, but the contract was unconventional: the existing 35 + 26 = 61 prospects tests were the contract — they already existed and currently passed against the pre-migration code. The TDD shape was therefore "tests pre-exist, refactor the implementation, tests still pass byte-identically" rather than the canonical RED → GREEN → REFACTOR cycle. No new test commits were warranted; the plan's done-criteria explicitly say "zero new tests — the existing tests ARE the contract."

For traceability in the gate audit:
- Task 1 commit `407d6b2` (refactor) — 35 prospects-query tests stayed green.
- Task 2 commit `0a0503b` (refactor) — 26 prospects-table tests stayed green.
- Task 3 — diagnostic only, no new commits beyond verification.

## Next Phase Readiness

- **Plan 01-04 (`/lists`)** can now import:
  - `useTableUrlState`, `TableToolbar`, `TableToolbarSearch`, `TableToolbarFilterPill`, `SortableHeader`
  - `parseTableSearch`, `buildTableHref` from `@/components/table/use-table-url-state.helpers` for any server-side query module (or from the barrel for client-only modules)
- **Plan 01-05 (`/jobs`)** — same imports.
- **Plan 01-06 (`/templates`)** — same imports; if `/templates` is a fully client-side page (the plan flagged it as `mode: "client"` in its design), it can use the original barrel without crossing the SSR boundary.
- The `.helpers.ts` split establishes the canonical pattern for any future "pure helpers + React hook" module pair in this repo.

## Self-Check

- [x] `src/components/table/use-table-url-state.helpers.ts` exists (95 lines, no 'use client')
- [x] `src/components/table/use-table-url-state.ts` exists (204 lines, 'use client', re-exports helpers)
- [x] `src/app/(dashboard)/properties/prospects-query.ts` exists (276 lines, imports from `.helpers`)
- [x] `src/app/(dashboard)/properties/prospects-table.tsx` exists (1,181 lines, imports useTableUrlState + TableToolbar + SortableHeader; no inline SortableHeader function)
- [x] Commit `407d6b2` (Task 1) exists in git log
- [x] Commit `0a0503b` (Task 2 + Rule 3 fix) exists in git log
- [x] `npm run verify` exits 0 (typecheck + 478 unit + 83 RTL)
- [x] `grep -c "function SortableHeader" src/app/(dashboard)/properties/prospects-table.tsx` returns 0
- [x] All 35 prospects-query.test.ts tests pass unchanged
- [x] All 26 prospects-table.test.tsx tests pass unchanged

## Self-Check: PASSED

---
*Phase: 01-cross-table-ux-consistency*
*Completed: 2026-05-01*
