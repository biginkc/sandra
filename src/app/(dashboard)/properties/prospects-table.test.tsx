import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";

import {
  ProspectsTable,
  type ListOption,
  type ProspectRow,
} from "./prospects-table";
import type { FilterBlock } from "./prospects-query";

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

// Server-action modules import `next/server` (`after`) and the Supabase
// server client at module load. Replace them with stubs — most tests
// don't fire actions, but the bulk-add-to-list flow asserts the right
// action is called with the right args.
vi.mock("../leads/actions", () => ({
  addPropertiesToListBulk: vi.fn(async () => ({
    ok: true,
    data: { succeeded: 0, skipped: 0, failed: [] },
  })),
  applyTagBulk: vi.fn(),
  assignLeadsBulk: vi.fn(),
  deletePropertiesBulk: vi.fn(),
  qualifyLeadsBulk: vi.fn(),
  removePropertiesFromListBulk: vi.fn(),
  setMotivationBulk: vi.fn(),
  verifyPropertiesBulk: vi.fn(),
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  requestSkipTrace: vi.fn(),
}));

const { getAllMatchingProspectIds } = vi.hoisted(() => ({
  getAllMatchingProspectIds: vi.fn(),
}));

vi.mock("./actions", () => ({
  getAllMatchingProspectIds,
}));

// Sonner's toast is fine in jsdom but the table's handlers don't fire
// in these tests; stub anyway to keep the surface noise-free.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

function makeRow(overrides: Partial<ProspectRow> & { id: string }): ProspectRow {
  return {
    id: overrides.id,
    address: overrides.address ?? `${overrides.id} Main St`,
    city: overrides.city ?? "Albany",
    state: overrides.state ?? "NY",
    zip: overrides.zip ?? "12203",
    market: overrides.market ?? "Capital District",
    cass_status: overrides.cass_status ?? "verified",
    is_vacant: overrides.is_vacant ?? false,
    created_at: overrides.created_at ?? "2026-04-29T12:00:00Z",
    engagement: overrides.engagement ?? "none",
    last_message_preview: overrides.last_message_preview ?? null,
    outreach_dispo: overrides.outreach_dispo ?? null,
  };
}

const EMPTY_BLOCK_STACK: FilterBlock[] = [];

function renderTable(rows: ProspectRow[], lists: ListOption[] = []) {
  return render(
    <ProspectsTable
      prospects={rows}
      lists={lists}
      tags={[]}
      teamMembers={[]}
      currentUserId={null}
      canDelete={false}
      headerCount={`Showing 1-${rows.length} of ${rows.length} prospects.`}
      search=""
      sort="created_at"
      dir="desc"
      blockStack={EMPTY_BLOCK_STACK}
      filtersParam={null}
      total={1382}
      pageSize={50}
      page={1}
      totalPages={28}
    />,
  );
}

