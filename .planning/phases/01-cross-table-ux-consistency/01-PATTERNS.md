# Phase 1: Cross-Table UX Consistency - Pattern Map

**Mapped:** 2026-04-30
**Files analyzed:** 13 (7 new, 6 modified)
**Analogs found:** 13/13

This phase is **extraction**, not invention. Every new file has a strong analog in the existing source pattern (`prospects-query.ts` + `prospects-table.tsx`) and every shared concern (compound exports, RTL test shape, skeleton, search debounce, sortable header) has a verbatim precedent already in the repo. Concrete file:line excerpts below.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/components/table/use-table-url-state.ts` (NEW) | hook + utility | request-response (URL ↔ state) | `src/app/(dashboard)/properties/prospects-query.ts` (pure helpers) + `prospects-table.tsx:124-276` (consumer machine) | exact (extraction) |
| `src/components/table/use-table-url-state.test.ts` (NEW) | test (vitest, node) | unit | `src/app/(dashboard)/properties/prospects-query.test.ts` | exact |
| `src/components/table/table-toolbar.tsx` (NEW) | component (compound, client) | request-response (uncontrolled input → debounced URL nav) | `src/components/ui/dropdown-menu.tsx` (flat exports) + `prospects-table.tsx:673-708` (toolbar markup) | exact |
| `src/components/table/table-toolbar.test.tsx` (NEW) | test (vitest + RTL) | component integration | `src/app/(dashboard)/properties/prospects-table.test.tsx` (RTL + router mock) | exact |
| `src/components/table/sortable-header.tsx` (NEW) | component (presentational, client) | event-driven (click → onSort callback) | `src/app/(dashboard)/properties/prospects-table.tsx:859-892` (inline `SortableHeader`) | exact (verbatim lift) |
| `src/components/table/sortable-header.test.tsx` (NEW) | test (vitest + RTL) | component unit | `src/app/(dashboard)/properties/prospects-table.test.tsx:285-324` (sortable header tests) | exact |
| `src/components/table/index.ts` (NEW barrel) | re-exports | n/a | **No analog in `src/components/ui/`** — flat exports per file is the existing convention. See "No Analog Found" below. | none |
| `src/app/(dashboard)/properties/prospects-table.tsx` (MOD) | component (client island) | request-response | self (same file, lines being collapsed) | self-modify |
| `src/app/(dashboard)/properties/prospects-table.test.tsx` (MOD) | test | RTL | self (existing 26 tests stay green) | self-modify |
| `src/app/(dashboard)/properties/prospects-query.ts` (MOD) | utility (domain helpers) | pure | self (generic helpers move out, domain stays) | self-modify |
| `src/app/(dashboard)/properties/prospects-query.test.ts` (MOD) | test | unit | self (~10 generic tests move; ~25 domain stay) | self-modify |
| `src/app/(dashboard)/lists/page.tsx` (MOD) | server component (page) | SSR fetch + drill props | `src/app/(dashboard)/properties/page.tsx:42-58` (server `searchParams` + parse + drill) | exact |
| `src/app/(dashboard)/lists/lists-table.tsx` (NEW client island, name TBD `lists-view.tsx` per RESEARCH) | component (client island) | request-response (SSR mode) | `src/app/(dashboard)/properties/prospects-table.tsx` (full consumer pattern) | exact |
| `src/app/(dashboard)/jobs/page.tsx` (MOD) | server component | SSR (parses `searchParams`, drills `parsed` to client) | `src/app/(dashboard)/properties/page.tsx:42-58` | role-match (jobs is thin; just adds parse) |
| `src/app/(dashboard)/jobs/jobs-list.tsx` (MOD) | component (client island, realtime) | event-driven (Supabase channel) + URL-state mirror (client mode) | self (existing realtime stays); URL-state layer mirrors `prospects-table.tsx` consumer shape but in `mode: "client"` | partial (no existing realtime + URL-state precedent — first of its kind) |
| `src/app/(dashboard)/templates/page.tsx` (MOD) | server component | SSR (parses `searchParams`, drills `parsed`) | `src/app/(dashboard)/properties/page.tsx:42-58` | role-match |
| `src/app/(dashboard)/templates/templates-list.tsx` (MOD) | component (client island) | request-response (client mode — useMemo over local array) | self (existing useMemo filter); URL-state layer mirrors prospects pattern but in `mode: "client"` | self-modify + role-match for the URL-state layer |

## Pattern Assignments

### `src/components/table/use-table-url-state.ts` (NEW — hook + pure helpers)

**Analog:** `src/app/(dashboard)/properties/prospects-query.ts` (pure helpers — proven by 35 tests) + `src/app/(dashboard)/properties/prospects-table.tsx:124-276` (the consumer machine being extracted into the hook).

**Imports pattern** — follow `prospects-table.tsx:1-7` for the hook's client-side imports:

```typescript
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
```

The pure helpers half of the file (parse/build) has NO imports — matches `prospects-query.ts:1-9` (no imports, just types + functions).

**`pickFirst` + parse pattern** (verbatim from `prospects-query.ts:75-144`):

```typescript
// prospects-query.ts:101-116 — generalize the body, keep the shape:
const pickFirst = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const rawPage = Number(pickFirst(raw.page) ?? 1);
const page =
  Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

const rawSearch = (pickFirst(raw.search) ?? "").trim();
const search = rawSearch.length === 0 ? null : rawSearch;

const rawSort = pickFirst(raw.sort);
const sort = isSortableColumn(rawSort) ? rawSort : DEFAULT_SORT;

