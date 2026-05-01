# Phase 1: Cross-Table UX Consistency - Research

**Researched:** 2026-04-30
**Domain:** Next.js 16 App Router + React 19 — URL-state primitives for table pages
**Confidence:** HIGH

## Summary

Phase 1 extracts the URL-driven search/sort/filter machine from
`src/app/(dashboard)/properties/prospects-table.tsx` into three primitives in
`src/components/table/`: a compound `<TableToolbar>` with `<Search>` + `<FilterPill>`
sub-pieces, a sibling `<SortableHeader>`, and a shared `useTableUrlState` hook. The
research confirms (a) every pattern in the source is already idiomatic for this
specific Next.js version (16.2.4 + React 19.2.4); (b) the codebase already exports
shadcn primitives as **flat sibling exports**, not `Object.assign` namespaces, so
the compound API should follow that convention; (c) the source pattern works
because URL state arrives as **server-rendered props**, not via `useSearchParams`,
which avoids the Next 16 Suspense-boundary requirement; (d) all three migration
targets are concrete files with known, surveyed structure — `/lists` is a server
component that needs to become server-page + client-island, `/jobs` already has a
client island and needs URL state layered over its realtime array, and `/templates`
already has client filtering and just migrates `useState` → URL params.

The biggest non-obvious risk is **realtime + URL-state interaction on `/jobs`** —
the realtime `setJobs` calls fire mid-`navPending`, and the visible slice must
recompute correctly when an INSERT lands during an active filter. Decisions D-04,
D-06, and D-07 already account for this (client mode reads URL state and applies
filters in-memory each render), but the test contract must lock the behavior.

**Primary recommendation:** Build the three primitives in this order — pure
helpers (parse/build) → hook (state machine + transition) → toolbar/header
(presentational, hook-aware via context) → migrate `/properties` first
(no-behavior-change diff that proves the contract) → `/lists` → `/jobs` → `/templates`.
Tests follow the same waterfall: unit on parse/build, hook on state machine,
RTL on components, RTL on each consumer page.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| URL-state parsing (`?search=...`) | Frontend Server (SSR) | Client | `searchParams` arrives in server `page.tsx`; pure helpers (no DOM/router) consumed by both server (data fetch) and client (mirror display) |
| URL-state writing (`router.replace`) | Browser / Client | — | `useRouter()` + `router.replace` are client-only APIs |
| Data fetch (Supabase query w/ filters) | Frontend Server (SSR) for `/properties`, `/lists`; Browser / Client for `/jobs`, `/templates` | — | `/properties` + `/lists` use server-rendered `page.tsx`; `/jobs` is realtime client island; `/templates` is client `useMemo` filter |
| Skeleton during URL nav | Browser / Client | — | `useTransition` lives in client component; `navPending` flag drives `<Skeleton>` swap |
| Compound component composition | Browser / Client | — | All shadcn-style compounds in this repo are `"use client"` |
| Search input state (uncontrolled) | Browser / Client | — | `defaultValue=` + ref-based `setTimeout` debounce; per `feedback_no_usestate_mirror_of_server_props.md` |
| Pagination links | Frontend Server (SSR) | — | Plain `<Link>` with computed href; SSR-rendered, no client state |
| Realtime updates (`/jobs` only) | Browser / Client | API (Supabase realtime channel) | Subscription owns `setJobs`; URL state is layered on top in-memory |

## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01 Compound component API** — `<TableToolbar>` exposes `<TableToolbar.Search>` and
`<TableToolbar.FilterPill>` subcomponents; consumers compose pieces. Matches shadcn
idiom (`<DropdownMenu.Trigger>` style usage, but **flat exports** in this repo —
see "Compound Component Pattern" below).

**D-02 SortableHeader is a sibling** — `<SortableHeader column="name" current={sort}
dir={dir} onClick={onSort}>Name</SortableHeader>` lives inside `<TableHead>` cells,
not in the toolbar.

**D-03 Single shared hook** — `useTableUrlState({ defaults, mode })` owns parsing,
building, debouncing, the `useTransition` wrapper. Returns `{ search, sort, dir,
page, navigate, onSort, navPending }` and a `<TableToolbar.Search>` that wires
itself via context (no manual prop forwarding).

**D-04 Hook supports two modes** —
- `mode: "ssr"` (default): `navigate(url)` calls `router.replace + startNavTransition`;
  `navPending` follows SSR roundtrip. Used by `/properties`, `/lists`.
- `mode: "client"`: `navigate(url)` calls `router.replace` for URL mirroring (back-button
  + sharable URL still work) but does NOT trigger SSR roundtrip. Consumer reads
  `{ search, sort, dir, filters }` from hook and applies in-memory. Used by `/jobs`
  and `/templates`.

**D-05** — `minSkeletonMs: number` option, default `150`. `navPending` stays true
at least this long even when work finishes faster.

**D-06** — `/jobs` keeps existing realtime Supabase channel (`jobs:list`).

**D-07** — `/jobs` layers sort/search/filter client-side over realtime array via
`mode: "client"`.

**D-08** — `/jobs` `?page=` is decorative (50-row cap means page 1 only).

**D-09** — `/templates` mirrors existing `useMemo` filter to URL params via
`mode: "client"`.

**D-10** — `/templates` `?search=` AND `?category=` round-trip through URL state;
`?category=` migrates from local `useState` to `<TableToolbar.FilterPill>`.

**D-11** — `/properties` is the source pattern AND a migration target.

**D-12** — Files live in `src/components/table/`:
- `table-toolbar.tsx` — compound `<TableToolbar>` + `<TableToolbar.Search>` + `<TableToolbar.FilterPill>`
- `sortable-header.tsx` — `<SortableHeader>`
- `use-table-url-state.ts` — the shared hook

**D-13** — TABLE-07 wording in REQUIREMENTS.md updated `src/components/ui/` →
`src/components/table/`.

**D-14** — Skeleton replaces table rows on every consumer when `navPending` is true.

**D-15** — Search debounce stays at 250ms.

### Claude's Discretion

- Exact `<Skeleton>` row markup (use existing `src/components/ui/skeleton.tsx`;
  row count matches current page size).
- Whether `<TableToolbar.FilterPill>` accepts `active` boolean directly or via a
  `useFilterPill` helper.
- Whether `useTableUrlState` exposes filters as typed generic
  (`useTableUrlState<TFilters>`) or loose `Record<string, string | null>`.
  **Researcher recommendation:** typed generic — matches `ParsedProspectsFilters`
  precedent and stops `?market=NotARealMarket` from leaking past the type system.
- Test boundaries: pure parse/build helpers belong in `*.test.ts`; component
  integration belongs in `*.test.tsx` (RTL).
- Per-consumer filter wiring (e.g., `/lists` archived/active toggle, `/jobs`
  status filter, `/templates` category filter).

### Deferred Ideas (OUT OF SCOPE)

- `/leads` kanban toolbar adoption — kanban is intentional UX.
- Saved filter presets ("My open leads") — REQUIREMENTS.md "Future".
- Cross-table column customization (show/hide, reorder).
- `useTableUrlState` advanced features (multi-sort, query-string compression,
  persisted filter sets per user).

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TABLE-01 | Unified rounded-card toolbar on `/lists`, `/jobs`, `/templates` | `<TableToolbar>` compound primitive + flat exports pattern (see "Compound Component Pattern"); existing source: `prospects-table.tsx:673` (the rounded-card div) |
| TABLE-02 | Free-text search the primary identifier column on each page | `<TableToolbar.Search>` compound subcomponent; primary-id mapping documented in "Migration Targets" (lists.name, jobs.title-or-id, templates.name) |
| TABLE-03 | Click-to-sort with arrow icon | `<SortableHeader>` extracted verbatim from `prospects-table.tsx:859-892`; uses `lucide-react` ArrowUp / ArrowDown / ArrowUpDown |
| TABLE-04 | Sort + search state in URL params | `useTableUrlState` hook owns `parseTableSearch` + `buildTableHref`; whitelist guards `?sort=`; defaults are stripped from URL ("Don't Hand-Roll" / "Code Examples") |
| TABLE-05 | Pagination links preserve sort + search | `buildTableHref({ page, search, sort, dir, filters })` is the same builder used by both `<Link href=>` for pagination AND `router.replace()` for in-page nav (see `properties/page.tsx:292`) |
| TABLE-06 | Skeleton loader during URL-driven navigation | `navPending` flag from hook → `<Skeleton>` swap; 150ms floor (D-05) ensures visibility on `client`-mode pages where in-memory recompute is sub-frame |
| TABLE-07 | `<TableToolbar>` + `<SortableHeader>` + `useTableUrlState` extracted into `src/components/table/` (corrected from /ui/ per D-12/D-13) | Three new files with verified locations; flat exports pattern per repo convention |

## Project Constraints (from CLAUDE.md / AGENTS.md)

**Hard rules:**
- AGENTS.md: "This is NOT the Next.js you know — read the relevant guide in
  `node_modules/next/dist/docs/` before writing any code." Confirmed by version
  check: Next.js 16.2.4 + React 19.2.4. All Next.js patterns in this research
  are verified against `node_modules/next/dist/docs/`, paths cited inline.
- `feedback_no_usestate_mirror_of_server_props.md`: search input must be
  uncontrolled (`defaultValue=`), parent keys children by URL params, follow
  `router.replace` with `router.refresh` when data depends on the query. The
  existing `prospects-table.tsx` does this; the new primitives must preserve.
- `feedback_test_every_fix.md`: every behavior change → test that locks the
  behavior in. The new RTL contract MUST cover the 26-test surface from
  `prospects-table.test.tsx` plus per-consumer page tests.
