# Phase 1: Cross-Table UX Consistency - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract the search/sort/filter URL-state machine from `prospects-table.tsx` (1,258 lines) into reusable primitives, then apply them to `/lists`, `/jobs`, and `/templates` so all CRM index pages share the same toolbar shape and URL-state behavior.

In scope: `<TableToolbar>` + `<SortableHeader>` + `useTableUrlState` hook; migration of `/properties`, `/lists`, `/jobs`, `/templates` to consume them; skeleton loader during URL-driven transitions; URL params (`?search=`, `?sort=`, `?dir=`, `?page=`) round-tripping through pagination + back-button on every consumer.

Out of scope: `/leads` kanban (deferred — kanban is intentional UX); cross-table column customization; saved filter presets; `/messages` cockpit search.

</domain>

<decisions>
## Implementation Decisions

### Component API shape
- **D-01:** Compound components, not config-prop. `<TableToolbar>` exposes `<TableToolbar.Search>` and `<TableToolbar.FilterPill>` subcomponents; each consumer composes the pieces it needs. Matches the shadcn idiom already used (`<DropdownMenu.Trigger>`, `<Table.Header>`).
- **D-02:** `<SortableHeader column="name" current={sort} dir={dir} onClick={onSort}>Name</SortableHeader>` is a sibling of `<TableToolbar>`, not a subcomponent — it lives inside `<TableHead>` cells in the table itself, not in the toolbar.
- **D-03:** URL-state machine lives in a single shared hook `useTableUrlState({ defaults, mode })` that owns parsing, building, debouncing, and the `useTransition` wrapper. Consumers receive `{ search, sort, dir, page, navigate, onSort, navPending }` and a `<TableToolbar.Search>` that wires itself to the hook via context (no manual prop forwarding for the search input).

### URL-state hook modes
- **D-04:** Hook supports two modes:
  - `mode: "ssr"` (default) — `navigate(url)` calls `router.replace + startNavTransition`; `navPending` follows the SSR roundtrip. Used by `/properties`, `/lists`, `/templates`.
  - `mode: "client"` — `navigate(url)` calls `router.replace` for URL-state mirroring (back-button + sharable URL still work) but does NOT trigger an SSR roundtrip. The consumer reads `{ search, sort, dir, filters }` from the hook and applies them in-memory. Used by `/jobs` (realtime data source) and `/templates` (small client-filtered dataset).
- **D-05:** Hook accepts `minSkeletonMs: number` option, default `150`. `navPending` stays true for at least this duration even when the underlying work finishes faster (matters for `client` mode where in-memory work is sub-frame). Gives every consumer a visible "content is responding" affordance during URL changes.

### `/jobs` strategy
- **D-06:** Keep the existing realtime Supabase channel (`jobs:list`) as the data source — VAs need live job-status updates while imports run; dropping realtime would be a UX regression.
- **D-07:** Layer sort/search/filter client-side over the realtime array via `useTableUrlState({ mode: "client" })`. URL params (`?search=`, `?sort=`, `?dir=`) reflect filter state and are sharable/back-button-safe; the in-memory recompute happens during the `navPending` transition.
- **D-08:** Pagination on `/jobs` is decorative — the realtime channel caps at 50 rows so page 1 is the only page that ever exists today. `?page=` is honored by the hook for consistency, but the slice never crosses the visible window in practice.

### `/templates` strategy
- **D-09:** Mirror the existing client-side `useMemo` filter to URL params via `useTableUrlState({ mode: "client" })`. Template dataset is small and stable; one initial server fetch + in-memory filter is faster than re-fetching on every keystroke.
- **D-10:** Both `?search=` and `?category=` (existing dropdown filter) round-trip through URL state — `?category=` migrates from local `useState` to a `<TableToolbar.FilterPill>` consuming hook state.

### `/properties` migration
- **D-11:** `/properties` is the source pattern; it gets refactored to consume the new primitives in the same phase. Build order from ROADMAP stands: extract → migrate `/properties` (no behavior change; smoke-test) → `/lists` → `/jobs` → `/templates`. Migrating the source proves the extraction works before the greenfield consumers depend on it.

