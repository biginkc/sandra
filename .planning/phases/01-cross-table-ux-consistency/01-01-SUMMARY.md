---
phase: 01-cross-table-ux-consistency
plan: "01"
subsystem: ui
tags: [react, nextjs, url-state, hooks, vitest, rtl]

requires: []
provides:
  - "parseTableSearch(searchParams) — pure URL → TableSearch object parser"
  - "buildTableHref(base, state) — pure TableSearch → URL string builder"
  - "useTableUrlState(opts) — React hook managing sort/search URL state via router"
  - "TableUrlStateContext — context provider exposing state to toolbar children"
affects:
  - "01-02 (TableToolbar/SortableHeader consume TableUrlStateContext)"
  - "01-03 (properties migration uses hook + helpers)"
  - "01-04, 01-05, 01-06 (lists/jobs/templates migrations)"

tech-stack:
  added: []
  patterns:
    - "URL-state machine co-located with React hook (useTableUrlState)"
    - "Pure helper functions decoupled from React (parseTableSearch, buildTableHref)"
    - "Context provider pattern for passing URL state to compound toolbar children"

key-files:
  created:
    - "src/components/table/use-table-url-state.ts"
    - "src/components/table/use-table-url-state.test.ts"
    - "src/components/table/use-table-url-state.hook.test.tsx"
  modified:
    - ".planning/phases/01-cross-table-ux-consistency/01-VALIDATION.md"

key-decisions:
  - "Pure helpers (parseTableSearch, buildTableHref) separated from hook to allow server-side use in Wave 3+"
  - "TableUrlStateContext exported from same file so Wave 2 toolbar imports one module"
  - "mode option ('ssr' | 'client') designed into hook API upfront for Wave 4 /templates migration"

patterns-established:
  - "URL-state pattern: server reads searchParams → parseTableSearch; client mutates via buildTableHref + router.push"
  - "All table URL primitives live under src/components/table/"

requirements-completed: ["TABLE-04", "TABLE-05", "TABLE-06", "TABLE-07"]

duration: 6min
completed: 2026-05-01
---

# Plan 01-01: useTableUrlState Hook Extraction Summary

**Shared URL-state foundation extracted: `parseTableSearch` + `buildTableHref` pure helpers and `useTableUrlState` hook with `TableUrlStateContext`, backed by 23 tests (12 unit + 11 RTL)**

## Performance

- **Duration:** ~6 min
- **Completed:** 2026-05-01
- **Tasks:** 4 (+ VALIDATION.md update)
- **Files created:** 3

## Accomplishments
- `parseTableSearch` and `buildTableHref` pure functions extracted — no React dependency, usable server-side
- `useTableUrlState` hook wraps router interaction, exposes `TableUrlStateContext` for compound children
- 12 node-env unit tests covering parse/build round-trips and edge cases
- 11 jsdom RTL tests covering hook initialization, sort toggling, search update, and context consumption

## Task Commits

1. **Task 1: parseTableSearch + buildTableHref** — `875a969` (feat)
2. **Task 2: unit tests (12 cases)** — `fba25c6` (test)
3. **Task 3: useTableUrlState hook + TableUrlStateContext** — `9948e9e` (feat)
4. **Task 4: RTL hook tests (11 cases)** — `8ba454f` (test)

## Files Created/Modified
- `src/components/table/use-table-url-state.ts` — Hook, context, and pure helpers (257 lines)
- `src/components/table/use-table-url-state.test.ts` — Node-env unit tests (121 lines)
- `src/components/table/use-table-url-state.hook.test.tsx` — RTL jsdom tests (223 lines)
- `.planning/phases/01-cross-table-ux-consistency/01-VALIDATION.md` — Validation map updated

## Decisions Made
- Pure helpers kept decoupled from React so Wave 3's server component can call `parseTableSearch` directly without a hook
- `mode: 'ssr' | 'client'` baked into hook signature now so Wave 4 migrations don't need API changes

## Deviations from Plan
None — plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- Wave 2 (01-02) can now import `TableUrlStateContext` from `use-table-url-state.ts` to wire `<TableToolbarSearch>`
- Wave 3 (01-03) can call `parseTableSearch` server-side in the properties page server component

---
*Phase: 01-cross-table-ux-consistency*
*Completed: 2026-05-01*
