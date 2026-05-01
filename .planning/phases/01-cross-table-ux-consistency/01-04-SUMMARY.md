---
phase: 01-cross-table-ux-consistency
plan: "04"
subsystem: ui
tags: [react, nextjs, url-state, migration, lists, greenfield]

requires:
  - "01-01 (parseTableSearch + buildTableHref + useTableUrlState + ParsedTableSearch)"
  - "01-02 (TableToolbar + TableToolbarSearch + TableToolbarFilterPill + SortableHeader)"
  - "01-03 (use-table-url-state.helpers.ts split for SSR-safe pure helper imports)"
provides:
  - "/lists migrated end-to-end onto the Phase 1 primitives"
  - "Unified rounded-card toolbar with search + 'Show archived' filter pill (replaces the old two-section active/archived layout)"
  - "URL-driven sort/search/filter/pagination — round-trips via back-button + refresh"
  - "ListsTable client island as a reference shape for /jobs (01-05) and /templates (01-06)"
affects:
  - "01-05 (jobs migration) — same imports, same pattern"
  - "01-06 (templates migration) — same imports; mode: 'client' if it stays client-only"

tech-stack:
  added: []
  patterns:
    - "Server-component page.tsx awaits searchParams + parses via parseTableSearch from .helpers (RSC-safe per Plan 01-03)"
    - "Client island consumes useTableUrlState({ mode: 'ssr' }) + drilled `parsed` so the toolbar's defaultValue, the active-sort indicator, and the archived pill all read from the URL on every SSR render"
    - "JS-side sort for joined-count columns (members) when no SQL ordinal is available — sorts within the page only, acceptable for typical < 100 lists per org"
    - "System-managed pinning preserved via secondary order chain (.order('system_managed', { ascending: false }) before user sort) — invariant survives every URL-driven sort change"
    - "Stable id tie-breaker on every non-members sort prevents pagination skip/repeat (Pitfall 7)"

key-files:
  created:
    - "src/app/(dashboard)/lists/lists-table.tsx (250 lines — client island)"
    - "src/app/(dashboard)/lists/lists-table.test.tsx (170 lines — 7 RTL tests)"
  modified:
    - "src/app/(dashboard)/lists/page.tsx (191 lines → 219 lines; deleted 99-line inline ListTable; replaced two-section active/archived layout with URL-driven pill)"

key-decisions:
  - "Default sort flipped from 'created_at desc' (implicit, no client controls) to 'name asc' (the OLD page already sorted by name asc in the DB — making it the explicit URL default keeps /lists with no params byte-identical to the pre-migration order)"
  - "Members sort handled in JS, not SQL: Supabase JS doesn't support .order() on a JOIN-derived count without an RPC; sorting after the page fetch is acceptable per RESEARCH line 678 (typical < 100 lists per org)"
  - "Members column kept default text-alignment instead of right-aligned: the SortableHeader's leading-edge click affordance reads better text-left; right-aligned numbers can return as a column-class tweak if product wants it"
  - "Archived pill text shifts: 'Show archived' (inactive) → 'Showing archived' (active) — telegraphs both action and current state in one label"
  - "page.tsx imports parseTableSearch + buildTableHref from `@/components/table/use-table-url-state.helpers` (NOT from the hook module) per Plan 01-03's RSC boundary fix — server components must stay outside the 'use client' barrier"

patterns-established:
  - "Greenfield migration template: server page.tsx (parses + fetches) + new client island ({entity}-table.tsx that consumes the hook) + RTL test file ({entity}-table.test.tsx that mocks next/navigation + the row-actions module). Plans 01-05 (/jobs) and 01-06 (/templates) follow this exact shape."
  - "When a sortable column maps to a JOIN-derived count (no SQL ordinal), order by a stable column in the DB and re-sort in JS after the count join — preserves the system-managed pin via stable-sort"

requirements-completed: ["TABLE-01", "TABLE-02", "TABLE-03", "TABLE-04", "TABLE-05", "TABLE-06"]

duration: ~8min
completed: 2026-05-01
---

# Plan 01-04: /lists Migration Onto Phase 1 Primitives

**`/lists` consumes useTableUrlState + TableToolbar + SortableHeader — proven by 7 new RTL tests covering toolbar render, search, two-direction sort, archived pill toggle (both directions), and skeleton swap; full Phase 1 footprint of 108 tests passes; `npm run verify` exits 0.**

## Performance

- **Duration:** ~8 min
- **Completed:** 2026-05-01
- **Tasks:** 3 (all autonomous, all committed atomically)
- **Files created:** 2 (lists-table.tsx + lists-table.test.tsx)
- **Files modified:** 1 (page.tsx)

