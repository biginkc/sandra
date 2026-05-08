---
phase: 05-prospects-filter-drawer
plan: 06
subsystem: ui
tags: [react, next.js, url-state, debounce, rtl, sheet, filter-drawer]

# Dependency graph
requires:
  - phase: 05-prospects-filter-drawer/05-04
    provides: countProspectsForFilter server action used by useDebouncedFilters
  - phase: 05-prospects-filter-drawer/05-05
    provides: filter-schema (BlockKind, FilterBlock, encodeFilters, decodeFilters, newBlockId)
  - phase: 05-prospects-filter-drawer/05-01
    provides: base-ui Sheet component at src/components/ui/sheet.tsx
provides:
  - useFilterState hook — URL-driven filter block stack, no useState mirror
  - useDebouncedFilters hook — 250ms debounce + stale-request guard for live count
  - AddBlockPicker component — stacked panel with categorized search over 23 block kinds
  - FilterDrawer component — 440px right-side Sheet with topSlot/footerSlot composition props
  - defaultBlockForKind helper — builds sensible default FilterBlock per kind (exported)
affects: [05-07, 05-08, 05-09, 05-10]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "URL-as-source-of-truth: useSearchParams() + router.replace + router.refresh inside startTransition; NO useState mirror"
    - "setTimeout-ref debounce: timerRef + reqIdRef pattern (matches use-table-url-state.ts)"
    - "Inner/outer component split for clean local-state reset on open (AddBlockPickerInner unmounts each close)"
    - "autoFocus HTML attribute for jsdom-compatible focus (vs imperative focus in effects which blocks userEvent)"
    - "Controlled Sheet mode via open + onOpenChange props for test isolation (bypasses base-ui animation)"

key-files:
  created:
    - src/app/(dashboard)/properties/_components/use-filter-state.ts
    - src/app/(dashboard)/properties/_components/use-filter-state.test.tsx
    - src/app/(dashboard)/properties/_components/use-debounced-filters.ts
    - src/app/(dashboard)/properties/_components/use-debounced-filters.test.tsx
    - src/app/(dashboard)/properties/_components/add-block-picker.tsx
    - src/app/(dashboard)/properties/_components/add-block-picker.test.tsx
    - src/app/(dashboard)/properties/_components/filter-drawer.tsx
    - src/app/(dashboard)/properties/_components/filter-drawer.test.tsx
  modified: []

key-decisions:
  - "autoFocus attribute instead of imperative inputRef.current?.focus() — imperative focus fired after userEvent claimed the element, causing Strict Mode remount races"
  - "Inner/outer component split (AddBlockPickerInner + AddBlockPicker shell) — ensures q state resets cleanly on every open without a useEffect reset"
  - "userEvent.setup({ delay: null }) for the filter typing test — delay:null makes events fire synchronously so Strict Mode double-invocation cannot insert a remount between keystrokes"
  - "Controlled Sheet via open/onOpenChange props in FilterDrawer — makes integration tests bypass base-ui animation/portal timing without fake timers"
  - "router.replace mock updates window.history.replaceState with relative URL — full URLs cause jsdom SecurityError; extract ?search and compose /properties?... as relative path"
  - "JSON.stringify(blocks) as stable effect dep in useDebouncedFilters — blocks array reference changes every render, raw dep would cause infinite re-fetches"
  - "defaultBlockForKind exported from filter-drawer.tsx — Plan 07 may need to call it when injecting blocks programmatically"

patterns-established:
  - "Filter drawer testing: render with open={true} + onOpenChange={vi.fn()} to bypass Sheet trigger animation; rerender() after mutations to pick up updated useSearchParams"
  - "URL mock pattern: replace mock calls window.history.replaceState({}, '', '/properties' + search) with relative URL; beforeEach resets to /properties"
  - "Stale request guard: reqIdRef.current increments before each fetch; callback drops setState if reqId !== reqIdRef.current at resolution time"

requirements-completed: [R1, R4, R8]

# Metrics
duration: ~45min
completed: 2026-05-07
---

# Phase 05 Plan 06: Filter Drawer Shell + Hooks Summary

**URL-driven filter drawer shell with autofocused picker, 250ms debounced live count, and topSlot/footerSlot composition props — 30 RTL tests green, typecheck clean.**