const rawDir = pickFirst(raw.dir);
const dir: SortDirection = rawDir === "asc" ? "asc" : DEFAULT_DIR;
```

The new `parseTableSearch<TFilters>` accepts a config object `{ sortableColumns, defaultSort, defaultDir, parseFilters }`; the body is the same lines re-keyed against `config.*` instead of module-scope constants. **Copy verbatim modulo the config substitution.**

**`buildHref` default-stripping pattern** (verbatim from `prospects-query.ts:148-168`):

```typescript
// prospects-query.ts:155-168
const sp = new URLSearchParams();
if (parts.page && parts.page > 1) sp.set("page", String(parts.page));
if (parts.search && parts.search.length > 0) sp.set("search", parts.search);
if (parts.sort && parts.sort !== DEFAULT_SORT) sp.set("sort", parts.sort);
if (parts.dir && parts.dir !== DEFAULT_DIR) sp.set("dir", parts.dir);
// … (filter params via callback)
const qs = sp.toString();
return qs ? `?${qs}` : "";
```

The four guard expressions (`page > 1`, `search.length > 0`, `sort !== DEFAULT_SORT`, `dir !== DEFAULT_DIR`) are **load-bearing** — they keep clean URLs (no `?page=1&dir=desc` litter) and are asserted by `prospects-query.test.ts` (B2/B3/B4 in the validation contract). Domain filter emission moves into a `buildFilterParams` callback so `/properties` can still emit `?vacant=1&cass=verified&...` in the same stable order (lines 161-165).

**`useTransition` + `router.replace` pattern** (verbatim from `prospects-table.tsx:140, 155-159`):

```typescript
// prospects-table.tsx:140
const [navPending, startNavTransition] = useTransition();

// prospects-table.tsx:155-159 — the navigate function
const navigate = (url: string) => {
  startNavTransition(() => {
    router.replace(url, { scroll: false });
  });
};
```

The hook wraps this with the **150ms `forceSkeleton` floor** (D-05). Augment as documented in RESEARCH §"Pattern 2: Context-Based Hook Wiring" lines 1057-1081. The `mode: "client"` branch drops the `startNavTransition` wrapper and calls `router.replace` directly (RESEARCH lines 1072-1078).

**Search debounce pattern** (verbatim from `prospects-table.tsx:148-153, 199-214`):

```typescript
// prospects-table.tsx:148-153 — ref + cleanup
const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
useEffect(() => {
  return () => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
  };
}, []);

// prospects-table.tsx:199-214 — onSearchChange (250ms — D-15)
const onSearchChange = (next: string) => {
  setSearchInput(next);
  if (searchDebounce.current) clearTimeout(searchDebounce.current);
  searchDebounce.current = setTimeout(() => {
    const trimmed = next.trim();
    navigate(
      `/properties${buildProspectsHref({
        page: 1,
        search: trimmed.length === 0 ? null : trimmed,
        sort,
        dir,
        filters,
      })}`,
    );
  }, 250);
};
```

**Critical:** `navigate()` in the hook MUST clear `searchDebounce.current` before firing `router.replace` (Pitfall 3 in RESEARCH; tested by B11). The existing prospects pattern handles this implicitly because the clear-button at `prospects-table.tsx:217-218` calls `clearTimeout` before `navigate`; the hook centralizes this so every call site benefits.

**`onSortClick` pattern** (verbatim from `prospects-table.tsx:227-239`):

```typescript
// prospects-table.tsx:227-239
const onSortClick = (column: SortableColumn) => {
  const nextDir: SortDirection =
    sort === column ? (dir === "asc" ? "desc" : "asc") : "asc";
  navigate(
    `/properties${buildProspectsHref({
      page: 1,
      search: search.length === 0 ? null : search,
      sort: column,
      dir: nextDir,
      filters,
    })}`,
  );
};
```

The hook's `onSort` is identical with `${basePath}` substituted for `/properties` and the generic `buildHref` substituted for `buildProspectsHref`. **Copy verbatim modulo substitution.**

**Context pattern** — no in-repo precedent for a compound primitive owning context, but the pattern is industry-standard React. RESEARCH §"Pattern 2" lines 412-481 specifies the shape. The `<TableToolbar>` reads context via `useTableUrlStateContext()`; the consumer does NOT wrap a separate `<Provider>` — `<TableToolbar state={ts}>` provides the context internally (researcher's preferred shape per RESEARCH Q2 line 1340-1344).

---

### `src/components/table/use-table-url-state.test.ts` (NEW — vitest, node env)

**Analog:** `src/app/(dashboard)/properties/prospects-query.test.ts` (35 tests, all generic-shaped).

**Imports + describe shape** (verbatim from `prospects-query.test.ts:1-13`):

```typescript
import { describe, it, expect } from "vitest";