### File location
- **D-12:** New primitives live in `src/components/table/`:
  - `src/components/table/table-toolbar.tsx` — compound `<TableToolbar>` + `<TableToolbar.Search>` + `<TableToolbar.FilterPill>`
  - `src/components/table/sortable-header.tsx` — `<SortableHeader>`
  - `src/components/table/use-table-url-state.ts` — the shared hook
- **D-13:** TABLE-07 wording in `.planning/REQUIREMENTS.md` is updated from `src/components/ui/` → `src/components/table/`. Same intent (extracted, reusable), corrected location (composite components belong outside the shadcn-primitive dir).

### Skeleton loader (TABLE-06)
- **D-14:** Skeleton replaces table rows on every consumer when `navPending` is true. Same `<Skeleton>` rows on every page (consistent visual). The 150ms floor (D-05) ensures the skeleton is visible on `/jobs` and `/templates` even when in-memory recompute finishes in a single frame.

### Search debounce
- **D-15:** Search input debounce stays at 250ms (matches existing `/properties` behavior). Lives inside `<TableToolbar.Search>` so consumers don't reimplement it.

### Claude's Discretion
- Exact `<Skeleton>` row markup (use existing `src/components/ui/skeleton.tsx` primitive; row count matches current page size).
- Whether `<TableToolbar.FilterPill>` accepts `active` boolean directly or via a `useFilterPill` helper — implementation detail.
- Whether `useTableUrlState` exposes filters as a typed generic (`useTableUrlState<TFilters>`) or a loose `Record<string, string | null>`. Researcher should weigh ergonomics vs strictness.
- Test boundaries: pure parse/build helpers (like `prospects-query.ts`) belong in `*.test.ts`; component integration belongs in `*.test.tsx` (RTL).
- Per-consumer filter wiring (e.g., `/lists` archived/active toggle, `/jobs` status filter, `/templates` category filter) — pick reasonable filter sets per page; no decision needed up front.

</decisions>

<specifics>
## Specific Ideas

- Source pattern is `src/app/(dashboard)/properties/prospects-query.ts` (pure helpers — `parseProspectsSearch`, `buildProspectsHref`, `SORTABLE_COLUMNS` whitelist) and `src/app/(dashboard)/properties/prospects-table.tsx` (the consumer with `useTransition`, debounced search nav, `onSortClick`, filter pills, skeleton on `navPending`). The new `useTableUrlState` should preserve the same parse/build invariants: column whitelist guards `?sort=`, `?dir=` defaults to `desc`, empty search collapses to null, `?page=` defaults to 1.
- "Don't mirror server props in `useState`" — the existing pattern uses uncontrolled inputs (`defaultValue` on the search box) and re-keys children by URL params on the page-level wrapper. The new primitives must preserve this: `<TableToolbar.Search>` is uncontrolled internally, the parent page keys its `<TableBody>` children by the URL state so router.refresh + new server props don't clobber typing.
- Existing tests to honor as the contract: `prospects-query.test.ts` (35 tests covering parse/build edge cases) and `prospects-table.test.tsx` (26 RTL tests covering debounce, sort, filter, skeleton). Equivalent tests should exist for the new hook + components.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap and requirements
- `.planning/ROADMAP.md` §"Phase 1: Cross-Table UX Consistency" — phase goal, success criteria, build order
- `.planning/REQUIREMENTS.md` §"Cross-Table UX Consistency" — TABLE-01 through TABLE-07 (note TABLE-07 location string is updated by D-13)

### Source pattern (the extraction subject)
- `src/app/(dashboard)/properties/prospects-query.ts` — pure URL parse/build helpers, `SORTABLE_COLUMNS` whitelist, `DEFAULT_SORT`/`DEFAULT_DIR`
- `src/app/(dashboard)/properties/prospects-table.tsx` — consumer pattern: `useTransition` for nav, 250ms debounced search, `onSortClick`, filter pills, `<Skeleton>` on `navPending`
- `src/app/(dashboard)/properties/prospects-query.test.ts` — test contract for parse/build edge cases (35 tests)
- `src/app/(dashboard)/properties/prospects-table.test.tsx` — RTL test contract for toolbar interaction (26 tests, including debounce + skeleton)

