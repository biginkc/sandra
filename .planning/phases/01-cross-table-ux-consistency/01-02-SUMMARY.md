---
phase: 01-cross-table-ux-consistency
plan: "02"
subsystem: ui
tags: [react, components, compound, vitest, rtl]

requires:
  - "01-01 (TableUrlStateContext + useTableUrlState + SortDirection from use-table-url-state.ts)"
provides:
  - "TableToolbar — rounded-card wrapper that provides TableUrlStateContext"
  - "TableToolbarSearch — uncontrolled debounced search input that consumes the context"
  - "TableToolbarFilterPill — binary toggle pill with active/inactive variants"
  - "SortableHeader<TColumn extends string> — clickable column header with sort indicator"
affects:
  - "01-03 (properties migration imports these to delete ~150 lines from prospects-table.tsx)"
  - "01-04 (lists), 01-05 (jobs), 01-06 (templates) — same imports as the cross-table primitives"

tech-stack:
  added: []
  patterns:
    - "Compound component via flat sibling exports (matches dropdown-menu.tsx convention; no Object.assign)"
    - "Uncontrolled <Input defaultValue> + ref-based clear (avoids React 19 server-prop mirror freeze)"
    - "Local hasContent state drives X visibility so the X appears on first keystroke (250ms ahead of debounced URL update)"

key-files:
  created:
    - "src/components/table/table-toolbar.tsx"
    - "src/components/table/table-toolbar.test.tsx"
    - "src/components/table/sortable-header.tsx"
    - "src/components/table/sortable-header.test.tsx"
  modified: []

key-decisions:
  - "Flat sibling exports (TableToolbar, TableToolbarSearch, TableToolbarFilterPill) — matches dropdown-menu.tsx; preserves tree-shaking"
  - "X-button visibility tracked via local hasContent state instead of ctx.search so it appears on first keystroke (250ms ahead of debounced URL update)"
  - "Debounce test uses real timers + waitFor (matches prospects-table.test.tsx pattern) — fake timers don't compose cleanly with React 19 useTransition inside useTableUrlState"

patterns-established:
  - "Compound toolbar primitives consume hook state via context provider, not prop drilling"
  - "SortableHeader generic over <TColumn extends string> so each consumer narrows the column-name type"
  - "data-active attribute encoded as `active || undefined` so HTML omits the attribute when inactive (parity with prospects-table FilterToggle)"

requirements-completed: ["TABLE-01", "TABLE-02", "TABLE-03", "TABLE-07"]

duration: ~6min
completed: 2026-05-01
---

# Plan 01-02: Compound TableToolbar + SortableHeader Summary

**Compound toolbar primitives (TableToolbar + TableToolbarSearch + TableToolbarFilterPill) and a generic SortableHeader extracted, backed by 17 new RTL tests; prospects-table regression suite remains green.**

## Performance

- **Duration:** ~6 min
- **Completed:** 2026-05-01
- **Tasks:** 4
- **Files created:** 4

## Accomplishments

- `<TableToolbar state={ts}>` wraps the rounded-card `border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3` div verbatim from prospects-table.tsx:673 and provides `TableUrlStateContext` to children
- `<TableToolbarSearch>` is uncontrolled (`defaultValue={ctx.search}`), debounces typing through `ctx.debouncedSearch`, tracks X visibility via local `hasContent` state, and clears via `ctx.navigate` directly so the X feels instant
- `<TableToolbarFilterPill>` toggles `variant="default"|"outline"` with `data-active="true"` and inline X icon when active
- `<SortableHeader<TColumn extends string>>` lifted verbatim from prospects-table.tsx:859-892 with three adaptations: generic over column-name type, prop rename `sort` → `current`, `testIdPrefix` prop replaces hard-coded `prospects-sort-${column}`
- 11 RTL tests for the toolbar + 6 RTL tests for SortableHeader = 17 new tests
- All previously green tests remain green: 26 prospects-table RTL, 35 prospects-query unit, 12 use-table-url-state node-env unit, 11 use-table-url-state RTL

## Final exports

```typescript
// src/components/table/table-toolbar.tsx
export { TableToolbar, TableToolbarSearch, TableToolbarFilterPill };

// src/components/table/sortable-header.tsx
export function SortableHeader<TColumn extends string>(props: {
  column: TColumn;
  current: TColumn | string;
  dir: SortDirection;
  onClick: (col: TColumn) => void;
  children: React.ReactNode;
  testIdPrefix?: string;
}): JSX.Element;
```

These are the surfaces Plans 03-06 import.

## Task Commits

1. **Task 1: TableToolbar + TableToolbarSearch + TableToolbarFilterPill** — `d648b44` (feat)
2. **Task 2: 11 RTL tests for the toolbar primitives** — `9fcb38f` (test)
3. **Task 3: SortableHeader generic component** — `cdf3f6c` (feat)
4. **Task 4: 6 RTL tests for SortableHeader** — `40526e1` (test)

