import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import type {
  ParsedTableSearch,
  SortDirection,
} from "@/components/table/use-table-url-state";

import { ListsTable, type ListRow, type ListsFilters } from "./lists-table";

// `next/navigation`'s real router needs an App Router context Vitest doesn't
// provide. Stub the bits the table actually calls. Hoisted mock state lets
// tests assert what URL replace() was called with when the user clicks a
// sort header / types into search / clicks the archived pill.
const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// list-row-actions imports server actions which transitively import server-
// only Supabase bindings. Stub it so jsdom doesn't try to load them.
vi.mock("./list-row-actions", () => ({
  ListRowActions: () => null,
}));

// Sonner is harmless in jsdom but the table never calls it from these tests;
// stub anyway to keep the surface noise-free.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function makeRow(overrides: Partial<ListRow> & { id: string }): ListRow {
  return {
    id: overrides.id,
    name: overrides.name ?? `${overrides.id} List`,
    description: overrides.description ?? null,
    color: overrides.color ?? null,
    archived_at: overrides.archived_at ?? null,
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    system_managed: overrides.system_managed ?? false,
    members: overrides.members ?? 0,
  };
}

const DEFAULT_PARSED: ParsedTableSearch<ListsFilters> = {
  page: 1,
  search: null,
  sort: "name",
  dir: "asc" as SortDirection,
  filters: { archived: false },
};

function renderTable(
  opts: {
    rows?: ListRow[];
    parsed?: Partial<ParsedTableSearch<ListsFilters>>;
  } = {},
) {
  return render(
    <ListsTable
      rows={opts.rows ?? [makeRow({ id: "l1" }), makeRow({ id: "l2" })]}
      parsed={{
        ...DEFAULT_PARSED,
        ...opts.parsed,
        filters: {
          ...DEFAULT_PARSED.filters,
          ...(opts.parsed?.filters ?? {}),
        },
      }}
      total={2}
    />,
  );
}

beforeEach(() => {
  routerReplace.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<ListsTable />", () => {
  it("renders the toolbar (search + archived pill) and the three sortable column headers", () => {
    renderTable();
    expect(screen.getByTestId("lists-search")).toBeInTheDocument();
    expect(screen.getByTestId("lists-filter-archived")).toBeInTheDocument();
    expect(screen.getByTestId("lists-sort-name")).toBeInTheDocument();
    expect(screen.getByTestId("lists-sort-members")).toBeInTheDocument();
    expect(screen.getByTestId("lists-sort-created_at")).toBeInTheDocument();
  });

  it("typing in the search input calls router.replace with the trimmed search URL after the 250ms debounce", async () => {
    // Real timers + waitFor — fake timers don't compose cleanly with React 19's
    // useTransition inside the hook's navigate path (per Plan 01-02 SUMMARY).
    const user = userEvent.setup();
    renderTable();
    await user.type(screen.getByTestId("lists-search"), "Probate");

    await waitFor(
      () => {
        expect(routerReplace).toHaveBeenCalled();
      },
      { timeout: 1500 },
    );
    expect(routerReplace.mock.calls.at(-1)?.[0]).toBe("/lists?search=Probate");
  });

  it("clicking the Name header (default sort: name asc) flips dir to desc and emits ?dir=desc", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByTestId("lists-sort-name"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // sort=name === default → omitted; dir=desc !== default asc → emitted.
    expect(routerReplace.mock.calls[0][0]).toBe("/lists?dir=desc");
  });

  it("clicking the Members header (non-default sort) emits ?sort=members (asc is default → omitted)", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByTestId("lists-sort-members"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // dir defaults to asc on a column switch → defaultDir asc strips it.
    expect(routerReplace.mock.calls[0][0]).toBe("/lists?sort=members");
  });

  it("clicking the 'Show archived' pill (when inactive) toggles ?archived=1", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByTestId("lists-filter-archived"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    expect(routerReplace.mock.calls[0][0]).toBe("/lists?archived=1");
  });

  it("clicking the 'Showing archived' pill (when active) removes ?archived from the URL", async () => {
    const user = userEvent.setup();
    renderTable({ parsed: { filters: { archived: true } } });
    await user.click(screen.getByTestId("lists-filter-archived"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // archived flips to false → buildFilterParams omits it; sort/dir/page all
    // default → URL collapses to the bare path.
    expect(routerReplace.mock.calls[0][0]).toBe("/lists");
  });

  it("renders skeleton rows while navPending is true (engaged by the 150ms forceSkeleton floor after a navigate)", async () => {
    const user = userEvent.setup();
    renderTable();

    // Trigger a navigate via the archived pill — engages forceSkeleton.
    await act(async () => {
      await user.click(screen.getByTestId("lists-filter-archived"));
    });

    // forceSkeleton stays true for 150ms → skeleton rows present.
    expect(
      screen.getAllByTestId("lists-skeleton-row").length,
    ).toBeGreaterThanOrEqual(5);
  });
});