### Migration targets (greenfield consumers)
- `src/app/(dashboard)/lists/page.tsx` — currently no search/sort, two sections (active/archived), small dataset
- `src/app/(dashboard)/jobs/page.tsx` + `src/app/(dashboard)/jobs/jobs-list.tsx` — realtime client component, 50-row cap, no URL state today (D-06/D-07/D-08 govern)
- `src/app/(dashboard)/templates/page.tsx` + `src/app/(dashboard)/templates/templates-list.tsx` — currently client-side `useMemo` filter on `search` + `categoryFilter` (D-09/D-10 govern)

### Project conventions
- `AGENTS.md` — Next.js version notes (read before any App Router pattern decisions)
- `src/components/ui/skeleton.tsx` — primitive used for the skeleton rows
- `src/components/ui/table.tsx` — `<Table>`, `<TableHeader>`, `<TableHead>`, `<TableRow>`, `<TableCell>` (the new `<SortableHeader>` renders inside `<TableHead>`)

### Memory: locked patterns from prior phases
- `~/.claude/projects/-Users-jarradhenry-Sites-Sandra/memory/feedback_no_usestate_mirror_of_server_props.md` — uncontrolled inputs + `key`-by-URL-params pattern; new primitives must preserve this
- `~/.claude/projects/-Users-jarradhenry-Sites-Sandra/memory/feedback_verify_with_playwright.md` — visual verification of every consumer page after migration
- `~/.claude/projects/-Users-jarradhenry-Sites-Sandra/memory/feedback_test_every_fix.md` — RTL coverage per page (success criterion 5)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `prospects-query.ts` parse/build helpers: 226 lines of pure functions with 35 tests. The `parseProspectsSearch` / `buildProspectsHref` shape is the proven contract; the new `useTableUrlState` should generalize this without losing the column-whitelist guard or the default-stripping in `buildProspectsHref` (preserves clean URLs).
- `useTransition` + `router.replace` pattern in `prospects-table.tsx:140-160`: lifts the skeleton trigger off `navPending`. The new hook lifts this whole machine into shared infra.
- `src/components/ui/skeleton.tsx`: existing shadcn primitive — the new `<TableToolbar>`'s skeleton rows compose this, not a new visual.

### Established Patterns
- `Page` + `PageHeader` composition (every dashboard route uses these). The new `<TableToolbar>` slots in below `<PageHeader>` and above `<Table>`.
- Server components fetch + pass to client island (consumer pages render `<page-level server component>` → `<client island consuming hook>`). Pattern preserved across all 4 consumers.
- `router.replace + router.refresh` discipline (per `feedback_no_usestate_mirror_of_server_props.md`): `replace` updates URL, `refresh` re-fetches server data. The hook calls both in `ssr` mode and only `replace` in `client` mode.

### Integration Points
- `/properties` consumes `addPropertiesToListBulk`, `requestSkipTrace`, `getAllMatchingProspectIds` — the bulk-action dropdown stays inside `prospects-table.tsx` and is NOT extracted. Only the toolbar + sortable headers + URL-state machine become shared.
- `/jobs` Supabase realtime subscription stays in place (per D-06). The hook's `client` mode means realtime data flows through `useState` as today; the hook only owns URL-state and filter wiring on top.
- `/templates` `categories` prop comes from server-rendered list of distinct categories — survives the migration; just gets surfaced via `<TableToolbar.FilterPill>` consuming hook state instead of local `useState`.

</code_context>

<deferred>
## Deferred Ideas

- `/leads` kanban toolbar adoption — kanban is intentional UX (different from a table), already deferred at the requirements level. If visual polish on the kanban toolbar wants to track the new components later, that's its own phase.
- Saved filter presets (e.g., "My open leads") — out-of-scope per REQUIREMENTS.md "Future Requirements".
- Cross-table column customization (show/hide, reorder) — same.
- `useTableUrlState` advanced features (multi-sort, query-string compression, persisted filter sets per user) — phase-1 ships single-column sort + flat filters; richer ergonomics can come if a future table needs them.

</deferred>

---

*Phase: 01-cross-table-ux-consistency*
*Context gathered: 2026-04-30*
