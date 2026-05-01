# Phase 1: Cross-Table UX Consistency - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 01-sms-templates-v1 (slug carryover from v1; phase content is "Cross-Table UX Consistency")
**Areas discussed:** Component API shape, `/jobs` realtime vs URL-state, `/templates` client filter vs SSR, file location

---

## Component API shape

| Option | Description | Selected |
|--------|-------------|----------|
| A. Config-prop API | `<TableToolbar columns={...} searchPlaceholder="..." filters={<FilterPills />} />`. Predictable, easy to type, but pages get noisy with prop forwarding. URL-state lives in a shared hook the page calls explicitly. | |
| B. Compound components + shared hook | `<TableToolbar><TableToolbar.Search /><TableToolbar.FilterPill /></TableToolbar>` + `<SortableHeader column="name">`. `useTableUrlState` absorbs the URL-state machine. Matches shadcn idiom. | ✓ |
| C. Render-prop API | Page passes render fns for filter pills. Most flexible, hardest to read; overkill for 4 consumers. | |

**User's choice:** B (compound components + `useTableUrlState` hook)
**Notes:** Jarrad cued the React composition idiom. Confirmed B because each consumer (`/lists`, `/jobs`, `/templates`, `/properties`) has a different filter set and `/jobs` keeps realtime — config-prop forces every page to bend through one prop surface. Composition lets each page hand-pick what it renders; the hook isolates the only piece that's truly shared (the URL-state machine).

---

## `/jobs` realtime vs URL-state

| Option | Description | Selected |
|--------|-------------|----------|
| A. Drop realtime → SSR + URL params | Consistent with siblings. Visible regression for VAs (lose live job-status updates). | |
| B. Keep realtime, layer sort/search client-side, mirror state to URL | URL is shareable, back-button works, refresh restores filter — but no SSR roundtrip, so realtime keeps flowing. Skeleton (TABLE-06) shows for the 150ms floor. | ✓ |
| C. Hybrid — initial SSR-from-URL + realtime patches | Most code, most edge cases (race between initial paint and first realtime event), least win. | |

**User's choice:** B with `minSkeletonMs: 150` baked into the hook
**Notes:** Jarrad asked whether the user has any indication content is loading. Answered honestly: on `/jobs` the in-memory recompute is sub-frame fast, so without a floor the skeleton flashes for one frame and is invisible. He directed: "If there is not, then bake it in." Hook now defaults `minSkeletonMs` to 150 so every consumer gives a visible affordance during URL changes. On SSR consumers the floor is a no-op (SSR roundtrip exceeds 150ms). Pagination on `/jobs` is decorative because the realtime channel caps at 50 rows — page 1 is the only page that ever exists.

---

## `/templates` client filter vs URL-driven SSR

| Option | Description | Selected |
|--------|-------------|----------|
| A. Mirror current client-side filter to URL params | No SSR roundtrip on filter change. `useTableUrlState` writes `?search=` and `?category=` to URL via `router.replace`; existing `useMemo` filter reads from URL state. Skeleton via 150ms floor. | ✓ |
| B. Migrate fully to SSR + URL params | Consistent with `/properties`, `/lists`. More code change, more network roundtrips for a small dataset. | |
| C. Mixed — search via URL/SSR, category dropdown stays client | Inconsistent UX. | |

**User's choice:** A (client-mode hook, URL mirroring without SSR roundtrip)
**Notes:** Templates dataset is small and stable. Client filter is faster than network roundtrip; gives `useTableUrlState` a second client-mode consumer alongside `/jobs` and validates that the hook's `client` mode is real shared infrastructure.

---

## File location

| Option | Description | Selected |
|--------|-------------|----------|
| A. `src/components/ui/` | Per TABLE-07 wording. Sits next to `table.tsx`. But these aren't shadcn primitives — they bake in app-specific behavior (URL-state, debouncing, `router.replace`). Pollutes the convention. | |
| B. `src/components/table/` (new subdir) | `table-toolbar.tsx`, `sortable-header.tsx`, `use-table-url-state.ts` colocated. Signals "this is the cross-table table system; future tables opt in here." | ✓ |
| C. `src/components/` flat | Like `page-header.tsx` — top-level. Discoverable but mixes app-shell components with the table system. | |

**User's choice:** B (`src/components/table/` new subdir)
**Notes:** Side effect — TABLE-07 wording in `.planning/REQUIREMENTS.md` updates from `src/components/ui/` → `src/components/table/`. Same intent (extracted, reusable), corrected location.

---

## Claude's Discretion

- Exact `<Skeleton>` row markup (uses existing `src/components/ui/skeleton.tsx` primitive).
- Whether `<TableToolbar.FilterPill>` accepts `active` boolean directly or via a `useFilterPill` helper.
- Whether `useTableUrlState` exposes filters as a typed generic (`useTableUrlState<TFilters>`) or a loose `Record<string, string | null>`. Researcher should weigh ergonomics vs strictness.
- Per-consumer filter wiring (`/lists` archived/active toggle, `/jobs` status filter, `/templates` category filter) — pick reasonable filter sets per page.

## Deferred Ideas

- `/leads` kanban toolbar adoption — kanban is intentional UX, deferred at the requirements level.
- Saved filter presets, cross-table column customization — out-of-scope per REQUIREMENTS.md "Future Requirements".
- `useTableUrlState` advanced features (multi-sort, query-string compression, persisted user filter sets) — phase-1 ships single-column sort + flat filters.