## Accomplishments

### Task 1 — page.tsx server-component rewrite

`/lists/page.tsx` rewritten as a server component awaiting `searchParams`. The OLD inline `function ListTable` (lines 99-190) was deleted entirely; the OLD active/archived two-section layout (lines 76-94) collapsed into a single Supabase query gated by `?archived=1`. Default sort: `name asc` (the explicit URL form of the OLD page's implicit DB sort). The pure helpers (`parseTableSearch`, `buildTableHref`) imported from `@/components/table/use-table-url-state.helpers` per Plan 01-03's RSC-safe split — importing from the hook module would have crashed SSR exactly like /properties did before that fix.

System-managed pinning preserved via primary `.order("system_managed", { ascending: false })` before the user-chosen sort; stable id tie-breaker on every non-members sort. The `members` case (joined property_lists count, no SQL ordinal) orders by name in the DB and re-sorts the page in JS after joining the counts.

### Task 2 — lists-table.tsx client island

New 250-line `ListsTable` client island consuming `useTableUrlState<ListsFilters>({ mode: 'ssr' })`. The toolbar wraps a `<TableToolbarSearch>` (placeholder "Search lists…", testId `lists-search`) and a `<TableToolbarFilterPill>` (testId `lists-filter-archived`, label flips between "Show archived" / "Showing archived"). Three sortable columns (Name / Members / Created) render via the generic `<SortableHeader<ListsSortableColumn>>` with `testIdPrefix="lists"` so test ids resolve to `lists-sort-{column}`. Description is a plain `TableHead`. Skeleton row swap on `ts.navPending` (matches prospects-table convention; minimum 5 rows so the table doesn't snap-resize). Empty state branches three-ways: search-no-results, archived-no-results, fresh-empty.

Row markup (Name color badge, System badge, description, member count, relative-time created, ListRowActions) ported verbatim from the deleted inline ListTable.

### Task 3 — RTL tests (7 cases)

`lists-table.test.tsx` mocks `next/navigation`, `./list-row-actions`, and `sonner` (the row-actions stub mirrors the pattern used to keep server-action modules out of jsdom). Seven tests cover: toolbar render, debounced search → URL, default-column sort flip (asc → desc → URL emits only `?dir=desc` because `sort=name` matches the default), non-default-column sort (`?sort=members`, `dir=asc` stripped), archived pill toggle in both directions (`/lists?archived=1` and back to bare `/lists`), and skeleton-row engagement during the 150ms `forceSkeleton` floor.

## Test Counts

| Suite | Type | Tests | Delta |
|---|---|---:|---:|
| `src/app/(dashboard)/lists/lists-table.test.tsx` | RTL | 7 | **+7** |
| `src/components/table/use-table-url-state.test.ts` | node | 12 | 0 |
| `src/components/table/use-table-url-state.hook.test.tsx` | RTL | 11 | 0 |
| `src/components/table/table-toolbar.test.tsx` | RTL | 11 | 0 |
| `src/components/table/sortable-header.test.tsx` | RTL | 6 | 0 |
| `src/app/(dashboard)/properties/prospects-query.test.ts` | node | 35 | 0 |
| `src/app/(dashboard)/properties/prospects-table.test.tsx` | RTL | 26 | 0 |
| **Phase 1 footprint** |  | **108** | **+7** |
| Full repo `npm run verify` (typecheck + 478 unit + 90 RTL) | mixed | 568 | +7 |

Zero existing tests modified. Zero regressions.

## Line-Count Deltas

| File | Before | After | Delta |
|---|---:|---:|---:|
| `src/app/(dashboard)/lists/page.tsx` | 191 | 219 | +28 |
| `src/app/(dashboard)/lists/lists-table.tsx` | (new) | 250 | +250 |
| `src/app/(dashboard)/lists/lists-table.test.tsx` | (new) | 170 | +170 |
| **Total** | **191** | **639** | **+448** |

The page.tsx growth (+28 lines) is from the new pagination link block + the Supabase query branching for the archived/members cases — net of the 99-line inline ListTable delete. Without the new pagination block, page.tsx would actually be net negative.

## Task Commits

1. **Task 1: page.tsx rewrite** — `a38233c` (refactor)
2. **Task 2: lists-table.tsx client island** — `6ab16e2` (feat)
3. **Task 3: 7 RTL tests** — `36a3af1` (test)

## URL Surface

| Param | Domain | Effect |
|---|---|---|
| `?search=foo` | non-empty string | server-side `ilike('name', '%foo%')` |
| `?sort=name\|members\|created_at` | whitelist via parseTableSearch | sets primary sort (members → JS post-fetch) |
| `?dir=asc\|desc` | enum | flips the active sort; default `asc`, stripped from URL |
| `?archived=1\|true` | boolean | switches to archived-only query (`not('archived_at', 'is', null)`) |
| `?page=2` | positive int | offset pagination (PAGE_SIZE = 50); preserves search/sort/dir/archived |

All round-trip via back-button + refresh + pagination links.

## Decisions Made

- **Default sort flipped to `name asc`.** The OLD page used `.order('name', { ascending: true })` in the DB without exposing it. Making `name asc` the explicit URL default keeps `/lists` (no params) byte-identical to the pre-migration display order — and lets `buildTableHref` strip both `sort=name` and `dir=asc` from URLs, keeping them clean.
- **Members sorted in JS, not SQL.** Supabase JS can't `.order()` on a JOIN-derived count without an RPC. Sorting in JS after the page fetch trades cross-page sort accuracy for query simplicity; per RESEARCH line 678, orgs typically have < 100 lists, so within-page sort is acceptable.
- **Members column kept default text-alignment.** SortableHeader's clickable affordance reads better leading-edge. Switching to right-aligned numbers can come back as a column-class tweak if product flags it.
- **Archived pill label transitions both action + state.** "Show archived" (inactive) → "Showing archived" (active) — single label tells the user what they'll do AND what they're currently seeing. Cheaper than a separate filled badge or status pill.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Imported pure helpers from `.helpers` not the hook module**
- **Found during:** Task 1 (during initial file read)
- **Issue:** The plan's `<interfaces>` block (line 98) shows `import { parseTableSearch } from "@/components/table/use-table-url-state"` — but Plan 01-03 SUMMARY documents that the SSR/RSC boundary requires server components to import the pure helpers from `@/components/table/use-table-url-state.helpers` (no 'use client' directive). Importing from the hook module would crash SSR exactly like `/properties` did before the helper-split fix. The orchestrator's prompt called this out explicitly.
- **Fix:** page.tsx imports `parseTableSearch`, `buildTableHref`, `SortDirection` from `@/components/table/use-table-url-state.helpers`. The client island (lists-table.tsx) imports the hook + types from `@/components/table/use-table-url-state` (the 'use client' module) since it's a client component already.
- **Files modified:** `src/app/(dashboard)/lists/page.tsx`
- **Commit:** `a38233c` (rolled into Task 1 since it was a precondition for the file to compile)

**2. [Rule 1 - Bug] Test assertion for Members sort URL corrected**
- **Found during:** Task 3 (during test design, before writing the file)
- **Issue:** The plan's example test (line 759-765) asserted `/lists?sort=members&dir=asc` after clicking the Members header from default state (sort=name, dir=asc). Tracing through `buildTableHref`: `dir="asc" === defaultDir "asc"` → omitted. Actual URL is `/lists?sort=members`.
- **Fix:** Test 4 in `lists-table.test.tsx` asserts `/lists?sort=members` (the actual hook output) and includes a comment explaining the default-stripping behavior.
- **Files modified:** `src/app/(dashboard)/lists/lists-table.test.tsx`
- **Commit:** `36a3af1` (the corrected assertion was committed with the test file)

**3. [Rule 3 - Blocking] Search debounce + skeleton tests rewritten with real timers**
- **Found during:** Task 3 (preempted from Plan 01-02 SUMMARY's documented hang)
- **Issue:** The plan's example used `vi.useFakeTimers()` + `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` + `vi.advanceTimersByTime(250)` for the search debounce test. Plan 01-02 SUMMARY documents that this pattern hangs at 5s timeout because fake timers don't flush React 19's `useTransition` work that fires inside `useTableUrlState.navigate`, so `routerReplace` is never called.
- **Fix:** Search debounce test uses real timers + `waitFor({ timeout: 1500 })` matching `prospects-table.test.tsx:331-345` pattern. Skeleton test uses real timers + `act` wrapping the click + a synchronous assertion (the 150ms forceSkeleton floor leaves enough headroom for the assertion to run before timers expire). All 7 tests passed on first run.
- **Files modified:** `src/app/(dashboard)/lists/lists-table.test.tsx`
- **Commit:** `36a3af1`

### UX deviation flagged in plan

The plan's `<output>` block asks for explicit confirmation if product wants the active/archived sections back instead of the pill (CONTEXT/RESEARCH A7 — highest-risk assumption). **The pill ships as planned.** Rationale (per RESEARCH line 657-661 + the deviation docs in PATTERNS):
- The single Supabase query is cheaper than two parallel queries.
- The pill telegraphs the current filter state in a single label that doubles as the toggle.
- Pagination + sort + search compose with the archived state via one URL surface; two stacked sections would have required separate pagination per section.

If product flags this as a regression vs the OLD layout, we can restore the two-section view by removing the pill, splitting the query, and rendering two `<ListsTable>` instances. That work is bounded and can ship in a fast-follow plan.

### Pre-existing warnings (out of scope)

The bulk-add-to-list test in `prospects-table.test.tsx` continues to emit two `act(...)` warnings for Base UI's `MenuRoot` / `MenuSubmenuTrigger` portal updates. Pre-existing; documented in Plan 01-03 SUMMARY. Out of scope per the deviation rules' scope boundary.

## TDD Gate Compliance

All three tasks were marked `tdd="true"` in the plan. Plan 03 documented an unconventional contract for migrations: tests are the regression contract for byte-identical behavior. Plan 04 differs — it's a **greenfield** migration (`/lists` had no prior tests). The TDD shape was therefore "write tests for the NEW client island, lock in behavior, then ship."

For traceability:
- **Task 1** (`a38233c`, refactor) — page.tsx rewritten. No new tests because the server component's behavior is exercised end-to-end through the client island's URL assertions in Task 3.
- **Task 2** (`6ab16e2`, feat) — client island shipped. No tests until Task 3 (the plan deliberately staged tests last so Task 3 could write against a stable surface).
- **Task 3** (`36a3af1`, test) — 7 RTL tests added (RED phase: not strictly RED-first since the implementation existed; GREEN phase: all 7 passed on first run, locking in current behavior).

The plan-level gate sequence (`feat` → `test`) holds in spirit even though the conventional RED-first ordering wasn't observed; the deviation rules treat this as acceptable for cross-component migrations where the unit-of-RED is the URL contract, not a single function.

## Issues Encountered

None blocking. The three Rule 1/3 deviations above were anticipated from prior-wave summaries (01-02 + 01-03) — the orchestrator's prompt explicitly flagged the helpers-import correction. No checkpoints triggered. No auth gates.

## Self-Check

- [x] `src/app/(dashboard)/lists/page.tsx` exists (219 lines)
- [x] `src/app/(dashboard)/lists/lists-table.tsx` exists (250 lines)
- [x] `src/app/(dashboard)/lists/lists-table.test.tsx` exists (170 lines)
- [x] Commit `a38233c` (Task 1) exists in git log
- [x] Commit `6ab16e2` (Task 2) exists in git log
- [x] Commit `36a3af1` (Task 3) exists in git log
- [x] `npm run verify` exits 0 (typecheck + 478 unit + 90 RTL = 568 tests)
- [x] `grep -c "function ListTable" src/app/(dashboard)/lists/page.tsx` returns 0
- [x] `grep -c "useTableUrlState<ListsFilters>" src/app/(dashboard)/lists/lists-table.tsx` returns 1
- [x] `grep -c "SortableHeader" src/app/(dashboard)/lists/lists-table.tsx` returns 7 (≥ 3 instances required)
- [x] `data-testid="lists-skeleton-row"` present in lists-table.tsx
- [x] `data-testid="lists-filter-archived"` present in lists-table.tsx
- [x] All 7 lists-table tests pass (`npx vitest run --config vitest.rtl.config.ts src/app/\(dashboard\)/lists/lists-table.test.tsx`)
- [x] All 26 prospects-table tests still pass (regression-clean)
- [x] All 17 toolbar/sortable-header tests still pass

## Self-Check: PASSED

## Next Phase Readiness

- **Plan 01-05 (`/jobs`)** can copy this exact shape: rewrite page.tsx as a server component awaiting `searchParams`, parse via `parseTableSearch` from `.helpers`, drill `parsed` into a new `JobsTable` client island consuming `useTableUrlState({ mode: 'ssr' })`. Imports identical except for the row-actions module name.
- **Plan 01-06 (`/templates`)** — same pattern; if it ships as `mode: 'client'` (URL mirror only, no SSR roundtrip), it can use the same hook with that mode flag and skip the `await searchParams` step.
- **Operational note for the orchestrator:** the lists/page.tsx now has a JS-side sort path (members) that breaks tie-breaker stability across pages. If users start exceeding ~100 lists, this becomes a real ordering bug — track as a deferred item.

---
*Phase: 01-cross-table-ux-consistency*
*Completed: 2026-05-01*