describe("<ProspectsTable />", () => {
  it("renders without crashing and Actions button starts disabled", () => {
    const rows = [
      makeRow({ id: "p1" }),
      makeRow({ id: "p2" }),
      makeRow({ id: "p3" }),
    ];

    renderTable(rows);

    // Page renders the heading — we never hit the error boundary.
    expect(
      screen.getByRole("heading", { level: 1, name: "Prospects" }),
    ).toBeInTheDocument();

    // Actions button is present, disabled, and reads exactly "Actions".
    const actions = screen.getByRole("button", { name: /Actions \(select/ });
    expect(actions).toBeDisabled();
    expect(actions).toHaveTextContent(/^Actions$/);

    // Import CSV link sits next to it.
    expect(screen.getByRole("link", { name: "Import CSV" })).toBeInTheDocument();
  });

  it("flips Actions to 'Actions (1)' when a row checkbox is selected", async () => {
    const user = userEvent.setup();
    const rows = [makeRow({ id: "p1" }), makeRow({ id: "p2" })];

    renderTable(rows);

    const rowCheckboxes = screen.getAllByRole("checkbox", {
      name: /^Select p\d+ Main St$/,
    });
    expect(rowCheckboxes).toHaveLength(2);

    await user.click(rowCheckboxes[0]);

    const actions = screen.getByRole("button", {
      name: /Actions for 1 selected/,
    });
    expect(actions).toBeEnabled();
    expect(actions).toHaveTextContent(/^Actions \(1\)$/);
  });

  it("bulk add-to-list calls the action with the selected ids and chosen list", async () => {
    const user = userEvent.setup({
      // Base UI's submenu portal sets pointer-events: none until the
      // submenu is fully open; user-event's strict default would refuse
      // to click through. Same shape Playwright defaults to anyway.
      pointerEventsCheck: 0,
    });
    const { addPropertiesToListBulk } = await import("../leads/actions");
    const rows = [
      makeRow({ id: "p1", address: "1 Bulk Ave" }),
      makeRow({ id: "p2", address: "2 Bulk Ave" }),
      makeRow({ id: "p3", address: "3 Bulk Ave" }),
    ];
    const lists: ListOption[] = [
      { id: "list-pkc", name: "Probate KC", color: null },
    ];

    renderTable(rows, lists);

    for (const r of rows) {
      await user.click(
        screen.getByRole("checkbox", { name: `Select ${r.address}` }),
      );
    }

    await user.click(
      screen.getByRole("button", { name: /Actions for 3 selected/ }),
    );
    // Base UI submenu opens with ArrowRight (or hover). jsdom doesn't
    // fire reliable hover events, so navigate via keyboard: tab into
    // the menu, find the submenu trigger, open it, pick the list.
    const addToListTrigger = await screen.findByRole("menuitem", {
      name: /Add to list/,
    });
    addToListTrigger.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(
      await screen.findByRole("menuitem", { name: "Probate KC" }),
    );

    await waitFor(() => {
      expect(addPropertiesToListBulk).toHaveBeenCalledWith(
        ["p1", "p2", "p3"],
        "list-pkc",
      );
    });
  });

  it("bulk action menu uses 'Promote to Lead' (renamed from 'Qualify selected') and no longer offers 'Set motivation'", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const rows = [makeRow({ id: "p1" }), makeRow({ id: "p2" })];
    renderTable(rows);

    // Select a row so the Actions button is enabled.
    await user.click(
      screen.getByRole("checkbox", { name: "Select p1 Main St" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    );

    expect(
      await screen.findByRole("menuitem", { name: /Promote to Lead/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Qualify selected/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Set motivation/ }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plan 09 — structural regression: the 5 inline chips MUST be gone. The
// drawer + Quick Filters bar own filter UI now (Plan 06 / Plan 08); the
// table never re-renders these testids. Falsifiable: a re-introduction of
// any chip would put one of these testids back into the DOM and fail.
// ---------------------------------------------------------------------------

describe("<ProspectsTable /> Plan 09 chip-removal regression", () => {
  it("does not render the legacy 5-chip cluster (vacant, verified, contacted, market, assignee, clear-all)", () => {
    renderTable([makeRow({ id: "p1" })]);
    expect(screen.queryByTestId("filter-vacant")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-verified")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-contacted")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-market")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-assignee")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-clear-all")).not.toBeInTheDocument();
  });
});

describe("<ProspectsTable /> engagement column", () => {
  it("renders the Replying badge when the latest message is inbound", () => {
    renderTable([
      makeRow({
        id: "p-replying",
        engagement: "replying",
        last_message_preview: "Yes I'd like to hear more.",
      }),
    ]);
    expect(screen.getByTestId("engagement-replying")).toHaveTextContent(
      "Replying",
    );
  });

  it("renders the Contacted badge when the latest message is outbound", () => {
    renderTable([
      makeRow({
        id: "p-contacted",
        engagement: "contacted",
        last_message_preview: "Hi, are you considering selling?",
      }),
    ]);
    expect(screen.getByTestId("engagement-contacted")).toHaveTextContent(
      "Contacted",
    );
  });

  it("renders no badge (em-dash) when there are no messages", () => {
    renderTable([makeRow({ id: "p-none", engagement: "none" })]);
    expect(screen.queryByTestId("engagement-replying")).toBeNull();
    expect(screen.queryByTestId("engagement-contacted")).toBeNull();
  });
});

describe("<ProspectsTable /> last message preview column", () => {
  it("renders the truncated body in quotes when present", () => {
    renderTable([
      makeRow({
        id: "p-msg",
        engagement: "replying",
        last_message_preview: "Yes I'd like to hear more about your offer",
      }),
    ]);
    const cell = screen.getByTestId("prospects-last-message-p-msg");
    expect(cell.textContent).toContain(
      "Yes I'd like to hear more about your offer",
    );
    expect(cell.textContent).toContain("“"); // left double quote
  });

  it("renders an em-dash placeholder when there is no preview", () => {
    renderTable([makeRow({ id: "p-empty", last_message_preview: null })]);
    expect(screen.getByTestId("prospects-last-message-p-empty")).toHaveTextContent(
      "—",
    );
  });
});

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

  it("clicking the active column header flips direction asc -> desc (and clears the asc URL flag)", async () => {
    const user = userEvent.setup();
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search=""
        sort="address"
        dir="asc"
        blockStack={EMPTY_BLOCK_STACK}
        filtersParam={null}
        total={1}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByTestId("prospects-sort-address"));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    // Flipping address asc -> desc means dir is now the default (desc),
    // so it gets dropped from the URL — only sort= remains.
    expect(routerReplace.mock.calls[0][0]).toBe("/properties?sort=address");
  });

  it("preserves ?filters= across sort nav (Plan 09 — pagination/sort must not silently drop URL filter state)", async () => {
    const user = userEvent.setup();
    // Pass filtersParam as a plain marker so re-encoding semantics are
    // orthogonal to this assertion. The actual encode/decode contract is
    // symmetric and is exercised by filter-schema.test.ts; this test only
    // asserts that the param survives sort-nav at all (R8 / Plan 09).
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search=""
        sort="created_at"
        dir="desc"
        blockStack={[
          { id: "blk1", kind: "vacancy", tri: "yes" } as FilterBlock,
        ]}
        filtersParam={"sentinel-filters-value"}
        total={1}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByTestId("prospects-sort-address"));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    const url = routerReplace.mock.calls[0][0] as string;
    expect(url).toContain("sort=address");
    // Param key + value both present (URLSearchParams may re-encode the
    // value; the marker is plain ASCII so it stays verbatim).
    expect(url).toContain("filters=sentinel-filters-value");
  });
});

describe("<ProspectsTable /> address search", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

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

  it("clearing the search via the X button immediately drops ?search and resets to page 1", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search="Main"
        sort="created_at"
        dir="desc"
        blockStack={EMPTY_BLOCK_STACK}
        filtersParam={null}
        total={1}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByTestId("prospects-search-clear"));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    // search/sort/dir all default → URL collapses to bare path
    expect(routerReplace.mock.calls[0][0]).toBe("/properties");
  });
});