- `feedback_verify_with_playwright.md`: visual verification of every consumer
  page after migration. (Phase 1's Playwright phase is post-implementation.)
- `feedback_one_decision_strict.md`: research surfaces options; planner picks
  via discuss-phase; execution doesn't relitigate.

## Standard Stack

### Core (already in `package.json` — no new deps)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `next` | 16.2.4 | App Router + `router.replace` + `searchParams` Promise prop | Production frontend framework; current major |
| `react` | 19.2.4 | `useTransition` async support + `use()` hook for client `searchParams` Promise | Required peer of next@16 |
| `lucide-react` | ^1.8.0 | `ArrowUp` / `ArrowDown` / `ArrowUpDown` / `Search` / `X` / `ChevronDownIcon` icons | Already used for the existing sort header in `prospects-table.tsx:3` |
| `@base-ui/react` | ^1.4.1 | Used by `dropdown-menu.tsx` (Menu primitive); the `<TableToolbar.FilterPill>` pattern can wrap Base UI Menu for the dropdown filter pills (e.g., the `/templates` category filter) | Already the in-house headless UI primitive |
| `tailwind-merge` + `clsx` | ^3.5.0 / ^2.1.1 | `cn()` helper from `@/lib/utils` | Existing style-merge pattern across all shadcn primitives |

### Supporting (existing primitives — compose, don't extract)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@/components/ui/skeleton` | (in-repo) | `<Skeleton className="h-4 w-72" />` rows during `navPending` | TABLE-06 skeleton swap |
| `@/components/ui/input` | (in-repo) | Search input — already used at `prospects-table.tsx:679` | `<TableToolbar.Search>` internal |
| `@/components/ui/button` + `buttonVariants` | (in-repo) | Filter pill rendering, "Clear" link | `<TableToolbar.FilterPill>` internal |
| `@/components/ui/table` | (in-repo) | `Table` / `TableHeader` / `TableHead` / `TableRow` / `TableCell` / `TableBody` | `<SortableHeader>` renders inside `<TableHead>` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `useTableUrlState` (custom hook) | `nuqs` library | `nuqs` is the npm-popular URL-state hook (~25k weekly DLs), but it would be a new dep; the codebase already has 226 lines of pure helpers in `prospects-query.ts` covering parse/build with 35 tests. The hook is a thin wrapper. Custom is right here. |
| Compound components (D-01) | Single `<TableToolbar />` config-prop component | Locked by D-01. Compound matches shadcn idiom and is more flexible (consumers omit `<FilterPill>` if they don't need filters). |
| `useSearchParams()` inside hook | `searchParams` prop drilled from server `page.tsx` | The existing pattern uses prop-drilling and works without a Suspense boundary. New hook MUST preserve this — see "Common Pitfalls" / "useSearchParams Suspense trap". |

**Installation:** No new packages. The phase composes existing primitives.

**Version verification:** Verified against `package.json` on 2026-04-30:
`next@16.2.4`, `react@19.2.4`, `react-dom@19.2.4`, `lucide-react@^1.8.0`,
`@testing-library/react@^16.3.2`, `vitest@^4.1.5`. All in repo. `[VERIFIED: package.json]`

## Architecture Patterns

### System Architecture Diagram

```
                            ┌──────────────────────────────────┐
                            │  Browser URL bar                  │
                            │  /lists?search=foo&sort=name&...  │
                            └──────────────────────────────────┘
                                 │ (1) initial load              ▲
                                 ▼                               │ (4) router.replace
                  ┌──────────────────────────────────┐           │   keeps URL fresh
                  │  Server: page.tsx                 │           │
                  │  - await searchParams (Promise)   │           │
                  │  - parseTableSearch(raw)          │           │
                  │  - Supabase query w/ filters      │           │
                  │  - pass {search, sort, dir, ...}  │           │
                  │    as props to client island      │           │
                  └──────────────────────────────────┘           │
                                 │                                │
                                 ▼ (2) server-rendered props       │
                  ┌──────────────────────────────────┐           │
                  │  Client island (e.g., ListsTable) │           │
                  │  const ts = useTableUrlState({    │           │
                  │    defaults, mode: "ssr"          │           │
                  │  });                              │           │
                  │  ┌─ ts.navigate(url) ─────────────┼───────────┘
                  │  ├─ ts.onSort(col)                │
                  │  ├─ ts.search / sort / dir / page │
                  │  └─ ts.navPending → <Skeleton>    │ (5) router.refresh
                  │                                    │   re-runs page.tsx
                  │  Compose:                          │   with new searchParams
                  │  <TableToolbar>                    │
                  │   <TableToolbar.Search />          │ (3) user types/clicks
                  │   <TableToolbar.FilterPill ... /> │
                  │  </TableToolbar>                  │
                  │  <Table>                           │
                  │   <SortableHeader column="name" />│
                  │   ...                              │
                  │  </Table>                          │
                  └──────────────────────────────────┘
                                 │
                                 ▼ (subscribe, /jobs only)
                  ┌──────────────────────────────────┐
                  │  Supabase realtime channel        │
                  │  (jobs:list) → setJobs            │
                  │  In "client" mode hook does NOT   │
                  │  trigger router.refresh; URL is   │
                  │  mirrored, in-memory filter is    │
                  │  re-applied on each render        │
                  └──────────────────────────────────┘
```

**Key flows:**

1. **Initial load (page.tsx server component):** `searchParams` arrives as a
   Promise (Next 16 — see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:67-119`),
   awaited, parsed via the new `parseTableSearch` helper, used to build the
   Supabase query, results passed to the client island as plain string props.
2. **Hydration:** Client island receives URL state as props (no `useSearchParams`
   needed, no Suspense required for production build).
3. **User interaction:** Type / click sort → hook calls `router.replace(url, { scroll: false })`
   wrapped in `startTransition`.
4. **Browser URL refresh:** Stays in sync because `router.replace` updates the
   address bar; back-button works because each replace is a real history mutation.
5. **SSR mode:** After `router.replace`, the next render of `page.tsx` re-runs
   with new `searchParams`, fetches fresh data, passes new props down. The hook
   may also call `router.refresh()` to ensure cache eviction
   (`feedback_no_usestate_mirror_of_server_props.md`).

For `client` mode (`/jobs`, `/templates`), step 5 is a no-op — the consumer
applies `{ search, sort, dir, filters }` to its in-memory array directly.

### Recommended Project Structure (new files)

```
src/components/table/
├── use-table-url-state.ts          # hook + parse/build + types
├── use-table-url-state.test.ts     # node-env unit tests for parse/build/hook
├── table-toolbar.tsx               # <TableToolbar> + .Search + .FilterPill
├── table-toolbar.test.tsx          # RTL: debounce, search clearing, filter pill behavior
├── sortable-header.tsx             # <SortableHeader>
└── sortable-header.test.tsx        # RTL: click-to-sort, dir flipping, icon state
```

Each consumer page gets at minimum a render-the-toolbar RTL test:

```
src/app/(dashboard)/lists/page.test.tsx                  # NEW: render lists w/ toolbar
src/app/(dashboard)/jobs/jobs-list.test.tsx              # NEW: render jobs-list w/ toolbar + realtime mock
src/app/(dashboard)/templates/templates-list.test.tsx    # NEW: render templates-list w/ toolbar
src/app/(dashboard)/properties/prospects-table.test.tsx  # EXISTING: 26 tests, must stay green
```

### Pattern 1: Compound Component (flat sibling exports)

**What:** The compound API exposes child components as siblings of the parent
in the export list, then composed at the call site as `<TableToolbar><TableToolbar.Search/></TableToolbar>`.

**When to use:** Always in this repo — `dropdown-menu.tsx` lines 252-268 export
`{ DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, ... }` as flat
siblings. There is no `Object.assign(DropdownMenu, { Trigger: ..., Content: ... })`
pattern anywhere in the codebase. **Use the same convention** for `<TableToolbar>`
to match `[VERIFIED: src/components/ui/dropdown-menu.tsx:252-268]`.

**Recommended export shape:**
```typescript
// src/components/table/table-toolbar.tsx
"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  TableUrlStateContext,
  useTableUrlStateContext,
} from "./use-table-url-state";

function TableToolbar({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-toolbar"
      className={cn(
        "border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function TableToolbarSearch({ placeholder, ariaLabel, testId }: {
  placeholder?: string;
  ariaLabel: string;
  testId?: string;
}) {
  const ctx = useTableUrlStateContext();
  // … uncontrolled defaultValue={ctx.search}, onChange debounced 250ms,
  //    setTimeout in ref, ctx.navigate(buildHref({ ...ctx, search: trimmed }))
  return /* … */;
}

function TableToolbarFilterPill({ active, onClick, children, testId }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
      className="gap-1"
    >
      {children}
      {active ? <X className="size-3" aria-hidden /> : null}
    </Button>
  );
}

export { TableToolbar, TableToolbarSearch, TableToolbarFilterPill };
```

**Call site (matches existing `<DropdownMenu>` shape):**
```tsx
import {
  TableToolbar,
  TableToolbarSearch,
  TableToolbarFilterPill,
} from "@/components/table/table-toolbar";

// inside a consumer client island:
<TableToolbar>
  <TableToolbarSearch
    placeholder="Search address…"
    ariaLabel="Search prospects by address"
    testId="prospects-search"
  />
  <TableToolbarFilterPill active={filters.vacant} onClick={...} testId="filter-vacant">
    Vacant
  </TableToolbarFilterPill>
</TableToolbar>
```

**Rejected alternative:** `Object.assign(TableToolbar, { Search, FilterPill })`
to enable `<TableToolbar.Search>` dot-notation. **Rejected** because:
1. No precedent in this codebase (every shadcn primitive uses flat exports).
2. Worse tree-shaking guarantees (the unused subcomponents come along).
3. CONTEXT.md decision D-01 says "matches the shadcn idiom already used" — and
   the actual shadcn idiom *in this repo* is flat exports. The dot-notation
   `<DropdownMenu.Trigger>` mention in D-01 is consumer-style sugar, not the
   actual export shape. `[VERIFIED: src/components/ui/dropdown-menu.tsx]`

`[VERIFIED: src/components/ui/dropdown-menu.tsx:252-268, src/components/ui/table.tsx:107-116, src/components/ui/dialog.tsx, src/components/ui/sheet.tsx — all use flat exports]`

### Pattern 2: Context-Based Hook Wiring (avoids prop-drilling)

**What:** `useTableUrlState` returns the state machine AND owns a React context
that `<TableToolbar.Search>` and `<TableToolbar.FilterPill>` consume. The
consumer mounts a `<TableUrlStateProvider value={ts}>` (or the hook returns a
`{ Provider }` member) and the subcomponents pick up state without manual
prop forwarding.

**When to use:** Per D-03, the consumer should not have to manually forward the
hook to every `<TableToolbar.Search>`. Context handles that.

**Why this is safe in this repo:** No existing context-passing compound primitive
in `src/components/ui/` (Base UI Menu does internal context but it's library
internals). This is greenfield context — but the pattern is industry-standard
React, used by every shadcn-style compound. `[CITED: react.dev/reference/react/createContext]`

**Recommended shape:**
```typescript
// src/components/table/use-table-url-state.ts
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

// Pure helpers (testable in node env, no DOM)
export type SortDirection = "asc" | "desc";

export type ParseTableSearchInput = {
  page?: string | string[];
  search?: string | string[];
  sort?: string | string[];
  dir?: string | string[];
  // generic — consumer extends with its own filter keys
  [key: string]: string | string[] | undefined;
};

export type ParsedTableSearch<TFilters extends Record<string, unknown> = Record<string, never>> = {
  page: number;
  search: string | null;
  sort: string;          // narrowed by consumer's whitelist
  dir: SortDirection;
  filters: TFilters;
};

export function parseTableSearch<TFilters extends Record<string, unknown>>(
  raw: ParseTableSearchInput,
  config: {
    sortableColumns: readonly string[];
    defaultSort: string;
    defaultDir?: SortDirection;        // defaults to "desc"
    parseFilters?: (raw: ParseTableSearchInput) => TFilters;
  },
): ParsedTableSearch<TFilters> { /* … */ }

export function buildTableHref<TFilters extends Record<string, unknown>>(parts: {
  page?: number;
  search?: string | null;
  sort?: string;
  dir?: SortDirection;
  filters?: Partial<TFilters>;
}, config: {
  defaultSort: string;
  defaultDir?: SortDirection;
  buildFilterParams?: (filters: Partial<TFilters>, sp: URLSearchParams) => void;
}): string { /* … */ }

// Context for compound subcomponents
type TableUrlStateContextValue = {
  search: string;
  sort: string;
  dir: SortDirection;
  page: number;
  navigate: (url: string) => void;
  onSort: (column: string) => void;
  navPending: boolean;
  buildHref: (parts: { /* … */ }) => string;
};
const TableUrlStateContext = React.createContext<TableUrlStateContextValue | null>(null);
export function useTableUrlStateContext() {
  const ctx = React.useContext(TableUrlStateContext);
  if (!ctx) throw new Error("<TableToolbar.Search> must be used inside <TableUrlStateProvider>");
  return ctx;
}

// The hook itself
export function useTableUrlState<TFilters extends Record<string, unknown>>(options: {
  basePath: string;                      // e.g., "/lists"
  parsed: ParsedTableSearch<TFilters>;   // server-rendered prop, drilled in
  mode?: "ssr" | "client";               // default "ssr"
  minSkeletonMs?: number;                // default 150
  config: {
    defaultSort: string;
    defaultDir?: SortDirection;
    sortableColumns: readonly string[];
    buildFilterParams?: (filters: Partial<TFilters>, sp: URLSearchParams) => void;
  };
}) {
  const router = useRouter();
  const [navPending, startNavTransition] = useTransition();
  const [forceSkeleton, setForceSkeleton] = useState(false);
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minMs = options.minSkeletonMs ?? 150;

  // … 250ms search debounce ref …
  // … floor enforcement: when navigate fires, set forceSkeleton=true,
  //   schedule clear in minMs; the actual `navPending` is OR'd with forceSkeleton.

  const navigate = (url: string) => {
    setForceSkeleton(true);
    if (skeletonTimer.current) clearTimeout(skeletonTimer.current);
    skeletonTimer.current = setTimeout(() => setForceSkeleton(false), minMs);

    if (options.mode === "client") {
      // URL mirror only; no SSR roundtrip
      router.replace(url, { scroll: false });
    } else {
      startNavTransition(() => {
        router.replace(url, { scroll: false });
      });
    }
  };

  // … onSort, contextValue, return shape …
  return { /* … context value + Provider component */ };
}
```

`[CITED: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md:44-47 — router.replace + scroll false]`
`[CITED: node_modules/@types/react/index.d.ts:1878 — useTransition signature]`
`[CITED: node_modules/@types/react/index.d.ts:1832 — TransitionFunction returns void | Promise<void>]`

### Pattern 3: Server Page Drills URL State as Props (NOT useSearchParams)

**What:** Page-level server component awaits `searchParams`, parses, and passes
URL state down as plain string props (`search="oak"`, `sort="address"`, etc.)
to the client island.

**When to use:** Always in this phase. Avoids the `useSearchParams` Suspense
trap (see Common Pitfalls).

**Why this works in Next 16:** The `searchParams` Promise is awaited in the
async server component — this opts the page into dynamic rendering at request
time `[CITED: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:119]`,
so static prerender doesn't apply. The client island receives plain strings,
needs no Suspense boundary, and the existing `prospects-table.tsx` proves
this works (26 tests green as of 2026-04-30).

**Source pattern (verbatim from `properties/page.tsx:42-58`):**
```typescript
export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    // … per-page filter keys
  }>;
}) {
  const parsed = parseProspectsSearch(await searchParams);
  const { page, search, sort, dir, filters } = parsed;
  // … fetch data, render <ProspectsTable {...allTheProps} />
}
```

### Anti-Patterns to Avoid

- **Don't mirror server props in `useState`.** The existing pattern uses
  `defaultValue=` on the search input (uncontrolled) — re-renders from
  `router.refresh()` don't clobber the user's mid-keystroke text. New
  `<TableToolbar.Search>` MUST preserve this. `[VERIFIED: prospects-table.tsx:147-153 + feedback_no_usestate_mirror_of_server_props.md]`
- **Don't use `useSearchParams` at the top of the consumer client island
  without a Suspense boundary.** Next 16 production builds will fail with
  "Missing Suspense boundary with useSearchParams" if the route is statically
  prerendered. Server-side prop drilling avoids this entirely. `[CITED: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md:178-182]`
- **Don't use `Object.assign(Component, { Sub: ... })` for compound
  subcomponents.** The repo uses flat exports. Stay consistent.
- **Don't skip `router.refresh()` in `ssr` mode.** `replace` updates URL,
  `refresh` re-fetches server data — both required when data depends on the
  query. `[VERIFIED: feedback_no_usestate_mirror_of_server_props.md]`
  *Note:* The existing `prospects-table.tsx` calls `router.replace` only and
  relies on the page re-render triggered by route change to refetch. This works
  because the page is a server component and Next.js automatically re-renders
  it on navigation. The hook should match this behavior in `ssr` mode (omit
  explicit `router.refresh()` unless a future regression appears).
- **Don't trigger SSR in `client` mode.** `/jobs` realtime channel must remain
  the source of truth; an SSR roundtrip would clobber the realtime state.
- **Don't put `useTransition` outside the hook.** Consumers should not call
  `useTransition` themselves; the hook owns it so the 150ms floor (D-05) is
  centrally enforced.

## Migration Targets — Deep Dive

### `/properties` — Source pattern AND first migration target (D-11)

**Files:**
- `src/app/(dashboard)/properties/page.tsx` (321 lines, server component)
- `src/app/(dashboard)/properties/prospects-table.tsx` (1,258 lines, client component)
- `src/app/(dashboard)/properties/prospects-query.ts` (226 lines, pure helpers)
- `src/app/(dashboard)/properties/prospects-query.test.ts` (340 lines, 35 tests)
- `src/app/(dashboard)/properties/prospects-table.test.tsx` (640 lines, 26 tests)

**Current structure (already correct shape — just needs to consume new primitives):**
- `page.tsx:42-58` awaits `searchParams`, parses via `parseProspectsSearch`,
  drills `{ search, sort, dir, filters }` as props.
- `prospects-table.tsx:124-160` owns the `useRouter`, two `useTransition`s,
  search-input ref, debounce timer, `navigate` helper.
- `prospects-table.tsx:155-159` is the `navigate` function — exact pattern the
  new hook needs to encapsulate.
- `prospects-table.tsx:199-214` is `onSearchChange` (the 250ms debounce loop).
- `prospects-table.tsx:227-239` is `onSortClick` (column flip + page=1 reset).
- `prospects-table.tsx:244-255` is `updateFilters` (partial filter patch).
- `prospects-table.tsx:260-276` is `clearAllFilters`.
- `prospects-table.tsx:673-708` is the toolbar's rounded-card layout (the
  visual the new `<TableToolbar>` ports).
- `prospects-table.tsx:740-745` shows `<SortableHeader>` consumer-side usage.
- `prospects-table.tsx:752-782` is the skeleton swap markup.
- `prospects-table.tsx:859-892` is the existing inline `<SortableHeader>` —
  EXTRACT THIS verbatim into `src/components/table/sortable-header.tsx`.

**Migration tasks (no behavior change):**
1. Move `SORTABLE_COLUMNS`, `DEFAULT_SORT`, `DEFAULT_DIR` parse/build helpers
   from `prospects-query.ts` into the generic `use-table-url-state.ts` API.
   `prospects-query.ts` stays for `formatFullAddress`, `computeEngagement`,
   `truncateMessagePreview`, `KNOWN_MARKETS` (those are domain-specific to the
   prospects page and out of scope for the generic table primitives).
2. Replace lines 124-276 (the navigate machine) with `useTableUrlState({
   basePath: "/properties", parsed, mode: "ssr", config: { defaultSort:
   "created_at", sortableColumns: SORTABLE_COLUMNS, buildFilterParams: ... } })`.
3. Replace lines 673-708 (toolbar rounded card) with `<TableToolbar>
   <TableToolbarSearch /> <ProspectFilters /> </TableToolbar>` — `<ProspectFilters>`
   stays inside `prospects-table.tsx` (not extracted; it's domain-specific).
4. Replace lines 740-745 with the new `<SortableHeader>` import.
5. Delete the inline `function SortableHeader` at lines 859-892.
6. Run `prospects-query.test.ts` (35 tests) — keep ALL 35 passing.
7. Run `prospects-table.test.tsx` (26 tests) — keep ALL 26 passing.

**Critical regression risk:** The 26 RTL tests assert exact `routerReplace.mock.calls[0][0]`
URL strings. The new hook MUST produce byte-identical URLs to the existing
`buildProspectsHref` for the prospects-page filter set. The generic
`buildTableHref` accepts a `buildFilterParams` callback that the
`/properties` consumer wires to emit `?vacant=1&cass=verified&engagement=contacted&market=Kansas+City&assignee=...`
in the same stable order as today.

### `/lists` — Greenfield migration target

**Files:**
- `src/app/(dashboard)/lists/page.tsx` (191 lines, server component, no client island)
- `src/app/(dashboard)/lists/create-list-form.tsx` (existing — unaffected)
- `src/app/(dashboard)/lists/list-row-actions.tsx` (existing — unaffected)
- `src/app/(dashboard)/lists/lists.integration.test.ts` (existing — unaffected)

**Current structure (lines 23-97 — ListsPage server component):**
- Fetches `lists` (line 33-41) ordered `system_managed DESC, name ASC`.
- Fetches `property_lists` for member counts (line 41-42).
- Splits into `active` and `archived` arrays (lines 50-51).
- Renders TWO `<ListTable>` sections (active + archived) with no shared toolbar.
- Inline `<ListTable>` function at lines 99-190 with hard-coded `<TableHead>` cells.

**What needs to change (concrete regions):**

| Region | Current | After migration |
|--------|---------|-----------------|
| `lists/page.tsx:23` async function signature | No `searchParams` prop | Add `searchParams: Promise<{ page?, search?, sort?, dir? }>` |
| `lists/page.tsx:33-41` Supabase query | Fixed sort `system_managed DESC, name ASC` | Server-rendered sort uses parsed sort/dir; default still `name ASC` (most useful for VAs); secondary tie-breaker `id ASC` |
| `lists/page.tsx:50-51` active/archived split | Two arrays | New `<TableToolbar.FilterPill>` for "Show archived" toggle (replaces the section split); URL param `?archived=1` |
| `lists/page.tsx:54-94` JSX | Two `<section>`s with inline `<ListTable>` | One `<ListsView>` client island consuming the hook |
| `lists/page.tsx:99-190` inline `<ListTable>` | Plain `<TableHead>` cells | Extract to new client component `lists/lists-table.tsx`; `<TableHead>` cells become `<SortableHeader>` |

**New file required:** `src/app/(dashboard)/lists/lists-table.tsx` — the client
island. The page server component fetches data + parses URL state, drills props
into this new client component.

**Sortable columns proposal:** `name`, `members` (count), `created_at`. (System-managed pinning is preserved — the secondary order on `system_managed DESC` always applies, sort is on top of that.)

**Searchable column:** `name` (TABLE-02). Server-side `ilike("name", "%${search}%")`.

**Filter pill proposal:** "Show archived" (toggles `?archived=1`).

**Pagination:** Lists are typically <100 per org (system + custom). Decision-deferred to planner: pagination may be omitted if total < 50, but the `?page=` param should still be honored by the hook for consistency with the other tables.

### `/jobs` — Realtime + URL-state migration target (D-06/07/08)

**Files:**
- `src/app/(dashboard)/jobs/page.tsx` (29 lines, server component, very thin)
- `src/app/(dashboard)/jobs/jobs-list.tsx` (396 lines, client component, owns realtime)
- `src/app/(dashboard)/jobs/actions.ts` (existing — unaffected)
- `src/app/(dashboard)/jobs/retry-skip-trace-button.tsx` (existing — unaffected)
- `src/app/(dashboard)/jobs/retry-skip-trace-button.test.tsx` (existing — unaffected)
- No realtime test exists today; `actions.integration.test.ts` covers server actions only.

**Current structure (jobs-list.tsx):**
- Lines 48-105: realtime subscription side-effect — `useEffect` opens a Supabase
  channel `jobs:list`, hydrates from initial query (`order created_at DESC limit 50`),
  listens for `INSERT` / `UPDATE` / `DELETE`. `setJobs` mutates a `useState<Job[]>(jobs)`.
- Line 107-115: `loading` and `error` early returns.
- Lines 117-217: `<Table>` with hard-coded `<TableHead>` cells at lines 122-128
  ("Title", "Type", "Status", "Progress", "Created", "Actions").
- Lines 130-213: `<TableBody>` rendering `jobs.map(...)` with per-row Action buttons
  (Start CASS, Retry, Approve/Deny skip-trace, View details).

**What needs to change:**

| Region | Current | After migration |
|--------|---------|-----------------|
| `jobs/page.tsx:12-29` server component | Renders `<JobsList isAdmin={isAdmin} />` only | Awaits `searchParams`, parses URL state, passes `parsed` prop into `<JobsList>` |
| `jobs-list.tsx:48-105` realtime subscription | Sets jobs state directly | Unchanged — realtime is the source of truth (D-06) |
| `jobs-list.tsx:117` outer `<Table>` | Direct render | Wrap in `<TableToolbar>` + `<TableToolbar.Search>` for title/id; add `<TableToolbar.FilterPill>` for status filter |
| `jobs-list.tsx:122-128` `<TableHead>` cells | Plain | Replace with `<SortableHeader>` for Title, Type, Status, Created |
| `jobs-list.tsx:130-213` `jobs.map(...)` | Renders all 50 jobs unfiltered | Wrap in `useMemo` that applies URL state `{ search, sort, dir, status }` to the realtime array; render filtered slice |
| Skeleton (TABLE-06) | None | When `navPending=true`, render `<Skeleton>` rows in place of `jobs.map(...)`. The 150ms floor (D-05) makes this visible because in-memory filter is sub-frame. |

**New URL params:** `?search=` (matches title or `id.slice(0, 8)`), `?sort=`
(whitelist: `title`, `type`, `status`, `created_at`), `?dir=`, optional
`?status=` filter pill (queued / running / completed / failed / partial / pending_approval).

**Realtime + URL-state interaction (D-07 deep dive):**
- Realtime delivers `INSERT` / `UPDATE` / `DELETE`. `setJobs` mutates the array.
- URL state is a derived view: `useMemo(() => filterAndSort(jobs, { search, sort, dir, status }), [jobs, search, sort, dir, status])`.
- When realtime fires DURING `navPending=true`, the new row is inserted into
  `jobs` (the source array). On next render, `useMemo` re-runs and the filtered
  slice reflects both the URL state AND the new row. `navPending` clears after
  the 150ms floor; if a transition is still in flight (router.replace pending),
  React's transition machinery merges the realtime update.
- **Test contract MUST cover:** "an INSERT during active filter recomputes the
  visible slice on next render."

**Pagination:** `?page=` is decorative (D-08). The 50-row cap means page 1 only;
the hook still parses the param for URL consistency.

### `/templates` — Client filter migration target (D-09/10)

**Files:**
- `src/app/(dashboard)/templates/page.tsx` (35 lines, server component, fetches
  templates + categories)
- `src/app/(dashboard)/templates/templates-list.tsx` (207 lines, client component,
  owns existing useState filter)
- `src/app/(dashboard)/templates/actions.ts` (existing — provides `TemplateRow`,
  `listTemplates`, `listCategories`)
- `src/app/(dashboard)/templates/template-dialog.tsx` (existing — unaffected)
- `src/app/(dashboard)/templates/template-dialog.test.tsx` (existing — unaffected)

**Current structure (templates-list.tsx):**
- Line 26-32: `useState` for `search`, `categoryFilter`, `editingTemplate`.
- Lines 33-47: `useMemo` filters by search (lowercase substring on `name` +
  `content`) AND `categoryFilter` (exact match unless "all").
- Lines 49-76: Search input + category `<Select>` dropdown using local
  `useState` setters.
- Lines 78-138: Plain HTML `<table>` (NOT the shadcn `<Table>` — uses raw
  `<table>` / `<thead>` / `<tbody>`). Headers are NOT sortable today.

**What needs to change:**

| Region | Current | After migration |
|--------|---------|-----------------|
| `templates/page.tsx:8` async function | No `searchParams` | Add `searchParams: Promise<{ search?, category?, sort?, dir?, page? }>` and parse |
| `templates-list.tsx:26-28` `useState<search,categoryFilter>` | Local state | Removed; consumed from `useTableUrlState({ mode: "client", parsed })` |
| `templates-list.tsx:33-47` `useMemo` filter | Reads local state | Reads `{ search, sort, dir, filters: { category } }` from hook; applies sort too (currently just filter) |
| `templates-list.tsx:49-76` filter UX | Inline `<Input>` + `<Select>` | `<TableToolbar><TableToolbar.Search/><CategoryDropdownPill/></TableToolbar>`; the dropdown stays as a custom subcomponent because Base UI Select needs more than `<TableToolbar.FilterPill>`'s simple toggle UX |
| `templates-list.tsx:86-137` raw `<table>` | Plain HTML | Convert to shadcn `<Table>`; headers become `<SortableHeader>` (sortable on `name`, `category`, `updated_at`) |
| Skeleton (TABLE-06) | None | When `navPending=true` (incl. 150ms floor), render `<Skeleton>` rows |

**Sortable columns:** `name`, `category`, `updated_at`. Default: `updated_at DESC` (matches current server query at `actions.ts:79` which already orders by `updated_at DESC`).

**Searchable:** `name` + `content` lowercase substring (preserves existing UX
from line 35-42).

**Filter pill / dropdown:** `?category=Probate` — the existing `<Select>` UX
moves to a hook-aware dropdown. **Discretion (per D-10):** since `<TableToolbar.FilterPill>`
only models a binary toggle, the planner can either (a) extend it to support
a multi-option dropdown, or (b) keep the existing Base UI `<Select>` next to
`<TableToolbar.Search>` in the toolbar with its `value`/`onValueChange` wired
to hook state. Researcher recommends (b) — minimal new surface area, ports
the `templates-list.tsx:63-75` Select directly with `onValueChange` calling
`navigate(buildHref({ filters: { category: v === 'all' ? null : v } }))`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| URL param parsing | Custom `URL` constructor + manual coercion | `URLSearchParams` (browser-native) + `parseTableSearch` helper modeled on existing `parseProspectsSearch` | URLSearchParams handles arrays, encoding, edge cases; existing 35 tests prove the contract |
| Sort whitelist | Inline `if (sort === "name" || sort === "id" ...)` | `SORTABLE_COLUMNS = [...] as const` + `isSortableColumn()` type guard | Locks the type; defends against `?sort=password` injection class even though Supabase doesn't allow column injection |
| Search debounce | `useEffect([search]) → setTimeout` mirroring server prop into local state | Uncontrolled `<Input defaultValue=>` + `useRef<setTimeout>` cleared on unmount | Mirroring server props in `useState` freezes against `router.refresh` (`feedback_no_usestate_mirror_of_server_props.md`) |
| `useTransition` skeleton trigger | Custom `isLoading` boolean + Promise tracking | React 19 `useTransition` — `[navPending, startNavTransition] = useTransition()` | Native React API; integrates with Suspense, error boundaries, view transitions; supports async callback in React 19 |
| URL navigation | `window.history.pushState` | `router.replace(url, { scroll: false })` from `next/navigation` | Pushes onto Next router stack, triggers `searchParams` re-resolution, integrates with prefetch/transitions |
| Compound subcomponents | `Object.assign(Parent, { Child })` | Flat sibling exports | Repo convention — every primitive in `src/components/ui/` does this |
| Date formatting | Custom Date math | `date-fns/formatDistanceToNow` (already in repo, used at jobs-list.tsx:3, lists/page.tsx:1) | Already imported; consistent format across the app |

**Key insight:** Almost every problem in this phase has a solved precedent in
the existing `prospects-query.ts` + `prospects-table.tsx`. The phase is
EXTRACTION, not invention. The 226-line + 35-test source pattern is already
correct — generalize, don't re-author.

## Common Pitfalls

### Pitfall 1: useSearchParams Suspense trap

**What goes wrong:** Calling `useSearchParams()` at the top of a client component
that's rendered on a statically prerendered page → production build fails with
"Missing Suspense boundary with useSearchParams" error, or in dev silently
becomes client-side rendered (subtle SEO/perf regression).

**Why it happens:** `[CITED: node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md:178-182]`
"During production builds, a static page that calls `useSearchParams` from a
Client Component must be wrapped in a `Suspense` boundary."

**How to avoid:** Use the **server-prop drilling** pattern from
`prospects-table.tsx`. The server `page.tsx` awaits `searchParams` and passes
parsed state down as plain props. The client island never imports
`useSearchParams`. The `useTableUrlState` hook should accept the parsed prop,
NOT call `useSearchParams` itself.

**Warning signs:** Build error in CI, or `next dev` showing the page rendered
client-side. Detect early by running `npm run build` once after wiring up the
new hook.

**Why this works:** The `(dashboard)/*/page.tsx` server components all `await
searchParams` (a request-time API), which opts each page into dynamic rendering
`[CITED: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:119]`
— so the static-prerender-with-useSearchParams scenario doesn't apply. The
client island receives plain string props.

### Pitfall 2: Mirroring server props in `useState` clobbers user typing

**What goes wrong:** `const [searchInput, setSearchInput] = useState(search)`
where `search` is a server-driven prop. When `router.refresh` re-runs the page
and a new `search` prop arrives, `useState`'s initial value is ignored on
re-render → the user's mid-typing input is reset.

**Why it happens:** `useState`'s initializer only fires on mount. The hook
seems to mirror the server but doesn't.

**How to avoid:** Use `defaultValue=` on the `<Input>` (uncontrolled). Track
typing in a ref, debounce `router.replace`. The existing
`prospects-table.tsx:147-153` pattern is correct.

**Warning signs:** Test typing fast and observing input reset; or scrolling a
filter that triggers `router.refresh` while typing.

`[VERIFIED: feedback_no_usestate_mirror_of_server_props.md + prospects-table.tsx:147-153]`

### Pitfall 3: Race between debounced search and direct navigation

**What goes wrong:** User types "main", debounce timer is armed, then clicks
"Clear" or a sort header. The pending debounce fires AFTER the new navigation,
overwriting the URL with the stale search.

**Why it happens:** Debounce timer wasn't cleared on direct navigation.

**How to avoid:** Existing `prospects-table.tsx:201, 217-218` clears the timer
on every direct navigation event (clear button, sort click, filter pill).
The new hook MUST do the same — `navigate()` clears any pending search-debounce
timer before firing `router.replace`.

**Warning signs:** RTL test that types + immediately clicks Clear, asserts
exactly one `router.replace` call. Add this case to the new test contract.

### Pitfall 4: Skeleton flash when in-memory work is sub-frame (`client` mode)

**What goes wrong:** `/jobs` and `/templates` recompute filtered slices in
microseconds. `navPending` from `useTransition` may flip true and false in the
same React frame → no visible skeleton, no responsiveness affordance for the user.

**Why it happens:** `useTransition` only sustains `pending` while React is
actually working. In-memory filter on a 50-row array completes in <1ms.

**How to avoid:** D-05's `minSkeletonMs: 150` floor. Track an internal
`forceSkeleton` state. On `navigate()`, set `forceSkeleton=true` and
`setTimeout(() => setForceSkeleton(false), 150)`. The exposed `navPending`
is `transitionPending || forceSkeleton`.

**Warning signs:** Manual test on `/jobs` — type a search and watch for
skeleton flash. If it doesn't appear, the floor isn't engaging.

### Pitfall 5: Realtime INSERT during navPending corrupts visible slice

**What goes wrong:** A new job INSERTs while `/jobs` is navPending. The realtime
handler calls `setJobs([newRow, ...prev])`. If the filtered slice is computed
imperatively rather than via `useMemo([jobs, search, sort, dir, filters])`, the
new row may not appear, or worse, the displayed slice is stale.

**Why it happens:** The filter must be a derived state, not imperative.

**How to avoid:** ALWAYS compute filtered slice via `useMemo` whose deps
include both the source array AND every URL-state field. Realtime mutates the
source array → memo recomputes → display updates.

**Warning signs:** Manual test — open `/jobs`, set a filter, fire an action
that creates a matching job, observe whether it appears. RTL test should mock
the realtime `payload` and assert the filtered table shows it after the next
render.

### Pitfall 6: `searchParams` Promise sync access (Next 14 → 16 migration)

**What goes wrong:** `const { search } = props.searchParams` (no `await`) —
works in Next 14 but is deprecated in Next 15+ and may be removed.

**Why it happens:** Next 16 made `searchParams` a Promise.
`[CITED: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:115-118]`

**How to avoid:** Always `await searchParams` in async server components, OR
`use(searchParams)` in client components. The existing `properties/page.tsx:57`
uses `await searchParams` correctly. Match this on `/lists`, `/jobs`,
`/templates` server pages.

**Warning signs:** Type error or deprecation warning at build time.

### Pitfall 7: Stable secondary tie-breaker missing on pagination sort

**What goes wrong:** Sort by a non-unique column (e.g., `?sort=market`) without
a tie-breaker → pagination skips or repeats rows when many properties share the
sort value.

**How to avoid:** `properties/page.tsx:127-128` does `.order(sort, ...).order("id",
{ ascending: true })`. The new pages MUST include a stable secondary order on
the primary key. Wire this in `lists/page.tsx`, `jobs-list.tsx` (n/a — client
sort), `templates/page.tsx` (n/a — client sort).

**Warning signs:** Manual test — page through results sorted by `market`, count
rows, ensure no skips/repeats.

## Runtime State Inventory

> Phase 1 is a refactor (extract + migrate) but does NOT rename any persisted
> identifiers, env vars, secrets, or external service configurations.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — verified by review of REQUIREMENTS.md, CONTEXT.md, and source code. Phase 1 introduces new URL params (`?search=`, `?sort=`, etc.) but does not rename any database column, table, RLS policy, or stored ID. | None |
| Live service config | None — no n8n workflows, Datadog services, Supabase RPC names, Cloudflare Tunnel names, or third-party service identifiers are renamed. | None |
| OS-registered state | None — no Windows Task Scheduler, pm2, launchd, or systemd registrations reference table-toolbar code. | None |
| Secrets/env vars | None — no env var names changing. | None |
| Build artifacts | After migrating `prospects-table.tsx` to consume the new primitives, the file shrinks from 1,258 lines toward ~900 lines (the `<SortableHeader>` and toolbar markup move out). No stale package metadata. `next build` cache is invalidated automatically by file changes. | None — Vercel rebuilds clean |

## Code Examples

### Example 1: Pure helpers `parseTableSearch` + `buildTableHref` (testable in node env)

```typescript
// src/components/table/use-table-url-state.ts (excerpt — pure helpers)

export type SortDirection = "asc" | "desc";

const pickFirst = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export type ParseConfig<TFilters extends Record<string, unknown>> = {
  sortableColumns: readonly string[];
  defaultSort: string;
  defaultDir?: SortDirection;
  parseFilters?: (raw: Record<string, string | string[] | undefined>) => TFilters;
};

export type ParsedTableSearch<TFilters extends Record<string, unknown>> = {
  page: number;
  search: string | null;
  sort: string;
  dir: SortDirection;
  filters: TFilters;
};

export function parseTableSearch<TFilters extends Record<string, unknown>>(
  raw: Record<string, string | string[] | undefined>,
  config: ParseConfig<TFilters>,
): ParsedTableSearch<TFilters> {
  const defaultDir = config.defaultDir ?? "desc";

  const rawPage = Number(pickFirst(raw.page) ?? 1);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

  const rawSearch = (pickFirst(raw.search) ?? "").trim();
  const search = rawSearch.length === 0 ? null : rawSearch;

  const rawSort = pickFirst(raw.sort);
  const sort = (config.sortableColumns as readonly string[]).includes(rawSort ?? "")
    ? (rawSort as string)
    : config.defaultSort;

  const rawDir = pickFirst(raw.dir);
  const dir: SortDirection = rawDir === "asc" ? "asc" : defaultDir;

  const filters = (config.parseFilters?.(raw) ?? ({} as TFilters));

  return { page, search, sort, dir, filters };
}

export type BuildConfig<TFilters extends Record<string, unknown>> = {
  defaultSort: string;
  defaultDir?: SortDirection;
  buildFilterParams?: (
    filters: Partial<TFilters>,
    sp: URLSearchParams,
  ) => void;
};

export function buildTableHref<TFilters extends Record<string, unknown>>(
  parts: {
    page?: number;
    search?: string | null;
    sort?: string;
    dir?: SortDirection;
    filters?: Partial<TFilters>;
  },
  config: BuildConfig<TFilters>,
): string {
  const defaultDir = config.defaultDir ?? "desc";
  const sp = new URLSearchParams();
  if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
  if (parts.search && parts.search.length > 0) sp.set("search", parts.search);
  if (parts.sort && parts.sort !== config.defaultSort) sp.set("sort", parts.sort);
  if (parts.dir && parts.dir !== defaultDir) sp.set("dir", parts.dir);
  if (parts.filters) {
    config.buildFilterParams?.(parts.filters, sp);
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}
```

`[CITED: src/app/(dashboard)/properties/prospects-query.ts — proven pattern]`

### Example 2: Hook with `ssr` mode

```typescript
// src/components/table/use-table-url-state.ts (excerpt — hook)

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export function useTableUrlState<TFilters extends Record<string, unknown>>(options: {
  basePath: string;
  parsed: ParsedTableSearch<TFilters>;
  mode?: "ssr" | "client";
  minSkeletonMs?: number;
  config: BuildConfig<TFilters> & { sortableColumns: readonly string[] };
}) {
  const { basePath, parsed, mode = "ssr", minSkeletonMs = 150, config } = options;
  const { search, sort, dir, page, filters } = parsed;

  const router = useRouter();
  const [transitionPending, startNavTransition] = useTransition();
  const [forceSkeleton, setForceSkeleton] = useState(false);
  const skeletonTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (skeletonTimer.current) clearTimeout(skeletonTimer.current);
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    },
    [],
  );

  const navigate = React.useCallback(
    (url: string) => {
      // Clear any pending search debounce so direct nav wins.
      if (searchDebounce.current) {
        clearTimeout(searchDebounce.current);
        searchDebounce.current = null;
      }
      // Engage the 150ms skeleton floor.
      setForceSkeleton(true);
      if (skeletonTimer.current) clearTimeout(skeletonTimer.current);
      skeletonTimer.current = setTimeout(
        () => setForceSkeleton(false),
        minSkeletonMs,
      );

      if (mode === "client") {
        router.replace(url, { scroll: false });
      } else {
        startNavTransition(() => {
          router.replace(url, { scroll: false });
        });
      }
    },
    [mode, minSkeletonMs, router],
  );

  const buildHref = React.useCallback(
    (parts: Parameters<typeof buildTableHref<TFilters>>[0]) =>
      buildTableHref(parts, config),
    [config],
  );

  const onSort = React.useCallback(
    (column: string) => {
      const nextDir: SortDirection =
        sort === column ? (dir === "asc" ? "desc" : "asc") : "asc";
      navigate(
        `${basePath}${buildHref({
          page: 1,
          search,
          sort: column,
          dir: nextDir,
          filters,
        })}`,
      );
    },
    [sort, dir, search, filters, basePath, navigate, buildHref],
  );

  const debouncedSearch = React.useCallback(
    (next: string, ms = 250) => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
      searchDebounce.current = setTimeout(() => {
        const trimmed = next.trim();
        navigate(
          `${basePath}${buildHref({
            page: 1,
            search: trimmed.length === 0 ? null : trimmed,
            sort,
            dir,
            filters,
          })}`,
        );
      }, ms);
    },
    [navigate, basePath, buildHref, sort, dir, filters],
  );

  const navPending = transitionPending || forceSkeleton;

  return {
    search: search ?? "",
    sort,
    dir,
    page,
    filters,
    navPending,
    navigate,
    onSort,
    debouncedSearch,
    buildHref,
    basePath,
  };
}
```

`[CITED: prospects-table.tsx:124-276 — proven pattern + node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md:44]`

### Example 3: Server page consuming the parser

```typescript
// src/app/(dashboard)/lists/page.tsx (after migration)
import { parseTableSearch } from "@/components/table/use-table-url-state";
import { ListsView } from "./lists-view";

const SORTABLE_COLUMNS = ["name", "members", "created_at"] as const;

type ListsFilters = { archived: boolean };

export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    archived?: string;
  }>;
}) {
  const raw = await searchParams;
  const parsed = parseTableSearch<ListsFilters>(raw, {
    sortableColumns: SORTABLE_COLUMNS,
    defaultSort: "name",
    defaultDir: "asc",
    parseFilters: (r) => ({
      archived: r.archived === "1" || r.archived === "true",
    }),
  });

  // … Supabase query w/ parsed.search, parsed.sort, parsed.dir, parsed.filters.archived …
  // Always include secondary tie-breaker: .order("id", { ascending: true })

  return (
    <Page>
      <PageHeader breadcrumb={[...]} title="Lists" description={...} />
      <CreateListForm />
      <ListsView lists={lists} parsed={parsed} totalActive={...} totalArchived={...} />
    </Page>
  );
}
```

### Example 4: SortableHeader (extracted verbatim)

```typescript
// src/components/table/sortable-header.tsx
"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";

import type { SortDirection } from "./use-table-url-state";

export function SortableHeader<TColumn extends string>({
  column,
  current,
  dir,
  onClick,
  children,
  testIdPrefix,
}: {
  column: TColumn;
  current: TColumn | string;
  dir: SortDirection;
  onClick: (col: TColumn) => void;
  children: React.ReactNode;
  testIdPrefix?: string;
}) {
  const isActive = current === column;
  const Icon = isActive ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className="select-none">
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}
        data-testid={testIdPrefix ? `${testIdPrefix}-sort-${column}` : `sort-${column}`}
        className={`hover:text-foreground flex items-center gap-1 text-left text-xs font-bold tracking-widest uppercase ${
          isActive ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        <span>{children}</span>
        <Icon className="size-3 opacity-70" aria-hidden />
      </button>
    </TableHead>
  );
}
```

`[VERIFIED: lifted from prospects-table.tsx:859-892, generic'd over column type. Existing data-testid scheme — `prospects-sort-${column}` — preserved via testIdPrefix prop so the 26 existing prospects-table tests continue to pass.]`

## Test Contract Translation

The existing 35 + 26 = 61 tests on `/properties` form the contract. Each existing
test maps to one of three new locations OR stays in `prospects-table.test.tsx`:

| Existing test (file:describe) | Existing assertion | New home | Adapt? |
|-------------------------------|-------------------|----------|--------|
| `prospects-query.test.ts` › `parseProspectsSearch` › "returns defaults when raw is empty" | Defaults shape | `use-table-url-state.test.ts` › `parseTableSearch` › "returns defaults when raw is empty" | Yes — generic over filters |
| `prospects-query.test.ts` › `parseProspectsSearch` › "clamps invalid pages to 1" | Page coercion | `use-table-url-state.test.ts` (same) | No — copy verbatim |
| `prospects-query.test.ts` › `parseProspectsSearch` › "trims whitespace on search" | Trim + null collapse | `use-table-url-state.test.ts` (same) | No — copy verbatim |
| `prospects-query.test.ts` › `parseProspectsSearch` › "whitelists sort columns" | Whitelist guard | `use-table-url-state.test.ts` (same) | Yes — uses generic config |
| `prospects-query.test.ts` › `parseProspectsSearch` › "only accepts 'asc' for dir" | Dir collapse | `use-table-url-state.test.ts` (same) | No — copy verbatim |
| `prospects-query.test.ts` › `parseProspectsSearch` › "handles array-style searchParams" | `pickFirst` | `use-table-url-state.test.ts` (same) | No — copy verbatim |
| `prospects-query.test.ts` › `buildProspectsHref` › all 4 tests | URL build invariants | `use-table-url-state.test.ts` › `buildTableHref` | Yes — generic; prospects-specific cases stay in `prospects-query.test.ts` |
| `prospects-query.test.ts` › `parseProspectsSearch — filters` (8 tests) | vacant/cass/engagement/market/assignee/known-markets | **STAYS in `prospects-query.test.ts`** | No — these are domain-specific filter parsers; they call into a `parseFilters` callback that's specific to /properties |
| `prospects-query.test.ts` › `buildProspectsHref — filters` (5 tests) | Domain-specific filter URLs | **STAYS in `prospects-query.test.ts`** | No — same reason |
| `prospects-query.test.ts` › `computeEngagement` (3 tests) | Engagement derivation | **STAYS in `prospects-query.test.ts`** | No — domain-specific |
| `prospects-query.test.ts` › `truncateMessagePreview` (5 tests) | Truncation | **STAYS in `prospects-query.test.ts`** | No — domain-specific |
| `prospects-query.test.ts` › `formatFullAddress` (5 tests) | Address formatting | **STAYS in `prospects-query.test.ts`** | No — domain-specific |
| `prospects-table.test.tsx` › `<ProspectsTable />` (4 tests — render, Actions, bulk add, menu) | Bulk action wiring | **STAYS in `prospects-table.test.tsx`** | No — domain |
| `prospects-table.test.tsx` › engagement column (3 tests) | Pill rendering | **STAYS** | No — domain |
| `prospects-table.test.tsx` › last message preview column (2 tests) | Cell rendering | **STAYS** | No — domain |
| `prospects-table.test.tsx` › sortable headers (2 tests — click default, flip active) | Sort URL building | `sortable-header.test.tsx` (sort URL building moves to hook test); **STAYS** in `prospects-table.test.tsx` for the integration check | Both — keep in prospects-table.test.tsx that the integration still produces "/properties?sort=..." URL; new sortable-header.test.tsx asserts the icon state + onClick callback fires with column name |
| `prospects-table.test.tsx` › address search (2 tests — debounce, X button) | 250ms debounce + clear | `table-toolbar.test.tsx` (the toolbar's Search subcomponent owns this behavior); **STAYS** in `prospects-table.test.tsx` for end-to-end (typing → URL) | Both |
| `prospects-table.test.tsx` › quick filters (6 tests — Vacant, Verified, Contacted toggles, clear-all visibility, clear preserves) | Filter pill behavior | `table-toolbar.test.tsx` for the FilterPill primitive in isolation; **STAYS** in `prospects-table.test.tsx` for the prospects-specific filter set | Both |
| `prospects-table.test.tsx` › select-all-across-pages banner (5 tests) | Cross-page selection | **STAYS** | No — domain |

**Net result:**

- `src/components/table/use-table-url-state.test.ts` (NEW, ~30 tests):
  generic parse/build, hook navigate semantics, debounce, sort flipping,
  150ms skeleton floor, ssr vs client mode behavior parity.
- `src/components/table/table-toolbar.test.tsx` (NEW, ~10 tests):
  `<TableToolbar.Search>` renders + debounces + clears; `<TableToolbar.FilterPill>`
  renders + click + active styling.
- `src/components/table/sortable-header.test.tsx` (NEW, ~6 tests):
  click fires onClick with column; active vs inactive icon; aria-sort attribute;
  flip dir asc → desc.
- `prospects-query.test.ts` (EXISTING, 35 tests minus the ~10 generic ones that
  move out): retains domain-specific filter parser tests + computeEngagement +
  truncateMessagePreview + formatFullAddress.
- `prospects-table.test.tsx` (EXISTING, all 26 tests stay green; some now
  assert via the new `<TableToolbar>` markup but the routerReplace.mock.calls
  invariants are unchanged).
- `lists/lists-view.test.tsx` (NEW, ~3 tests): renders toolbar + sortable
  headers; click search → routerReplace called with `/lists?search=...`;
  click archived pill → `?archived=1`.
- `jobs/jobs-list.test.tsx` (NEW, ~5 tests): renders toolbar; click sort →
  routerReplace; status filter pill toggles URL; in-memory filter applies to
  realtime array; INSERT during navPending appears in next render.
- `templates/templates-list.test.tsx` (NEW, ~4 tests): renders toolbar; search
  filters in-memory; category filter URL roundtrip; sort applies to in-memory
  array.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `searchParams: { ... }` (sync prop) | `searchParams: Promise<{ ... }>` | Next 15.0.0-RC | Must `await` or `use()`; `properties/page.tsx:57` already correct |
| `useTransition(callback)` returning sync only | `useTransition(callback)` returning `void \| Promise<void>` | React 19 | Allows async server-action calls inside transition; verified at `node_modules/@types/react/index.d.ts:1832` |
| `next/router` `useRouter` | `next/navigation` `useRouter` | Next 13 (App Router) | All migration target client islands already use `next/navigation` |
| `dynamic = 'force-dynamic'` route segment config | `await connection()` in server component | Next 15+ | Not relevant — Phase 1 routes already opt into dynamic via `await searchParams` |
| Class-based hand-rolled URL state machines | React 19 `useTransition` + native `URLSearchParams` | React 18+ | Phase 1 follows this — no class refactor |

**Deprecated/outdated:**
- Sync `searchParams` access — works in Next 15 with deprecation warning;
  removed in a future major. Don't introduce new sync access. `[CITED: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:117-118]`

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Per-page filter pill set proposals (Lists: "Show archived"; Jobs: status; Templates: category) are reasonable starting points | "Migration Targets" | Planner / discuss-phase may add or remove pills; low impact because each is a single FilterPill component instance |
| A2 | `<TableToolbar.FilterPill>` will be a binary toggle and `/templates` keeps a separate Base UI Select for category dropdown | "Migration Targets — /templates" | If planner wants a unified dropdown-style FilterPill, expand the FilterPill API; affects ~50 lines of component code |
| A3 | Sort columns proposals — Lists: name/members/created_at; Jobs: title/type/status/created_at; Templates: name/category/updated_at | "Migration Targets" | Planner may pick different columns; only affects the `SORTABLE_COLUMNS` const per page |
| A4 | The hook's typed-generic filter API (`useTableUrlState<TFilters>`) is preferred over loose `Record<string, string \| null>` | "Claude's Discretion" recommendation | If loose typing is preferred, the API simplifies but loses compile-time guards on per-page filter shapes |
| A5 | `<TableToolbar>` should match the existing rounded-card visual `border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3` from `prospects-table.tsx:673` | "Pattern 1: Compound Component" | Visual mismatch on the consumer pages if a different design is intended; would need design review |
| A6 | The 150ms floor (D-05) is implemented as `forceSkeleton` state OR'd with `transitionPending`, NOT as a delay before `router.replace` | "Pattern 2: Context-Based Hook Wiring" | If the floor is implemented as a navigation delay instead, the URL update appears slow to the user. Confirmed with `prospects-table.tsx` semantics: skeleton must be visible regardless of how fast the underlying work finishes |
| A7 | `lists/page.tsx` will be split: the page server component plus a new `lists-view.tsx` client island. Active/archived split UI moves from two `<section>` wrappers to a single `<TableToolbar.FilterPill>` toggle | "Migration Targets — /lists" | If product wants to keep the visual distinction between active/archived sections, the migration could keep two table sections each with their own toolbar — but that's a bigger UX change and contradicts TABLE-01's "unified toolbar" intent |

**If the user wants to confirm any assumption before planning:**
A2 and A7 are the highest-risk because they affect component API surface and
page structure. The others are content/config choices that the planner can
adjust.

## Open Questions

1. **Should `<TableToolbar.FilterPill>` support a dropdown/select variant, or stay binary-toggle only?**
   - What we know: D-01 names `<TableToolbar.FilterPill>`; D-10 says `?category=` migrates from local state; the existing template page uses Base UI Select.
   - What's unclear: Whether the planner wants one unified pill API or two (toggle + dropdown).
   - Recommendation: Ship binary `<TableToolbar.FilterPill>` first (matches existing
     prospects FilterToggle at `prospects-table.tsx:1198-1223`); for `/templates`
     category, keep Base UI `<Select>` next to the toolbar with `value` /
     `onValueChange` wired to hook state. If a future phase needs cross-table
     dropdown filter pills, extend the API then.

2. **Does the new `useTableUrlState` hook own a `<Provider>` component, or is the context implicit?**
   - What we know: D-03 says `<TableToolbar.Search>` wires itself to the hook
     "via context (no manual prop forwarding)".
   - What's unclear: Whether the hook returns a `Provider` component the consumer
     mounts, or whether the consumer wraps `<TableToolbar>` and the toolbar reads
     the hook return as its first child via context.
   - Recommendation: The hook returns `{ ...state, Provider: TableUrlStateProvider }`.
     Consumer does `<ts.Provider value={ts}><TableToolbar>...</TableToolbar></ts.Provider>`.
     Or — simpler — `<TableToolbar>` itself accepts a `state={ts}` prop and provides
     the context internally. Researcher prefers the latter (one less wrapper).

3. **Hook test framework: do we mock `next/navigation` for the hook unit tests, or is the hook itself testable in node?**
   - What we know: vitest config has node env for `*.test.ts` and jsdom for `*.test.tsx`.
   - What's unclear: The hook uses `useRouter` which requires React + DOM context.
   - Recommendation: Pure helpers (`parseTableSearch`, `buildTableHref`) live in
     `*.test.ts` (node). The hook itself is tested in `*.test.tsx` (jsdom) via
     `renderHook` from `@testing-library/react` with mocked `next/navigation`,
     matching the `prospects-table.test.tsx` mock at lines 15-28.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | dev / build / test | ✓ | engines.node `>=22` | — |
| Next.js | App Router, useRouter, server components | ✓ | 16.2.4 | — |
| React | useTransition, useState, useRef, useEffect, createContext | ✓ | 19.2.4 | — |
| TypeScript | Type generics on filters | ✓ | ^5 | — |
| Vitest | Unit + RTL test runner | ✓ | ^4.1.5 | — |
| @testing-library/react | RTL | ✓ | ^16.3.2 | — |
| @testing-library/user-event | userEvent for typing/clicks | ✓ | ^14.6.1 | — |
| jsdom | Test DOM env | ✓ | ^29.1.0 | — |
| Supabase realtime (`/jobs` only) | jobs-list realtime channel | ✓ (in client at runtime) | @supabase/supabase-js ^2.104.0 | — |
| lucide-react | Icons | ✓ | ^1.8.0 | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

All required infrastructure is already installed and exercised by the existing
`/properties` source pattern.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `vitest@4.1.5` (two configs: `vitest.config.ts` for node `*.test.ts`, `vitest.rtl.config.ts` for jsdom `*.test.tsx`) |
| Config file | `vitest.config.ts` (default), `vitest.rtl.config.ts` (RTL), `vitest.integration.config.ts` (Postgres-backed) |
| Quick run command | `npm test` (node-env unit tests) |
| RTL run command | `npm run test:rtl` |
| Full suite command | `npm run verify` (typecheck + node tests + RTL tests) |
| Phase gate | Full suite green before `/gsd-verify-work` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TABLE-01 | Toolbar renders on `/lists` | RTL | `npx vitest run --config vitest.rtl.config.ts src/app/(dashboard)/lists/lists-view.test.tsx` | ❌ Wave 0 |
| TABLE-01 | Toolbar renders on `/jobs` | RTL | `npx vitest run --config vitest.rtl.config.ts src/app/(dashboard)/jobs/jobs-list.test.tsx` | ❌ Wave 0 |
| TABLE-01 | Toolbar renders on `/templates` | RTL | `npx vitest run --config vitest.rtl.config.ts src/app/(dashboard)/templates/templates-list.test.tsx` | ❌ Wave 0 |
| TABLE-01 | Toolbar renders on `/properties` (regression) | RTL | `npx vitest run --config vitest.rtl.config.ts src/app/(dashboard)/properties/prospects-table.test.tsx` | ✅ |
| TABLE-02 | Free-text search routes user typing → debounced URL update | RTL | per-consumer test files above + `src/components/table/table-toolbar.test.tsx` | ❌ Wave 0 (toolbar test); ✅ (existing prospects test) |
| TABLE-03 | Click sort header → URL has `?sort=col&dir=asc`; click again → flip; icon reflects state | RTL | `src/components/table/sortable-header.test.tsx` + per-consumer page tests | ❌ Wave 0; existing `prospects-table.test.tsx` › sortable headers PASSES today |
| TABLE-04 | Sort + search state in URL params (parse round-trip) | unit (node) | `npx vitest run src/components/table/use-table-url-state.test.ts` | ❌ Wave 0 |
| TABLE-04 | URL params survive back-button + refresh | RTL + manual Playwright (verify-phase) | `src/components/table/use-table-url-state.test.ts` (parse/build invariants) + Playwright happy-path | ❌ Wave 0 (hook test); Playwright handled in verify phase |
| TABLE-05 | Pagination links preserve sort + search | unit | `use-table-url-state.test.ts` › "buildTableHref preserves all params on pagination" + RTL on /lists, /properties | ❌ Wave 0 |
| TABLE-06 | Skeleton loader during URL nav (with 150ms floor) | RTL | `use-table-url-state.test.ts` (timer-based) + per-consumer test asserts skeleton renders during navPending | ❌ Wave 0; existing `prospects-table.test.tsx` already asserts skeleton — extend to /lists, /jobs, /templates |
| TABLE-07 | New files exist at `src/components/table/` | static | `ls src/components/table/{table-toolbar.tsx,sortable-header.tsx,use-table-url-state.ts}` (assertion in plan-checker / verify) | ❌ Wave 0 |

### Sampling Rate (Nyquist)

- **Per task commit:** Run only the touched test file (e.g.,
  `npx vitest run --config vitest.rtl.config.ts src/components/table/use-table-url-state.test.ts`)
  — quick green check, < 5s.
- **Per wave merge:** `npm run verify` (typecheck + all unit + all RTL) — full
  green before merging the wave.
- **Phase gate:** `npm run verify` PLUS Playwright golden paths on each consumer
  page before `/gsd-verify-work`.

### Sampling Boundaries (the specific behaviors that MUST be sampled)

#### URL parse/build invariants

- **B1 — Column whitelist guards:** `?sort=password` collapses to default. Test:
  `parseTableSearch({ sort: "password" }, { sortableColumns: ["name", "id"], defaultSort: "name" }).sort === "name"`.
- **B2 — Default-direction stripping:** `buildTableHref({ dir: "desc" }, { defaultSort: "x", defaultDir: "desc" }) === ""`.
- **B3 — Default-sort stripping:** `buildTableHref({ sort: "x" }, { defaultSort: "x" }) === ""`.
- **B4 — `?page=1` elision:** `buildTableHref({ page: 1 }, ...) === ""`. `?page=2`
  emits.
- **B5 — Empty/whitespace search collapses to null:** `parseTableSearch({ search: "  " }, ...).search === null`.
- **B6 — Trim preserves internal whitespace:** `parseTableSearch({ search: "  Main St  " }, ...).search === "Main St"`.
- **B7 — Array searchParams take first value:** `parseTableSearch({ sort: ["x", "y"] }, ...).sort === "x"`.
- **B8 — Special-character search is URL-encoded:** `buildTableHref({ search: "5th & Vine" }, ...) === "?search=5th+%26+Vine"`.

#### Debounce timing boundaries

- **B9 — Typing fast (< 250ms between keystrokes):** Type "Main St" letter-by-letter
  in 50ms intervals; assert `routerReplace` called exactly once after the final
  keystroke + 250ms.
- **B10 — Typing slow (> 250ms gap):** Type "M", wait 300ms, type "ain";
  assert `routerReplace` called twice with cumulative inputs.
- **B11 — Direct nav cancels pending search debounce:** Type "Mai", click sort
  header before 250ms elapses; assert exactly one `routerReplace` call (the sort
  click), search debounce was canceled. **Critical for Pitfall 3.**
- **B12 — Clear button cancels pending debounce:** Type "Mai", click clear button;
  assert one `routerReplace` call (the clear), no stale search update.

#### Skeleton timing (D-05 floor)

- **B13 — Faster than 150ms:** `client` mode in-memory work finishes in 1 frame;
  navPending stays true for at least 150ms. Test: `vi.useFakeTimers()`, fire
  navigate, advance 100ms, assert `navPending === true`; advance to 200ms total,
  assert `navPending === false`.
- **B14 — Slower than 150ms (ssr mode):** Mock router.replace to take 500ms;
  navPending stays true the whole time, then 150ms+ floor still applies.
- **B15 — Exactly 150ms:** Edge case — at exactly 150ms after navigate, navPending
  may transition from true to false; ensure no flicker.

#### SSR vs client mode behavior parity

- **B16 — Both modes emit identical URLs:** For the same `{ search, sort, dir, filters }`,
  `buildTableHref` produces identical strings regardless of mode. (This is by
  construction — the helper is mode-agnostic — but a regression-guard test locks it.)
- **B17 — `client` mode does NOT trigger transition:** In `client` mode, `navigate()`
  calls `router.replace` synchronously (no `startTransition` wrapper) so an SSR
  roundtrip is not triggered.
- **B18 — `ssr` mode wraps in transition:** In `ssr` mode, `navigate()` is inside
  `startTransition`, so `transitionPending` flips true during the call.
- **B19 — Both modes set 150ms `forceSkeleton` floor:** Both modes return
  `navPending === true` for at least 150ms after `navigate()`.

#### Hydration boundaries

- **B20 — Server-rendered URL state matches client first paint:** Server
  `page.tsx` parses `?search=oak` → renders `<input defaultValue="oak">`;
  client hydrates with same `defaultValue`; no React hydration warning. (RTL
  test renders the consumer with parsed prop and asserts input value matches.)
- **B21 — `defaultValue` does not freeze against `router.refresh`:** Render with
  `search="oak"`; trigger a fake `router.refresh` (re-render with different prop);
  assert input still shows the user's last-typed value if mid-edit (uncontrolled
  semantics). **Critical for Pitfall 2 / `feedback_no_usestate_mirror_of_server_props.md`.**

#### Realtime + URL-state interaction (`/jobs` only)

- **B22 — INSERT during active filter recomputes visible slice on next render:**
  Render `<JobsList>` with parsed `{ search: "import" }`. Initial array contains
  no matching rows. Mock realtime payload `INSERT` with title "import csv". Assert
  that on next render, the inserted row appears in the table body.
- **B23 — UPDATE that no longer matches filter removes from visible slice:**
  Render `<JobsList>` with parsed `{ status: "running" }`. Initial array contains
  job with status "running". Mock realtime payload `UPDATE` setting status to
  "completed". Assert row no longer appears.
- **B24 — DELETE during navPending removes from source AND filtered view:** Even
  while navPending, a DELETE removes the row from the source array; once
  navPending clears, the filtered slice (which is `useMemo`-derived) reflects
  the removal.
- **B25 — URL state changes do NOT clobber realtime array:** Type a search →
  `router.replace` fires (client mode, no SSR roundtrip) → realtime array
  unchanged → filtered view recomputes from URL state + array.

### Wave 0 Gaps

The following test infrastructure does not exist yet. These are pre-implementation
gaps that the planner must address in Wave 0 (test scaffolding before any
production code).

- [ ] `src/components/table/use-table-url-state.test.ts` — covers TABLE-04, plus
  boundaries B1-B19 (URL parse/build invariants, debounce timing, skeleton timing,
  mode parity).
- [ ] `src/components/table/table-toolbar.test.tsx` — covers `<TableToolbar.Search>`
  debounce + clear behavior; `<TableToolbar.FilterPill>` toggle behavior.
- [ ] `src/components/table/sortable-header.test.tsx` — covers TABLE-03 in
  isolation: click fires onClick, icon swaps, aria-sort attribute correct.
- [ ] `src/app/(dashboard)/lists/lists-view.test.tsx` — covers TABLE-01/02/03/06
  on `/lists`. New file; mocks `next/navigation` like
  `prospects-table.test.tsx:15-28`.
- [ ] `src/app/(dashboard)/jobs/jobs-list.test.tsx` — covers TABLE-01/02/03/06
  on `/jobs`, plus B22-B25 (realtime + URL state interaction). Mocks Supabase
  client realtime channel.
- [ ] `src/app/(dashboard)/templates/templates-list.test.tsx` — covers
  TABLE-01/02/03/06 on `/templates`, plus B16/B17 (client-mode in-memory filter).
- [ ] No new framework install needed — `vitest@4.1.5`, `@testing-library/react@^16.3.2`,
  `@testing-library/user-event@^14.6.1`, `jsdom@^29.1.0` are all present.
- [ ] No new shared fixture file required; the per-test mock pattern from
  `prospects-table.test.tsx:15-28` (router mock) is adequate. Optional:
  consolidate the router mock into a shared helper at
  `src/components/table/test-utils.ts` if duplication grows.

## Sources

### Primary (HIGH confidence)

- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md` —
  searchParams Promise prop (lines 67-119), dynamic rendering opt-in (line 119),
  Page Props Helper (line 122-139), version history (line 237-240).
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md` —
  Suspense boundary requirement (lines 178-182), prerendering vs dynamic
  rendering behavior (lines 80-264), dynamic rendering with `connection()`
  (lines 184-263).
- `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md` —
  `router.replace(href, { scroll })` signature (line 45), `router.refresh()`
  semantics (line 46), `router.prefetch` `onInvalidate` (line 47), version
  history (line 162-164).
- `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md` — Suspense
  boundary semantics for client-side transitions (lines 96-107), `useSearchParams`
  resolves synchronously on client navigations.
- `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md` —
  `useTransition` async pattern (lines around `startTransition(async () => {...})`).
- `node_modules/@types/react/index.d.ts:1832, 1878-1885` — `TransitionFunction`
  returns `void | Promise<void>`; `useTransition()` and `startTransition()` exports.
- `src/app/(dashboard)/properties/prospects-query.ts` (226 lines) — proven
  pattern for parse/build helpers; 35 tests passing.
- `src/app/(dashboard)/properties/prospects-table.tsx` (1,258 lines) — proven
  consumer pattern; 26 tests passing.
- `src/components/ui/dropdown-menu.tsx:252-268` — flat-export compound component
  precedent.
- `src/app/(dashboard)/messages/cockpit-view.tsx`, `inbox-filters.tsx`,
  `inbox-thread-list.tsx` — existing `useSearchParams` usage in the codebase
  (note: cockpit-view's lack of a Suspense boundary is a latent risk but works
  because the page is dynamic at request time).
- `src/app/(auth)/login/page.tsx` — explicit Suspense + useSearchParams pattern
  the codebase already uses for the one place it's needed.
- `package.json` — confirms `next@16.2.4`, `react@19.2.4`, `vitest@^4.1.5`,
  `@testing-library/react@^16.3.2`, `@testing-library/user-event@^14.6.1`,
  `jsdom@^29.1.0` (all required infra present).

### Secondary (MEDIUM confidence)

- React docs `react.dev/reference/react/createContext` — context-based hook
  wiring is industry-standard React for compound components. Verified via
  internal training; no in-repo precedent for an in-house compound primitive
  using context, but the pattern is unambiguous and matches Base UI Menu's
  internal context.

### Tertiary (LOW confidence — none flagged for separate validation)

- None. All claims in this research are either (a) verified against in-repo
  source/tests, (b) cited from `node_modules/next/dist/docs/`, or (c) cited
  from `@types/react` definitions.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every required library is already in `package.json`,
  versions verified, no new dependency.
- Architecture: HIGH — the source pattern (`prospects-table.tsx`) is a working
  proof-of-concept with 35+26 = 61 tests green; the new primitives are an
  extraction, not invention.
- Migration targets: HIGH — every target file has been read end-to-end; the
  current and post-migration line ranges are concretely identified.
- Pitfalls: HIGH — Next.js 16 + React 19 specifics verified against the actual
  docs in `node_modules/`. Pitfall 5 (realtime+URL interaction) has the
  highest residual risk because it is a new code path not exercised today;
  the test contract (B22-B25) addresses this directly.
- Test contract translation: HIGH — every existing test was reviewed and
  mapped to its new home with a "stays vs moves vs adapts" decision.
- Validation Architecture: HIGH — boundaries B1-B25 are each tied to a specific
  test file and command; no boundary is left as "manual only".

**Research date:** 2026-04-30
**Valid until:** 2026-05-30 (30 days — versions are stable; if Next.js or React
ships a major during planning, re-verify the searchParams Promise + useTransition
sections).