import {
  buildTableHref,
  parseTableSearch,
  type SortDirection,
} from "./use-table-url-state";
```

**Test-case pattern** (verbatim from `prospects-query.test.ts:14-75`):

```typescript
// prospects-query.test.ts:15-29
describe("parseProspectsSearch", () => {
  it("returns defaults when raw is empty", () => {
    expect(parseProspectsSearch({})).toEqual({
      page: 1,
      search: null,
      sort: DEFAULT_SORT,
      dir: DEFAULT_DIR,
      filters: { /* … */ },
    });
  });

  // prospects-query.test.ts:31-36 — page coercion
  it("clamps invalid pages to 1 and truncates fractional", () => {
    expect(parseProspectsSearch({ page: "0" }).page).toBe(1);
    expect(parseProspectsSearch({ page: "-3" }).page).toBe(1);
    expect(parseProspectsSearch({ page: "nope" }).page).toBe(1);
    expect(parseProspectsSearch({ page: "3.7" }).page).toBe(3);
  });
});
```

The new test file should adopt the same describe blocks (`parseTableSearch`, `buildTableHref`) and copy the assertions (B1–B8 in the validation contract). RESEARCH §"Test Contract Translation" lines 1244-1265 maps each existing test to its new home — about 10 generic tests move; the rest stay in `prospects-query.test.ts`.

**Hook timer tests** — for B9–B19 (debounce + skeleton floor) the hook is tested in jsdom via `renderHook` from `@testing-library/react` with `vi.useFakeTimers()`; this lives in `*.test.tsx` per the file-extension convention. Per RESEARCH Q3 (line 1346-1352) the recommendation is: pure helpers in `*.test.ts` (node), the hook itself in a separate `*.test.tsx` file (jsdom) using a router mock matching `prospects-table.test.tsx:15-28`.

> **Decision flag for planner:** The output file list says `use-table-url-state.test.ts`. If the hook's timer/transition behavior is co-tested there, the file must be `*.test.tsx` and run under `vitest.rtl.config.ts`. Splitting into `use-table-url-state.test.ts` (parse/build only) + `use-table-url-state-hook.test.tsx` (hook timer) is one way to honor the file extension. Planner picks.

---

### `src/components/table/table-toolbar.tsx` (NEW — compound component, client)

**Analog (export shape):** `src/components/ui/dropdown-menu.tsx:252-268` (flat sibling exports — the dominant repo convention).

**Imports pattern** (matches `dropdown-menu.tsx:1-7`):

```typescript
"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
```

**Flat-exports pattern** (verbatim shape from `dropdown-menu.tsx:252-268`):

```typescript
// dropdown-menu.tsx:252-268
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
```

Same shape for `<TableToolbar>`:

```typescript
export { TableToolbar, TableToolbarSearch, TableToolbarFilterPill };
```

**Cross-checked against:** `src/components/ui/dialog.tsx:149-160`, `src/components/ui/sheet.tsx:129-138`, `src/components/ui/table.tsx:107-116` — all use the same flat-exports convention. Zero `Object.assign(Component, { Sub: ... })` precedent in the repo.

**Component definition pattern** (verbatim from `dropdown-menu.tsx:9-19`):

```typescript
// dropdown-menu.tsx:9-19 — function-style components with data-slot attribute
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}
```

Apply: `function TableToolbar(...)` returns a `<div data-slot="table-toolbar" ...>`. `function TableToolbarSearch(...)` returns the search input wrapper. Each subcomponent gets a unique `data-slot` value (`table-toolbar`, `table-toolbar-search`, `table-toolbar-filter-pill`).

**Toolbar visual pattern** (verbatim from `prospects-table.tsx:673-699`):

```typescript
// prospects-table.tsx:673 — the rounded-card wrapper
<div className="border-border bg-card flex flex-wrap items-center gap-3 rounded-2xl border p-3">
  <div className="relative max-w-md flex-1">
    {/* prospects-table.tsx:675-678 — the lucide Search icon overlay */}
    <Search
      className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2"
      aria-hidden
    />
    <Input
      type="text"
      value={searchInput}
      onChange={(e) => onSearchChange(e.target.value)}
      placeholder="Search address…"
      aria-label="Search prospects by address"
      data-testid="prospects-search"
      className="bg-muted/60 h-10 w-full rounded-full border-none pr-10 pl-11"
    />
    {/* prospects-table.tsx:688-697 — the X clear button (only when typed) */}
    {searchInput.length > 0 && (
      <button
        type="button"
        onClick={onClearSearch}
        aria-label="Clear search"
        data-testid="prospects-search-clear"
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
      >
        <X className="size-4" />
      </button>
    )}
  </div>
  {/* … filter pills follow inline */}
</div>
```

**Critical:** the `data-testid` props (`prospects-search`, `prospects-search-clear`) are asserted by 4+ existing RTL tests. `<TableToolbarSearch>` MUST accept a `testId` prop and render `data-testid={testId}` on the `<Input>` and `data-testid={testId + "-clear"}` on the X button so the existing tests keep passing after migration. (Same shape `<SortableHeader>` uses for `testIdPrefix`.)

**Uncontrolled-input pattern** — the existing `prospects-table.tsx:679-687` is currently **controlled** (`value={searchInput}` + `onChange`), but per `feedback_no_usestate_mirror_of_server_props.md` the new `<TableToolbarSearch>` must move to uncontrolled (`defaultValue=`) so `router.refresh()` doesn't clobber mid-keystroke text. RESEARCH §"Pitfall 2" lines 821-839 + B21 in the validation contract. Pattern: `<Input type="text" defaultValue={ctx.search} onChange={(e) => ctx.debouncedSearch(e.target.value)} />` plus a `key` on the parent `<TableBody>` keyed by URL params (the consumer's responsibility per existing pattern at `prospects-table.tsx`).

---

### `src/components/table/table-toolbar.test.tsx` (NEW — vitest + RTL)

**Analog:** `src/app/(dashboard)/properties/prospects-table.test.tsx` (specifically the search/filter test blocks at lines 285-490).

**Mock + imports pattern** (verbatim from `prospects-table.test.tsx:1-30`):

```typescript
// prospects-table.test.tsx:1-29
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { ProspectsTable, type ListOption, type ProspectRow } from "./prospects-table";

// `next/navigation`'s real router needs an App Router context Vitest
// doesn't provide. Stub the bits the table actually calls. Hoisted
// mock state lets tests assert what URL replace() was called with
// when the user clicks a sort header or types into the search box.
const { routerReplace, routerPush } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));
```

**Search debounce assertion pattern** (verbatim from `prospects-table.test.tsx:331-345`):

```typescript
// prospects-table.test.tsx:331-345
it("debounces typing and pushes the trimmed search to the URL with page reset", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderTable([makeRow({ id: "p1" })]);
  const input = screen.getByTestId("prospects-search");
  await user.type(input, "Main St");
  await waitFor(
    () => {
      expect(routerReplace).toHaveBeenCalled();
    },
    { timeout: 1500 },
  );
  expect(routerReplace.mock.calls.at(-1)?.[0]).toBe(
    "/properties?search=Main+St",
  );
});
```

**X-button immediate-nav assertion pattern** (verbatim from `prospects-table.test.tsx:347-369`):

```typescript
// prospects-table.test.tsx:347-369
it("clearing the search via the X button immediately drops ?search and resets to page 1", async () => {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  render(<ProspectsTable /* … with search="Main" … */ />);
  await user.click(screen.getByTestId("prospects-search-clear"));
  expect(routerReplace).toHaveBeenCalledTimes(1);
  // search/sort/dir all default → URL collapses to bare path
  expect(routerReplace.mock.calls[0][0]).toBe("/properties");
});
```

The toolbar tests assert the same `routerReplace.mock.calls[0][0]` URL strings against a synthetic basePath like `/test`. The toolbar tests render `<TableToolbar state={ts}><TableToolbarSearch testId="t-search" ariaLabel="Search test" /></TableToolbar>` inside a wrapper that supplies the hook (mounted via `renderHook` or via a small test-only consumer component).

---

### `src/components/table/sortable-header.tsx` (NEW — verbatim lift)

**Analog:** `src/app/(dashboard)/properties/prospects-table.tsx:859-892` (the existing inline `SortableHeader`).

**Imports pattern**:

```typescript
"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import { TableHead } from "@/components/ui/table";