describe("<ProspectsTable /> select-all-across-pages banner", () => {
  beforeEach(() => {
    routerReplace.mockReset();
    getAllMatchingProspectIds.mockReset();
  });

  it("does not render the banner when nothing is selected", () => {
    renderTable([makeRow({ id: "p1" }), makeRow({ id: "p2" })]);
    expect(screen.queryByTestId("select-all-banner")).toBeNull();
  });

  it("does not render the banner when total fits on one page (page-select == matching-set)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // total === pageSize === 2; selecting both is equivalent to selecting all.
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" }), makeRow({ id: "p2" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search=""
        sort="created_at"
        dir="desc"
        blockStack={EMPTY_BLOCK_STACK}
        filtersParam={null}
        total={2}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));
    await user.click(screen.getByRole("checkbox", { name: "Select p2 Main St" }));
    expect(screen.queryByTestId("select-all-banner")).toBeNull();
  });

  it("renders the per-page banner when all visible rows are selected and there are more pages", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" }), makeRow({ id: "p2" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search=""
        sort="created_at"
        dir="desc"
        blockStack={EMPTY_BLOCK_STACK}
        filtersParam={null}
        total={1382}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));
    await user.click(screen.getByRole("checkbox", { name: "Select p2 Main St" }));

    const banner = await screen.findByTestId("select-all-banner");
    expect(banner.dataset.mode).toBe("per-page");
    expect(banner.textContent).toMatch(/All 2 on this page selected/);
    const link = screen.getByTestId("select-all-across-pages");
    expect(link.textContent).toMatch(/Select all 1,382 prospects/);
  });

  it("clicking 'Select all N' calls the action with search + an empty blockStack and switches the banner to all-matching mode", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    getAllMatchingProspectIds.mockResolvedValue({
      ok: true,
      data: Array.from({ length: 1382 }, (_, i) => `prop-${i}`),
    });
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search="oak"
        sort="created_at"
        dir="desc"
        blockStack={EMPTY_BLOCK_STACK}
        filtersParam={null}
        total={1382}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));
    await user.click(screen.getByTestId("select-all-across-pages"));

    expect(getAllMatchingProspectIds).toHaveBeenCalledWith({
      search: "oak",
      blockStack: EMPTY_BLOCK_STACK,
    });
    const banner = await screen.findByTestId("select-all-banner");
    expect(banner.dataset.mode).toBe("all-matching");
    expect(banner.textContent).toMatch(/All 1,382 prospects selected/);
  });

  it("Clear button empties the selection and hides the banner", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    getAllMatchingProspectIds.mockResolvedValue({
      ok: true,
      data: ["a", "b", "c"],
    });
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "a" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search=""
        sort="created_at"
        dir="desc"
        blockStack={EMPTY_BLOCK_STACK}
        filtersParam={null}
        total={3}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select a Main St" }));
    await user.click(screen.getByTestId("select-all-across-pages"));
    await screen.findByTestId("select-all-clear");
    await user.click(screen.getByTestId("select-all-clear"));
    expect(screen.queryByTestId("select-all-banner")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // R9 regression — select-all-across-pages must hand the active block stack
  // to getAllMatchingProspectIds so the resulting set covers the SAME rows
  // the page is rendering. Plan 09 swapped the legacy `filters` arg for
  // `blockStack`; this test pins the new contract so a future rewrite that
  // forgets to thread blockStack through (or accidentally re-introduces the
  // old chip-shape) fails fast.
  // -------------------------------------------------------------------------
  it("select-all-matching with an active block stack passes the stack to getAllMatchingProspectIds (R9)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    getAllMatchingProspectIds.mockResolvedValue({
      ok: true,
      data: Array.from({ length: 1382 }, (_, i) => `prop-${i}`),
    });
    const stack: FilterBlock[] = [
      { id: "blk-vac", kind: "vacancy", tri: "yes" } as FilterBlock,
      {
        id: "blk-cass",
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      } as FilterBlock,
    ];
    render(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search=""
        sort="created_at"
        dir="desc"
        blockStack={stack}
        filtersParam={"placeholder"}
        total={1382}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));
    await user.click(screen.getByTestId("select-all-across-pages"));

    expect(getAllMatchingProspectIds).toHaveBeenCalledWith({
      search: null,
      blockStack: expect.arrayContaining([
        expect.objectContaining({ kind: "vacancy", tri: "yes" }),
        expect.objectContaining({
          kind: "cass",
          combinator: "any",
          values: ["verified"],
        }),
      ]),
    });
    const banner = await screen.findByTestId("select-all-banner");
    expect(banner.dataset.mode).toBe("all-matching");
  });
});