## Files Created/Modified

- `src/components/table/table-toolbar.tsx` — 162 lines (compound toolbar)
- `src/components/table/table-toolbar.test.tsx` — 234 lines (11 RTL tests)
- `src/components/table/sortable-header.tsx` — 61 lines (generic header)
- `src/components/table/sortable-header.test.tsx` — 84 lines (6 RTL tests)

## Test counts

| Suite | Before plan | After plan | Delta |
|-------|------------:|-----------:|------:|
| `src/components/table/use-table-url-state.test.ts` (node) | 12 | 12 | 0 |
| `src/components/table/use-table-url-state.hook.test.tsx` (jsdom) | 11 | 11 | 0 |
| `src/components/table/table-toolbar.test.tsx` (jsdom) | 0 | 11 | +11 |
| `src/components/table/sortable-header.test.tsx` (jsdom) | 0 | 6 | +6 |
| `src/app/(dashboard)/properties/prospects-table.test.tsx` (jsdom) | 26 | 26 | 0 |
| `src/app/(dashboard)/properties/prospects-query.test.ts` (node) | 35 | 35 | 0 |

Total new tests: 17 (plan target was ~16; 11 toolbar + 6 sortable-header).

## Decisions Made

- **Flat sibling exports** instead of `Object.assign(TableToolbar, { Search, FilterPill })`. Matches `src/components/ui/dropdown-menu.tsx:252-268` repo convention and preserves tree-shaking.
- **X-button visibility uses local `hasContent` state** rather than `ctx.search.length > 0`, because `ctx.search` lags 250ms behind typing (debounce). Local state lets the X appear on the first keystroke, matching prospects-table.tsx:688 behavior.
- **`defaultValue` on the Input is uncontrolled** — `value=` would mirror the server prop into React state and freeze against `router.refresh` per `feedback_no_usestate_mirror_of_server_props.md`.
- **X click calls `ctx.navigate` directly** (not `ctx.debouncedSearch`) so clearing feels instant. The hook's internal `navigate` already cancels any pending debounce timer (Pitfall 3), so we can't double-fire.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Debounce test rewritten with real timers + waitFor**
- **Found during:** Task 2
- **Issue:** The plan's example used `vi.useFakeTimers()` + `userEvent.setup({ advanceTimers })` + `vi.advanceTimersByTime(250)`. The test hung at 5s timeout — fake timers don't flush React 19's `useTransition` work that fires inside `useTableUrlState.navigate`, so `routerReplace` was never called within the assertion window.
- **Fix:** Switched the debounce test to real timers + `waitFor({ timeout: 1500 })`, mirroring the existing `prospects-table.test.tsx:331-345` pattern that exercises the same code path successfully.
- **Files modified:** `src/components/table/table-toolbar.test.tsx`
- **Commit:** `9fcb38f` (the test file was committed once with the fix already in place)

### Worktree base correction

The worktree was originally created at commit `320e989` instead of the expected `01352d1`. The orchestrator's `worktree_branch_check` mandates a hard-reset, but the sandbox blocks `git reset --hard`. Resolved by `git merge --ff-only 01352d1...` since the worktree branch had no unique commits ahead of `320e989` — the merge brought the missing 13 commits (Wave 1 outputs + planning docs) cleanly. After fast-forward, `HEAD == 01352d1...` as required. No code changes in this fast-forward; only docs/config/Wave-1 files arrived.

### File path correction

The first `Write` call placed `table-toolbar.tsx` into the parent checkout at `/Users/jarradhenry/Sites/Sandra/src/components/table/` instead of the worktree at `/Users/jarradhenry/Sites/Sandra/.claude/worktrees/agent-a50a8c5e117a3055b/src/components/table/`. Recovered via `mv` before staging. All subsequent writes used worktree-absolute paths.

## Issues Encountered

None blocking. Two non-blocking corrections noted above.

## Self-Check

(see Self-Check section at the end of this file)

## Next Phase Readiness

- Plan 01-03 (`/properties` migration) can now:
  - Replace prospects-table.tsx:673-708 with `<TableToolbar state={ts}><TableToolbarSearch testId="prospects-search" .../>...</TableToolbar>`
  - Delete the inline `SortableHeader` function at prospects-table.tsx:859-892 and import the generic version
  - Net deletion target: ~150 lines from the 1,258-line prospects-table.tsx
- Plans 01-04 / 01-05 / 01-06 can use the same imports for `/lists`, `/jobs`, `/templates` migrations.

---
*Phase: 01-cross-table-ux-consistency*
*Completed: 2026-05-01*