## Performance

- **Duration:** ~45 min (continuation session)
- **Started:** 2026-05-07T22:49Z
- **Completed:** 2026-05-07T22:53Z
- **Tasks:** 4 completed
- **Files modified:** 8 created (0 modified)

## Accomplishments

- Shipped `useFilterState` — reads `FilterBlock[]` from `?filters=` via `useSearchParams()`, zero `useState` mirror; all mutations go through `router.replace + router.refresh` inside `startTransition`
- Shipped `useDebouncedFilters` — 250ms `setTimeout`-ref debounce with `reqIdRef` stale-request guard; returns `{ status, count }` for live CTA label
- Shipped `AddBlockPicker` — absolute-positioned stacked panel, 6 group headers, 23 items, autofocused search; inner/outer split resets `q` cleanly on every open
- Shipped `FilterDrawer` — base-ui Sheet at `!max-w-[440px]`, empty-state copy, `renderBlock` slot for Plan 07, `topSlot`/`footerSlot` composition props for Plan 09
- Resolved React 18 Strict Mode double-invocation problem: inner/outer component split + `autoFocus` attribute + `userEvent.setup({ delay: null })` for search filtering test

## Task Commits

1. **Task 1: useFilterState hook + tests** - `125d304` (feat)
2. **Tasks 2-4: useDebouncedFilters + AddBlockPicker + FilterDrawer** - `4dc63a4` (feat)

_Note: Tasks 2-4 were committed together by the prior session agent before context compaction._

## Files Created/Modified

- `use-filter-state.ts` — Hook: reads URL params, exposes addBlock/removeBlock/updateBlock/replaceStack/clearAll
- `use-filter-state.test.tsx` — 7 RTL tests covering all mutators and URL encoding
- `use-debounced-filters.ts` — Hook: 250ms debounce, reqIdRef race guard, loading/ready/error states
- `use-debounced-filters.test.tsx` — 5 RTL tests including stale-request drop scenario
- `add-block-picker.tsx` — Picker panel, BLOCK_PICKER_GROUPS (6 groups × 23 items), inner/outer split
- `add-block-picker.test.tsx` — 7 RTL tests: autofocus, group headers, search filter, click, Esc, back, closed state
- `filter-drawer.tsx` — Drawer shell + defaultBlockForKind helper (exhaustive switch over 23 BlockKind values)
- `filter-drawer.test.tsx` — 11 RTL tests: trigger, empty state, picker open, block add/remove, count CTA, width class, null/topSlot/footerSlot/both slot permutations

## Decisions Made

**1. Inner/outer component split for AddBlockPicker**
The `AddBlockPickerInner` component mounts fresh each time `open` flips true. This means `q = ""` on every open without any `useEffect` reset. The outer `AddBlockPicker` shell returns `null` when `open=false`. This eliminates the class of bugs where a `useEffect` reset races with async event dispatch.

**2. autoFocus attribute instead of imperative focus**
Using `inputRef.current?.focus()` inside a `useEffect` fired after `open` changes interfered with jsdom's userEvent focus tracking. The `autoFocus` HTML attribute runs during mount, before any test code runs, and works correctly in both browser and jsdom environments.

**3. Controlled Sheet mode in FilterDrawer**
Added `open?: boolean` and `onOpenChange?` props that pass through to base-ui `Sheet`. When these are provided, the `SheetTrigger` is not rendered. Tests use `open={true}` to bypass the trigger animation entirely — this avoids base-ui's Dialog portal timing issues that caused 5-second timeouts in initial test runs.

**4. How Plan 09 acquires orgId**
The page server component calls `requireOrgMembership()` (from `@/lib/auth/require-org`) which throws if unauthenticated, and returns `{ org }`. The `org.id` is passed as the `orgId` prop to `FilterDrawer`.

**5. renderBlock prop signature for Plan 07**
```ts
renderBlock?: (
  block: FilterBlock,
  onChange: (patch: Partial<FilterBlock>) => void,
  onRemove: () => void,
) => React.ReactNode;
```
Plan 07 exports a per-kind dispatcher and passes it here. Until Plan 07 ships, `FilterDrawer` renders `PlaceholderBlockRow` showing `Block: <kind> — not yet implemented`.