import type { SortDirection } from "./use-table-url-state";
```

**Component body** (verbatim from `prospects-table.tsx:859-892`):

```typescript
// prospects-table.tsx:859-892 — lift this ENTIRE function into the new file
function SortableHeader({
  column,
  sort,
  dir,
  onClick,
  children,
}: {
  column: SortableColumn;
  sort: SortableColumn;
  dir: SortDirection;
  onClick: (col: SortableColumn) => void;
  children: React.ReactNode;
}) {
  const isActive = sort === column;
  const Icon = isActive ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <TableHead className="select-none">
      <button
        type="button"
        onClick={() => onClick(column)}
        aria-sort={
          isActive ? (dir === "asc" ? "ascending" : "descending") : "none"
        }
        data-testid={`prospects-sort-${column}`}
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

**Adaptations needed (NOT verbatim):**
1. **Generic over column type** — replace `SortableColumn` with `<TColumn extends string>` so each consumer's whitelist narrows the type. RESEARCH §"Pattern 4" lines 1201-1234.
2. **`testIdPrefix` prop** — the literal `prospects-sort-${column}` testId becomes `${testIdPrefix ?? "sort"}-${column}`, so prospects passes `testIdPrefix="prospects"` to keep its existing 2 tests green and other consumers can pass their own prefix. The prospects-table migration changes line 740/743 to `<SortableHeader column="address" current={sort} dir={dir} onClick={onSortClick} testIdPrefix="prospects">Address</SortableHeader>` — the existing testIds (`prospects-sort-address`, `prospects-sort-market`) survive.
3. **Prop rename** — RESEARCH calls the prop `current` (not `sort`) to match `<SortableHeader column="name" current={sort} dir={dir}>` per CONTEXT D-02. Adjust accordingly.
4. **Export** — `export function SortableHeader<TColumn extends string>(...)` — named export, matches the rest of `src/components/`.

---

### `src/components/table/sortable-header.test.tsx` (NEW — RTL)

**Analog:** `src/app/(dashboard)/properties/prospects-table.test.tsx:285-324` (the 2 existing sortable-header tests).

**Test pattern** (verbatim from `prospects-table.test.tsx:285-324`):

```typescript
// prospects-table.test.tsx:285-324
describe("<ProspectsTable /> sortable headers", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

  it("clicking a column header (default sort) sets sort=col&dir=asc and resets to page 1", async () => {
    const user = userEvent.setup();
    renderTable([makeRow({ id: "p1" })]);
    await user.click(screen.getByTestId("prospects-sort-address"));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0][0]).toBe(
      "/properties?sort=address&dir=asc",
    );
  });

  it("clicking the active column header flips direction asc -> desc", async () => {
    // … render with sort="address" dir="asc" …
    await user.click(screen.getByTestId("prospects-sort-address"));
    expect(rout.mock.calls[0][0]).toBe("/properties?sort=address");
  });
});
```

Differences for the standalone header test:
- Render `<SortableHeader column="x" current={current} dir={dir} onClick={onClick}>Label</SortableHeader>` directly (with a stub `onClick = vi.fn()`).
- Assert: (a) onClick fires with the column name; (b) `aria-sort` is `"ascending"` / `"descending"` / `"none"` per state; (c) icon swaps (assert via `screen.getByRole("button").innerHTML` containing the right SVG, or check the icon's `data-` attribute if the lucide icons expose one).

---

### `src/components/table/index.ts` (NEW — barrel export)

**No analog in `src/components/ui/`** — every primitive in `src/components/ui/` is imported directly from its file (e.g., `import { DropdownMenu } from "@/components/ui/dropdown-menu"`). There is **no barrel index in `src/components/ui/` or `src/components/`**.

Two acceptable directions for the planner:

1. **Skip the barrel** — match the dominant repo convention. Consumers do `import { TableToolbar, TableToolbarSearch } from "@/components/table/table-toolbar"`, `import { SortableHeader } from "@/components/table/sortable-header"`, `import { useTableUrlState } from "@/components/table/use-table-url-state"`. Three import lines per consumer is fine and matches every other client island in the repo.
2. **Add the barrel** — `export * from "./table-toolbar"; export * from "./sortable-header"; export * from "./use-table-url-state";` — collapses imports to one line per consumer but introduces a new convention. **Trade-off:** worse tree-shaking (all three modules pull in even if only one is used), and a single broken re-export breaks every consumer's typecheck.

> **Recommendation:** Skip the barrel unless the planner has a specific reason. Drop `src/components/table/index.ts` from the file list. None of the existing tests or consumers expect it.

---

### `src/app/(dashboard)/properties/prospects-table.tsx` (MODIFIED)

**Analog:** self — the modification collapses lines 124-276 (the URL-state machine) and 859-892 (the inline `SortableHeader`) and 673-708 (the toolbar markup) into hook + primitive usage.

**Lines being replaced:**

| Before (lines) | After |
|----------------|-------|
| 124-160 (router + transitions + searchInput state + `navigate`) | `const ts = useTableUrlState({ basePath: "/properties", parsed: { search, sort, dir, page, filters }, mode: "ssr", config: { defaultSort: "created_at", sortableColumns: SORTABLE_COLUMNS, buildFilterParams: buildProspectsFilterParams } });` |
| 199-214 (`onSearchChange`) | Owned by `<TableToolbarSearch>` via context |
| 216-222 (`onClearSearch`) | Owned by `<TableToolbarSearch>` (the X button) |
| 227-239 (`onSortClick`) | `ts.onSort` |
| 244-255 (`updateFilters`) | Domain-specific, **stays** in `prospects-table.tsx`, but rewritten to call `ts.navigate(\`/properties${ts.buildHref({ ... })}\`)` |
| 260-276 (`clearAllFilters`) | Same — stays, calls `ts.navigate` |
| 673-708 (toolbar markup) | `<TableToolbar state={ts}><TableToolbarSearch testId="prospects-search" ariaLabel="Search prospects by address" placeholder="Search address…" /><ProspectFilters /* unchanged */ /></TableToolbar>` |
| 740-745 (inline `<SortableHeader>` calls) | Same shape, but from `@/components/table/sortable-header` import; pass `testIdPrefix="prospects"` to preserve existing testIds |
| 752-782 (skeleton swap) | Stays — but driven by `ts.navPending` instead of local `navPending` |
| 859-892 (inline `function SortableHeader`) | DELETED |

**Critical regression boundary:** The 26 existing RTL tests at `prospects-table.test.tsx` assert `routerReplace.mock.calls[0][0]` URL strings like `"/properties?sort=address&dir=asc"`. The hook MUST produce byte-identical URLs to the existing `buildProspectsHref` for the prospects filter set — that's why the hook's `buildHref` accepts a `buildFilterParams` callback and the prospects-specific `buildProspectsFilterParams` (extracted from `prospects-query.ts:160-165`) handles the stable order: `vacant`, `cass`, `engagement`, `market`, `assignee`. RESEARCH lines 638-643.

---

### `src/app/(dashboard)/properties/prospects-table.test.tsx` (MODIFIED)

**Analog:** self — keep all 26 tests green. The DOM shapes that get re-keyed:

- `screen.getByTestId("prospects-search")` — survives if `<TableToolbarSearch testId="prospects-search">` forwards the testId to its `<Input>` (per the analog pattern documented in the toolbar section).
- `screen.getByTestId("prospects-search-clear")` — survives if the toolbar's X button uses `data-testid={`${testId}-clear`}`.
- `screen.getByTestId("prospects-sort-address")` — survives if `<SortableHeader testIdPrefix="prospects">` wires through.
- `screen.getByTestId("prospects-skeleton-row")` — preserved verbatim (skeleton markup stays inside `prospects-table.tsx`, just driven by `ts.navPending`).
- `screen.getByTestId("filter-vacant")`, `filter-verified`, `filter-contacted`, `filter-clear-all` — these belong to the `<ProspectFilters>` subcomponent which stays in `prospects-table.tsx`. Unchanged.

No test assertions need to change if the analog patterns above are followed exactly.

---

### `src/app/(dashboard)/properties/prospects-query.ts` (MODIFIED)

**Analog:** self. Lines 11-15 (`SORTABLE_COLUMNS`), 25 (`SortDirection`), 47-53 (`ParsedProspectsSearch`), 72-73 (`DEFAULT_SORT`/`DEFAULT_DIR`), 91-144 (`parseProspectsSearch`), and 148-168 (`buildProspectsHref`) all become **thin wrappers** around the generic helpers in `use-table-url-state.ts`:

```typescript
// After migration — prospects-query.ts becomes:
import { parseTableSearch, buildTableHref, type SortDirection } from "@/components/table/use-table-url-state";

export const SORTABLE_COLUMNS = ["address", "market", "created_at"] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];
export const DEFAULT_SORT: SortableColumn = "created_at";
export const DEFAULT_DIR: SortDirection = "desc";
// … domain types, KNOWN_MARKETS, isKnownMarket …

export function parseProspectsSearch(raw: { /* … */ }): ParsedProspectsSearch {
  return parseTableSearch<ParsedProspectsFilters>(raw, {
    sortableColumns: SORTABLE_COLUMNS,
    defaultSort: DEFAULT_SORT,
    defaultDir: DEFAULT_DIR,
    parseFilters: (r) => parseProspectsFilters(r),  // domain helper
  });
}

export function buildProspectsHref(parts: { /* … */ }): string {
  return buildTableHref<ParsedProspectsFilters>(parts, {
    defaultSort: DEFAULT_SORT,
    defaultDir: DEFAULT_DIR,
    buildFilterParams: buildProspectsFilterParams,  // domain helper
  });
}
```

`computeEngagement` (lines 184-189), `truncateMessagePreview` (lines 194-203), `formatFullAddress` (lines 212-226), and `KNOWN_MARKETS` + `isKnownMarket` (lines 55-69) stay verbatim — they are domain-specific to the prospects page.

---

### `src/app/(dashboard)/properties/prospects-query.test.ts` (MODIFIED)

**Analog:** self. Per RESEARCH §"Test Contract Translation" (lines 1244-1265):
- ~10 generic tests (parse defaults, page coercion, search trim/null collapse, sort whitelist, dir collapse, array-style searchParams, buildHref defaults/ordering/encoding) **move** to `use-table-url-state.test.ts`. They're rewritten to call `parseTableSearch` / `buildTableHref` with a config object that mirrors the prospects defaults, so the assertions stay byte-identical.
- ~25 domain-specific tests (vacant/cass/engagement/market/assignee filter parsing, computeEngagement, truncateMessagePreview, formatFullAddress) **stay** in `prospects-query.test.ts`. They keep calling `parseProspectsSearch` and `buildProspectsHref` (the wrappers), so the contract holds end-to-end.

---

### `src/app/(dashboard)/lists/page.tsx` (MODIFIED → server `searchParams` + drill props + new client island)

**Analog:** `src/app/(dashboard)/properties/page.tsx:42-58` (the prospects page's parse-and-drill pattern).

**Imports + signature pattern** (verbatim shape from `properties/page.tsx:42-58`):

```typescript
// properties/page.tsx:42-58
export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    vacant?: string;
    cass?: string;
    engagement?: string;
    market?: string;
    assignee?: string;
  }>;
}) {
  const parsed = parseProspectsSearch(await searchParams);
  const { page, search, sort, dir, filters } = parsed;
  // … fetch data, render <ProspectsTable {...allTheProps} />
}
```

For `/lists` (RESEARCH lines 644-679 + Example 3 at lines 1146-1188), apply the same shape with `parseTableSearch<ListsFilters>` and an inline `SORTABLE_COLUMNS = ["name", "members", "created_at"] as const`. The Supabase query at the existing `lists/page.tsx:33-41` adds `.order(sort, { ascending: dir === "asc" })` plus the secondary tie-breaker `.order("id", { ascending: true })` (Pitfall 7 from RESEARCH lines 905-919). Filter `archived` via the parsed prop instead of the in-memory split at lines 50-51.

**Pagination link pattern** (verbatim shape from `properties/page.tsx:284-318`):

```typescript
// properties/page.tsx:289-297
{page > 1 ? (
  <Link
    href={`/properties${buildPageHref(page - 1, search, sort, dir, filters)}`}
    className={buttonVariants({ variant: "outline", size: "sm" })}
    prefetch={false}
  >
    ← Prev
  </Link>
) : (
  <Button variant="outline" size="sm" disabled>
    ← Prev
  </Button>
)}
```

Use `ts.buildHref` / `buildTableHref(parts, config)` to produce the URL. Render this only when `total > PAGE_SIZE` per the RESEARCH note that lists are typically <100 per org.

---

### `src/app/(dashboard)/lists/lists-table.tsx` (NEW client island)

**Analog:** `src/app/(dashboard)/properties/prospects-table.tsx` (the entire consumer pattern minus the bulk-actions machinery).

**Imports pattern** (verbatim from `prospects-table.tsx:1-43`, simplified):

```typescript
"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  TableToolbar,
  TableToolbarSearch,
  TableToolbarFilterPill,
} from "@/components/table/table-toolbar";
import { SortableHeader } from "@/components/table/sortable-header";
import { useTableUrlState } from "@/components/table/use-table-url-state";
```

**Skeleton-rows pattern** (verbatim shape from `prospects-table.tsx:752-782`):

```typescript
// prospects-table.tsx:752-782 — five-column skeleton row
{navPending ? (
  Array.from({ length: Math.max(rows.length, 5) }).map((_, i) => (
    <TableRow key={`skeleton-${i}`} data-testid="lists-skeleton-row">
      <TableCell><Skeleton className="h-4 w-48" /></TableCell>
      <TableCell><Skeleton className="h-4 w-72" /></TableCell>
      <TableCell><Skeleton className="h-4 w-12" /></TableCell>
      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
      <TableCell><Skeleton className="h-8 w-20" /></TableCell>
    </TableRow>
  ))
) : /* … */ }
```

`<Skeleton>` source: `src/components/ui/skeleton.tsx:3-11` — single-line primitive: `<div className="animate-pulse rounded-md bg-muted" />`. No new visual.

**Existing row body** (verbatim from `lists/page.tsx:136-186`) — the `<TableRow>` body (Name + Description + Members count + Created + Actions) ports verbatim into the new client island. Only the `<TableHead>` cells change from plain `<TableHead>Name</TableHead>` to `<SortableHeader column="name" current={sort} dir={dir} onClick={ts.onSort} testIdPrefix="lists">Name</SortableHeader>`.

---

### `src/app/(dashboard)/jobs/page.tsx` (MODIFIED — add `searchParams` parse + drill)

**Analog:** `src/app/(dashboard)/properties/page.tsx:42-58`.

Existing `jobs/page.tsx:12-29` is 17 lines of just `<JobsList isAdmin={isAdmin} />`. After migration: parse `searchParams`, drill `parsed` into `<JobsList parsed={parsed} isAdmin={isAdmin} />`.

```typescript
// New jobs/page.tsx signature
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; sort?: string; dir?: string; status?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const isAdmin = isAdminEmail(user?.email);
  const parsed = parseTableSearch<JobsFilters>(await searchParams, {
    sortableColumns: ["title", "type", "status", "created_at"] as const,
    defaultSort: "created_at",
    defaultDir: "desc",
    parseFilters: (r) => ({ status: pickStatusFilter(r.status) }),
  });
  return <Page>...<JobsList isAdmin={isAdmin} parsed={parsed} /></Page>;
}
```

---

### `src/app/(dashboard)/jobs/jobs-list.tsx` (MODIFIED — wrap toolbar around realtime body)

**Analog:** `src/app/(dashboard)/properties/prospects-table.tsx` for the URL-state layer; **self** for the realtime subscription (lines 53-105 stay verbatim per D-06).

**Realtime subscription** (verbatim from `jobs-list.tsx:53-105`) — DOES NOT CHANGE. The `setJobs` machine, the channel subscription, the INSERT/UPDATE/DELETE handlers all stay. `useState<Job[]>([])` remains the source of truth.

**New URL-state layer** — between the existing `useState<Job[]>([])` and the `<Table>` render, add:

```typescript
const ts = useTableUrlState<JobsFilters>({
  basePath: "/jobs",
  parsed,
  mode: "client",  // realtime is the source — D-06/D-07
  config: {
    defaultSort: "created_at",
    defaultDir: "desc",
    sortableColumns: ["title", "type", "status", "created_at"] as const,
    buildFilterParams: (filters, sp) => {
      if (filters.status) sp.set("status", filters.status);
    },
  },
});

// useMemo derived view — recomputes whenever realtime mutates `jobs`
// OR URL-state changes (per Pitfall 5 / B22-B25)
const visibleJobs = useMemo(
  () => filterAndSortJobs(jobs, { search: ts.search, sort: ts.sort, dir: ts.dir, status: ts.filters.status }),
  [jobs, ts.search, ts.sort, ts.dir, ts.filters.status],
);
```

**Toolbar wrap pattern** — wrap the existing `<Table>` (lines 117-216) with a `<TableToolbar>` like the one in `prospects-table.tsx:673-708`. Replace the plain `<TableHead>` cells at lines 122-128 with `<SortableHeader>` calls.

**Skeleton swap pattern** — same as the prospects skeleton rows (5 columns become 6 for jobs). Match the `<Skeleton>` widths to the column content (h-4 w-48 for title, w-16 for type/status badges, etc.).

---

### `src/app/(dashboard)/templates/page.tsx` + `templates-list.tsx` (MODIFIED — useState → URL params)

**Analogs:** `properties/page.tsx:42-58` for the server side; `prospects-table.tsx` for the consumer side; **self** for the existing `useMemo` filter at `templates-list.tsx:33-47`.

**Existing useMemo filter** (verbatim from `templates-list.tsx:33-47`):

```typescript
// templates-list.tsx:33-47 — keep this shape, just swap `search`/`categoryFilter` source from useState to ts
const filtered = useMemo(() => {
  let result = templates;
  if (search.trim()) {
    const q = search.toLowerCase();
    result = result.filter(
      (t) => t.name.toLowerCase().includes(q) || t.content.toLowerCase().includes(q),
    );
  }
  if (categoryFilter !== "all") {
    result = result.filter((t) => t.category === categoryFilter);
  }
  return result;
}, [templates, search, categoryFilter]);
```

After migration: `const filtered = useMemo(() => filterAndSortTemplates(templates, { search: ts.search, sort: ts.sort, dir: ts.dir, category: ts.filters.category }), [templates, ts.search, ts.sort, ts.dir, ts.filters.category]);` — the in-memory filter survives, URL becomes the source.

**Existing `<Select>` for category** (verbatim from `templates-list.tsx:63-75`) — the Base UI Select stays in the toolbar. Per RESEARCH Q1 (lines 1325-1333), the recommendation is to keep Base UI `<Select>` next to `<TableToolbarSearch>` rather than expand `<TableToolbarFilterPill>` to a dropdown variant in this phase. Wire its `onValueChange` to `ts.navigate(\`/templates${ts.buildHref({ filters: { category: v === "all" ? null : v } })}\`)`.

**Raw `<table>` → shadcn `<Table>` migration** — `templates-list.tsx:86-137` currently uses raw HTML `<table>` / `<thead>` / `<tbody>`. Convert to `<Table>` / `<TableHeader>` / `<TableHead>` / `<TableBody>` / `<TableRow>` / `<TableCell>` from `@/components/ui/table`. Headers become `<SortableHeader column="name|category|updated_at" current={ts.sort} dir={ts.dir} onClick={ts.onSort} testIdPrefix="templates">…</SortableHeader>`.

---

## Shared Patterns

### Authentication / Authorization
**Source:** Server `page.tsx` files use `createClient()` from `@/lib/supabase/server` and check `isAdmin` via `isAdminEmail(user?.email)` — see `jobs/page.tsx:13-17`.
**Apply to:** `lists/page.tsx`, `templates/page.tsx`, `jobs/page.tsx` modifications. The existing auth/RLS pattern is already present; the migration does not change authorization.
```typescript
// jobs/page.tsx:13-17
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
const isAdmin = isAdminEmail(user?.email);
```

### Error Handling
**Source:** `prospects-table.tsx:44, 178-191` — `callAction` from `@/lib/errors/call-action` wraps server-action calls and toasts via `sonner`.
**Apply to:** Any new server-action calls in jobs/lists/templates migrations. Phase 1 is mostly URL-state extraction — minimal new server-action surface — but bulk filter changes don't introduce new server actions; existing actions like `archiveList` (lists/list-row-actions.tsx) keep their existing error handling.
```typescript
// prospects-table.tsx:178-191
startTransition(async () => {
  const result = await callAction(
    getAllMatchingProspectIds({ search, filters }),
    { fallbackMessage: "Could not select all matching prospects" },
  );
  if (result.ok) {
    setSelected(new Set(result.data));
    setSelectAllMatching(true);
  }
});
```

### Test Mock Setup
**Source:** `prospects-table.test.tsx:15-65` — the canonical pattern for any RTL test that touches `next/navigation` or server actions.
**Apply to:** ALL new RTL test files (`table-toolbar.test.tsx`, `sortable-header.test.tsx`, `lists-table.test.tsx`, `jobs-list.test.tsx`, `templates-list.test.tsx`).
```typescript
// prospects-table.test.tsx:15-29 — hoisted router mock
const { routerReplace, routerPush } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    refresh: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// prospects-table.test.tsx:63-65 — sonner stub
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
```

For `jobs-list.test.tsx`, **also** mock `@/lib/supabase/client` with the realtime channel shape from `inbox-filters.test.tsx:46-61`:
```typescript
// inbox-filters.test.tsx:46-61 — Supabase realtime channel mock
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
    realtime: { setAuth: vi.fn() },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: vi.fn(),
  }),
}));
```

### Skeleton Markup
**Source:** `src/components/ui/skeleton.tsx:3-11` (single-line primitive) + `prospects-table.tsx:752-782` (consumer pattern).
**Apply to:** Every new client island when `ts.navPending === true`.
```typescript
// skeleton.tsx:3-11 — primitive
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

// prospects-table.tsx:756-782 — consumer pattern (5-column row)
Array.from({ length: Math.max(rows.length, 5) }).map((_, i) => (
  <TableRow key={`skeleton-${i}`} data-testid="prospects-skeleton-row">
    <TableCell><Skeleton className="size-4 rounded" /></TableCell>
    <TableCell><Skeleton className="h-4 w-72" /></TableCell>
    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
    <TableCell><div className="flex gap-1"><Skeleton className="h-5 w-16 rounded-full" /><Skeleton className="h-5 w-16 rounded-full" /></div></TableCell>
    <TableCell><Skeleton className="h-4 w-56" /></TableCell>
  </TableRow>
))
```

Per-page row count: match `rows.length` with a `Math.max(rows.length, 5)` floor so the table doesn't snap-resize when results return.

### Compound Component Export
**Source:** `src/components/ui/dropdown-menu.tsx:252-268` (the canonical example) + `dialog.tsx:149-160` + `sheet.tsx:129-138` + `table.tsx:107-116`.
**Apply to:** `table-toolbar.tsx` exports.
**Pattern:** Flat sibling exports — `export { TableToolbar, TableToolbarSearch, TableToolbarFilterPill }`. NO `Object.assign(TableToolbar, { Search, FilterPill })`. Per RESEARCH lines 393-396 the dot-notation in CONTEXT D-01 was call-site sugar; the actual repo convention is flat exports.

### Page + PageHeader Composition
**Source:** Every dashboard route — `lists/page.tsx:54-66`, `properties/page.tsx`, `templates/page.tsx:18-24`, `jobs/page.tsx:20-26`.
**Apply to:** All modified pages keep this composition. The `<TableToolbar>` slots in below `<PageHeader>` and above `<Table>`.
```typescript
// lists/page.tsx:54-66 — Page + PageHeader pattern
<Page>
  <PageHeader
    breadcrumb={[{ label: "Workspace" }, { label: "Lists" }]}
    title="Lists"
    description={...}
  />
  <CreateListForm />
  {/* … new <ListsTable /> client island here … */}
</Page>
```

### Pagination Link
**Source:** `properties/page.tsx:284-318` (the only existing pagination pattern in the dashboard).
**Apply to:** `lists/page.tsx` if pagination is enabled (RESEARCH leaves this as a planner decision, given typical list count <100).
**Pattern:** Plain `<Link prefetch={false}>` with `buttonVariants({ variant: "outline", size: "sm" })`, wrapping the URL via `${basePath}${buildHref({ page: page+1, ... })}`. Disabled `<Button>` when at boundary.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/components/table/index.ts` | barrel export | n/a | **No barrel exports exist anywhere in `src/components/`** — every consumer imports directly from each file. The repo convention is no barrels. Recommendation: drop this file from the plan unless the planner has a specific reason. |
| Realtime + URL-state interaction (in `jobs-list.tsx`) | event-driven + URL mirror | hybrid | **First of its kind in the repo.** No existing client island combines a Supabase realtime channel with URL-driven filter state. The closest analog is `prospects-table.tsx` (URL state, no realtime) + `jobs-list.tsx:53-105` (realtime, no URL state). The new code is a layered composition. RESEARCH §"Pitfall 5" (lines 875-890) and B22-B25 in the validation contract specify the test contract; the plan must explicitly assert "INSERT during navPending recomputes visible slice on next render" since there's no precedent test for it. |
| Hook with `useTransition` + `mode: "client" \| "ssr"` switch | hook (custom) | request-response | **No existing custom hook in `src/`.** `find src -name "use-*.ts"` returns no matches. The new `use-table-url-state.ts` is the first. The patterns it composes (useTransition, useRouter.replace, useRef debounce) all exist inline in `prospects-table.tsx:124-276`, but this is the first time they're packaged as a reusable hook. |
| Context-based wiring inside a compound component | provider + consumer hook | shared state | **No existing in-house compound primitive uses context.** Base UI's Menu primitive uses internal context but it's library code in `node_modules`. RESEARCH §"Pattern 2" line 410-413 calls this out: industry-standard React, but greenfield within this repo. |

---

## Metadata

**Analog search scope:**
- `src/components/ui/` — flat-export compound precedents (dropdown-menu, dialog, sheet, table, skeleton)
- `src/app/(dashboard)/properties/` — source pattern (prospects-query.ts, prospects-table.tsx, prospects-query.test.ts, prospects-table.test.tsx, page.tsx)
- `src/app/(dashboard)/lists/`, `src/app/(dashboard)/jobs/`, `src/app/(dashboard)/templates/` — migration target current state
- `src/app/(dashboard)/messages/` — sampled `inbox-filters.test.tsx` for the Supabase realtime mock pattern
- `src/hooks/` and `src/**/use-*.ts` — confirmed empty (no existing custom hooks)
- `src/components/index.ts`, `src/components/ui/index.ts` — confirmed not present (no barrel convention)

**Files scanned:** 14
- `src/app/(dashboard)/properties/prospects-query.ts` (full)
- `src/app/(dashboard)/properties/prospects-query.test.ts` (lines 1-100, sufficient — same file shape repeats)
- `src/app/(dashboard)/properties/prospects-table.tsx` (lines 1-300 + 670-892, the load-bearing sections)
- `src/app/(dashboard)/properties/prospects-table.test.tsx` (lines 1-200 + 285-490, the toolbar/sort/filter test blocks)
- `src/app/(dashboard)/properties/page.tsx` (lines 1-160 + 280-322 — server signature + pagination)
- `src/app/(dashboard)/lists/page.tsx` (full)
- `src/app/(dashboard)/jobs/page.tsx` (full)
- `src/app/(dashboard)/jobs/jobs-list.tsx` (full)
- `src/app/(dashboard)/jobs/retry-skip-trace-button.test.tsx` (lines 1-60, RTL pattern reference)
- `src/app/(dashboard)/templates/page.tsx` (full)
- `src/app/(dashboard)/templates/templates-list.tsx` (full)
- `src/app/(dashboard)/messages/inbox-filters.test.tsx` (lines 1-90, Supabase realtime mock reference)
- `src/components/ui/dropdown-menu.tsx` (full — primary flat-export precedent)
- `src/components/ui/dialog.tsx`, `src/components/ui/sheet.tsx`, `src/components/ui/table.tsx`, `src/components/ui/skeleton.tsx` (export footers + skeleton primitive)

**Pattern extraction date:** 2026-04-30