**6. defaultBlockForKind helper**
Exported from `filter-drawer.tsx`. Builds a sensible default `FilterBlock` for each of the 23 `BlockKind` values. Plan 07 may call this when adding blocks programmatically if the picker-via-UI path is bypassed (e.g., preset loading in Plan 09).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] React 18 Strict Mode remount during async userEvent.type**
- **Found during:** Task 3 (AddBlockPicker tests)
- **Issue:** React 18 Strict Mode double-invokes component effects, which caused `AddBlockPickerInner` to unmount/remount between keystrokes during async `userEvent.type`. Each remount reset `q = ""`, leaving the search filter input empty after typing.
- **Fix:** (a) Moved from single-component with `useEffect` reset to inner/outer split where `AddBlockPickerInner` mounts fresh on open — no reset effect needed. (b) Changed `autoFocus` from imperative (`inputRef.current?.focus()`) to the HTML `autoFocus` attribute. (c) Used `userEvent.setup({ delay: null })` in the search filter test to fire events synchronously.
- **Files modified:** `add-block-picker.tsx`, `add-block-picker.test.tsx`
- **Committed in:** `4dc63a4`

**2. [Rule 2 - Missing functionality] Controlled open prop on FilterDrawer for test isolation**
- **Found during:** Task 4 (FilterDrawer tests)
- **Issue:** Tests that click the SheetTrigger caused base-ui Dialog portal timing issues — the drawer content never appeared in the DOM, causing 5-second timeouts.
- **Fix:** Added `open?: boolean` and `onOpenChange?` props to `FilterDrawerProps`. When `open !== undefined`, the Sheet runs in controlled mode and `SheetTrigger` is not rendered. Tests use `open={true}` to render the drawer directly without animation.
- **Files modified:** `filter-drawer.tsx`, `filter-drawer.test.tsx`
- **Committed in:** `4dc63a4`

**3. [Rule 1 - Bug] jsdom SecurityError from full URLs in history.replaceState mock**
- **Found during:** Task 4 (FilterDrawer tests)
- **Issue:** The `router.replace` mock initially called `window.history.replaceState({}, "", "http://localhost/properties?...")` which threw a SecurityError in jsdom — only relative or same-origin URLs are accepted.
- **Fix:** Mock extracts the `?search` portion and calls `window.history.replaceState({}, "", "/properties" + search)` with a relative URL.
- **Files modified:** `filter-drawer.test.tsx`
- **Committed in:** `4dc63a4`

---

**Total deviations:** 3 auto-fixed (2× Rule 1 bugs, 1× Rule 2 missing functionality)
**Impact on plan:** All fixes directly enabled the planned test suite to pass. No scope changes.

## Issues Encountered

**React 18 Strict Mode + userEvent async interaction** — The most significant problem. Strict Mode's double-invocation of effects causes component remounts during async gaps in `userEvent.type`. Resolved via the inner/outer component split and synchronous event dispatch (see Deviations above).

**base-ui Sheet animation in jsdom** — base-ui's Dialog/Sheet uses portals and CSS transitions. jsdom does not run CSS transitions, so the Sheet content never "appeared" when tests clicked the trigger. Resolved by adding controlled `open` prop.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Plan 07 (block components) can immediately:
- Import `FilterDrawer` and pass `renderBlock={(block, onChange, onRemove) => <BlockDispatcher ... />}`
- Import `BLOCK_PICKER_GROUPS` from `add-block-picker.tsx` for any UI that lists block kinds
- Import `defaultBlockForKind` from `filter-drawer.tsx` for preset loading in Plan 09
- Import `useFilterState` and `useDebouncedFilters` for any component that needs read access to the current filter stack

Plan 08 (Quick Filters bar) can render outside the drawer and call `useFilterState()` to modify the same URL-backed block stack.

Plan 09 (page wiring + presets) passes:
```tsx
<FilterDrawer
  orgId={org.id}
  renderBlock={renderBlock}
  topSlot={<PresetDropdown ... />}
  footerSlot={<SavePresetInline ... />}
/>
```

---
*Phase: 05-prospects-filter-drawer*
*Completed: 2026-05-07*
