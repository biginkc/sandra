import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";

import {
  ProspectsTable,
  type ListOption,
  type ProspectRow,
} from "./prospects-table";
import type { FilterBlock } from "./prospects-query";
import { FILTER_NAVIGATION_START_EVENT } from "./_components/use-filter-state";

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
vi.mock("./dnc-safe-actions", () => ({
  addPropertiesToListBulk: vi.fn(async () => ({
    ok: true,
    data: { succeeded: 0, skipped: 0, failed: [] },
  })),
  applyTagBulk: vi.fn(),
  assignLeadsBulk: vi.fn(),
  createAndApplyCustomTagBulk: vi.fn(),
  createAndApplyCustomTagBulkFromFilters: vi.fn(),
  deletePropertiesBulk: vi.fn(),
  qualifyLeadsBulk: vi.fn(),
  removePropertiesFromListBulk: vi.fn(),
  setMotivationBulk: vi.fn(),
  verifyPropertiesBulk: vi.fn(),
  preflightProspectSkipTrace: vi.fn(async () => ({
    ok: true,
    data: {
      requested: 1,
      eligible: 1,
      cassVerified: 1,
      cassUnverified: 0,
      notEligible: 0,
      killSwitchSkipped: 0,
      tracefyCreditsRequired: 5,
      tracefyCreditsAvailable: 100,
      tracefyCreditStatus: "sufficient",
      canLaunchSkipTrace: true,
      estimatedCassVerificationCostUsd: 0,
      cassVerificationPropertyIds: [],
      dncLockedSkipped: 0,
    },
  })),
  requestProspectSkipTrace: vi.fn(),
}));

vi.mock("@/lib/skip-trace/actions", () => ({
  approveSkipTraceJob: vi.fn(),
  preflightSkipTrace: vi.fn(async () => ({
    ok: true,
    data: {
      requested: 1,
      eligible: 1,
      cassVerified: 1,
      cassUnverified: 0,
      notEligible: 0,
      killSwitchSkipped: 0,
      tracefyCreditsRequired: 5,
      tracefyCreditsAvailable: 100,
      tracefyCreditStatus: "sufficient",
      canLaunchSkipTrace: true,
      estimatedCassVerificationCostUsd: 0,
      cassVerificationPropertyIds: [],
    },
  })),
  requestSkipTrace: vi.fn(),
}));

const {
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  getAllMatchingProspectIds,
  getAllMatchingProspectSelection,
  previewBatchEligibilityAction,
} = vi.hoisted(() => ({
  createDialerBatchFromFilters: vi.fn(),
  createDialerBatchFromPropertyIds: vi.fn(),
  getAllMatchingProspectIds: vi.fn(),
  getAllMatchingProspectSelection: vi.fn(),
  previewBatchEligibilityAction: vi.fn(),
}));

vi.mock("./actions", () => ({
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  getAllMatchingProspectIds,
  getAllMatchingProspectSelection,
  previewBatchEligibilityAction,
}));

const { preflightPromoteLeads, createPromoteLeadsJob } = vi.hoisted(() => ({
  preflightPromoteLeads: vi.fn(),
  createPromoteLeadsJob: vi.fn(),
}));

vi.mock("./promote-leads-actions", () => ({
  preflightPromoteLeads,
  createPromoteLeadsJob,
}));

// Sonner's toast is fine in jsdom but the table's handlers don't fire
// in these tests; stub anyway to keep the surface noise-free.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function makeRow(overrides: Partial<ProspectRow> & { id: string }): ProspectRow {
  return {
    id: overrides.id,
    org_id: overrides.org_id ?? "org-1",
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
    imported_at: overrides.imported_at ?? null,
    dnc_reason: overrides.dnc_reason ?? null,
    channel_restriction: overrides.channel_restriction ?? null,
  };
}

const EMPTY_BLOCK_STACK: FilterBlock[] = [];

function renderTable(
  rows: ProspectRow[],
  lists: ListOption[] = [],
  overrides: Partial<React.ComponentProps<typeof ProspectsTable>> = {},
) {
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
      {...overrides}
    />,
  );
}

beforeEach(() => {
  createDialerBatchFromFilters.mockReset();
  createDialerBatchFromPropertyIds.mockReset();
  getAllMatchingProspectIds.mockReset();
  getAllMatchingProspectSelection.mockReset();
  previewBatchEligibilityAction.mockReset();
  preflightPromoteLeads.mockReset();
  createPromoteLeadsJob.mockReset();

  getAllMatchingProspectIds.mockResolvedValue({ ok: true, data: ["p1", "p2"] });
  getAllMatchingProspectSelection.mockResolvedValue({
    ok: true,
    data: { eligibleIds: ["p1", "p2"], eligibleCount: 2, dncLockedCount: 0, matchedCount: 2 },
  });
  previewBatchEligibilityAction.mockResolvedValue({
    ok: true,
    data: { callable: 1, blocked: {}, missing: 0 },
  });
  createDialerBatchFromPropertyIds.mockResolvedValue({
    ok: true,
    data: { batchId: "batch-table", counts: { callable: 1, blocked: {}, missing: 0 } },
  });
  createDialerBatchFromFilters.mockResolvedValue({
    ok: true,
    data: { batchId: "batch-table", counts: { callable: 1, blocked: {}, missing: 0 } },
  });
  preflightPromoteLeads.mockResolvedValue({
    ok: true,
    data: { selected: 1, eligible: 1, dncLocked: 0, staleOrNotProspect: 0 },
  });
});

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

    expect(screen.getByRole("link", { name: "Import prospects" })).toHaveAttribute("href", "/import");
  });

  it("renders DNC prospects locked and excludes them from select-all", async () => {
    const user = userEvent.setup();
    renderTable([
      makeRow({ id: "locked", dnc_reason: "Contact is marked do-not-contact." }),
      makeRow({ id: "eligible" }),
    ]);

    expect(screen.queryByRole("checkbox", { name: "Select locked Main St" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("locked Main St is locked Do Not Contact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /locked Main St/ })).toHaveAttribute(
      "href",
      "/leads/locked",
    );
    expect(screen.getByText("⊘ DO NOT CONTACT")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select all prospects on this page" }));
    expect(screen.getByRole("checkbox", { name: "Select eligible Main St" })).toBeChecked();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Actions for 1 selected/ })).toBeEnabled();
    });
  });

  it("keeps SMS opt-out as a channel label without locking selection", () => {
    renderTable([
      makeRow({ id: "sms-only", channel_restriction: "SMS opted out" }),
    ]);

    expect(screen.getByText("SMS opted out")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select sms-only Main St" })).toBeInTheDocument();
    expect(screen.queryByText("⊘ DO NOT CONTACT")).not.toBeInTheDocument();
  });

  it("renders outreach disposition pills with operator-facing labels", () => {
    const rows = [
      makeRow({ id: "p1", outreach_dispo: "nurture" }),
      makeRow({ id: "p2", outreach_dispo: "needs_sequence" }),
    ];

    renderTable(rows);

    expect(screen.getByText("Follow up")).toBeInTheDocument();
    expect(screen.getByText("Needs sequence")).toBeInTheDocument();
    expect(screen.queryByText("Nurture")).not.toBeInTheDocument();
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

  it("offers only teammates active in every selected workspace", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable(
      [
        makeRow({ id: "north", org_id: "org-north" }),
        makeRow({ id: "south", org_id: "org-south" }),
      ],
      [],
      {
        teamMembers: [
          { id: "shared", email: "shared@example.com", displayName: "Shared Rep" },
          { id: "north-only", email: "north@example.com", displayName: "North Rep" },
          { id: "south-only", email: "south@example.com", displayName: "South Rep" },
        ],
        teamMembersByOrg: {
          "org-north": [
            { id: "shared", email: "shared@example.com", displayName: "Shared Rep" },
            { id: "north-only", email: "north@example.com", displayName: "North Rep" },
          ],
          "org-south": [
            { id: "shared", email: "shared@example.com", displayName: "Shared Rep" },
            { id: "south-only", email: "south@example.com", displayName: "South Rep" },
          ],
        },
      },
    );
    await user.click(screen.getByLabelText("Select north Main St"));
    await user.click(screen.getByLabelText("Select south Main St"));
    await user.click(
      screen.getByRole("button", { name: /Actions for 2 selected/ }),
    );
    const trigger = await screen.findByRole("menuitem", { name: /Assign to/ });
    trigger.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitem", { name: /Shared Rep/ })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /North Rep/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /South Rep/ })).toBeNull();
  });

  it("bulk add-to-list calls the action with the selected ids and chosen list", async () => {
    const user = userEvent.setup({
      // Base UI's submenu portal sets pointer-events: none until the
      // submenu is fully open; user-event's strict default would refuse
      // to click through. Same shape Playwright defaults to anyway.
      pointerEventsCheck: 0,
    });
    const { addPropertiesToListBulk } = await import("./dnc-safe-actions");
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

  it("bulk apply existing tag calls the action with selected ids and the chosen tag", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { applyTagBulk } = await import("./dnc-safe-actions");
    vi.mocked(applyTagBulk).mockResolvedValue({
      ok: true,
      data: { succeeded: 2, skipped: 0, failed: [] },
    });
    const rows = [
      makeRow({ id: "p1", address: "1 Tagged Ave" }),
      makeRow({ id: "p2", address: "2 Tagged Ave" }),
    ];

    renderTable(rows, [], {
      tags: [{ id: "tag-hot", name: "Hot seller", color: null }],
    });

    for (const r of rows) {
      await user.click(
        screen.getByRole("checkbox", { name: `Select ${r.address}` }),
      );
    }

    await user.click(
      screen.getByRole("button", { name: /Actions for 2 selected/ }),
    );
    const applyTagTrigger = await screen.findByRole("menuitem", {
      name: /Apply tag/,
    });
    applyTagTrigger.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(
      await screen.findByRole("menuitem", { name: /Hot seller/ }),
    );

    await waitFor(() => {
      expect(applyTagBulk).toHaveBeenCalledWith(["p1", "p2"], "tag-hot");
    });
  });

  it("creates a new tag from the prospects page and applies it to selected ids", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { createAndApplyCustomTagBulk } = await import("./dnc-safe-actions");
    vi.mocked(createAndApplyCustomTagBulk).mockResolvedValue({
      ok: true,
      data: {
        tag: {
          id: "tag-new",
          name: "High intent",
          color: null,
          category: "custom",
          system_managed: false,
        },
        outcome: { succeeded: 2, skipped: 0, failed: [] },
      },
    });
    const rows = [
      makeRow({ id: "p1", address: "1 Intent Ave" }),
      makeRow({ id: "p2", address: "2 Intent Ave" }),
    ];

    renderTable(rows);

    for (const r of rows) {
      await user.click(
        screen.getByRole("checkbox", { name: `Select ${r.address}` }),
      );
    }

    await user.click(
      screen.getByRole("button", { name: /Actions for 2 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Create/apply tag" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 selected prospects")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Tag name"), "High intent");
    await user.click(
      screen.getByRole("button", { name: /Create #High intent and apply/ }),
    );

    await waitFor(() => {
      expect(createAndApplyCustomTagBulk).toHaveBeenCalledWith({
        name: "High intent",
        color: null,
        propertyIds: ["p1", "p2"],
      });
    });
  });

  it("keeps failed rows selected after create/apply tag partial failures", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { createAndApplyCustomTagBulk } = await import("./dnc-safe-actions");
    vi.mocked(createAndApplyCustomTagBulk).mockResolvedValue({
      ok: true,
      data: {
        tag: {
          id: "tag-new",
          name: "Retry tag",
          color: null,
          category: "custom",
          system_managed: false,
        },
        outcome: {
          succeeded: 1,
          skipped: 0,
          failed: [{ propertyId: "p2", message: "Property not found" }],
        },
      },
    });
    const rows = [
      makeRow({ id: "p1", address: "1 Partial Ave" }),
      makeRow({ id: "p2", address: "2 Partial Ave" }),
    ];

    renderTable(rows);
    for (const r of rows) {
      await user.click(
        screen.getByRole("checkbox", { name: `Select ${r.address}` }),
      );
    }
    await user.click(
      screen.getByRole("button", { name: /Actions for 2 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );
    await user.type(screen.getByLabelText("Tag name"), "Retry tag");
    await user.click(
      screen.getByRole("button", { name: /Create #Retry tag and apply/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Actions for 1 selected/ }),
      ).toBeEnabled();
    });
    expect(
      screen.getByRole("checkbox", { name: "Select 1 Partial Ave" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select 2 Partial Ave" }),
    ).toBeChecked();
  });

  it("does not submit an empty tag name or clear the current selection", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { createAndApplyCustomTagBulk } = await import("./dnc-safe-actions");
    const rows = [makeRow({ id: "p1", address: "1 Empty Ave" })];

    renderTable(rows);
    await user.click(
      screen.getByRole("checkbox", { name: "Select 1 Empty Ave" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );

    expect(
      screen.getByRole("button", { name: "Create/apply tag" }),
    ).toBeDisabled();
    expect(createAndApplyCustomTagBulk).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    ).toBeEnabled();
  });

  it("clears a typed tag name when the create/apply modal is canceled", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const rows = [makeRow({ id: "p1", address: "1 Cancel Ave" })];

    renderTable(rows);
    await user.click(
      screen.getByRole("checkbox", { name: "Select 1 Cancel Ave" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );
    await user.type(screen.getByLabelText("Tag name"), "Wrong wave");
    expect(screen.getByLabelText("Tag name")).toHaveValue("Wrong wave");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );
    expect(screen.getByLabelText("Tag name")).toHaveValue("");
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

  it("opens the promotion confirmation before creating a background job", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTable([makeRow({ id: "p1" })], [], { orgId: "org-1" });

    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));
    await user.click(screen.getByRole("button", { name: /Actions for 1 selected/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Promote to Lead/ }));

    expect(
      await screen.findByRole("heading", { name: "Promote selected Prospects to Leads?" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(preflightPromoteLeads).toHaveBeenCalledWith({
        orgId: "org-1",
        propertyIds: ["p1"],
      });
    });
    expect(createPromoteLeadsJob).not.toHaveBeenCalled();
  });

  it("opens Create dialer batch from the Actions menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const rows = [makeRow({ id: "p1" }), makeRow({ id: "p2" })];
    renderTable(rows);

    await user.click(
      screen.getByRole("checkbox", { name: "Select p1 Main St" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    );

    expect(
      await screen.findByRole("menuitem", { name: "Bulk SMS" }),
    ).toBeInTheDocument();
    const batchItem = await screen.findByRole("menuitem", {
      name: "Create dialer batch",
    });
    await user.click(batchItem);

    expect(
      await screen.findByRole("heading", { name: "Create dialer batch" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(previewBatchEligibilityAction).toHaveBeenCalledWith(["p1"]),
    );
  });

  it("opens skip-trace preflight from the bulk Enrich action", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { preflightProspectSkipTrace, requestProspectSkipTrace } = await import(
      "./dnc-safe-actions"
    );
    const rows = [makeRow({ id: "p1", address: "1 Tracefy Ave" })];
    renderTable(rows);

    await user.click(
      screen.getByRole("checkbox", { name: "Select 1 Tracefy Ave" }),
    );
    await user.click(
      screen.getByRole("button", { name: /Actions for 1 selected/ }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Skip trace" }));

    expect(
      await screen.findByRole("heading", {
        name: "Confirm skip-trace preflight",
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(preflightProspectSkipTrace).toHaveBeenCalledWith(["p1"]);
    });
    expect(requestProspectSkipTrace).not.toHaveBeenCalled();
  });

  it("shows table skeleton rows during FilterDrawer URL navigation", async () => {
    renderTable([makeRow({ id: "p1" }), makeRow({ id: "p2" })]);
    expect(screen.queryByTestId("prospects-skeleton-row")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event(FILTER_NAVIGATION_START_EVENT));
    });

    expect(await screen.findAllByTestId("prospects-skeleton-row")).toHaveLength(
      5,
    );
  });

  it("keeps filter skeleton rows visible until the server block stack catches up", async () => {
    const rows = [makeRow({ id: "p1" }), makeRow({ id: "p2" })];
    const nextBlock = {
      id: "vacancy-pending",
      kind: "vacancy",
      tri: "yes",
    } as const satisfies FilterBlock;
    const nextBlocks = [nextBlock];
    const { rerender } = renderTable(rows);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(FILTER_NAVIGATION_START_EVENT, {
          detail: { blocksKey: JSON.stringify(nextBlocks) },
        }),
      );
    });

    expect(await screen.findAllByTestId("prospects-skeleton-row")).toHaveLength(
      5,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(screen.getAllByTestId("prospects-skeleton-row")).toHaveLength(5);

    rerender(
      <ProspectsTable
        prospects={rows}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount={`Showing 1-${rows.length} of ${rows.length} prospects.`}
        search=""
        sort="created_at"
        dir="desc"
        blockStack={nextBlocks}
        filtersParam={null}
        total={1382}
        pageSize={50}
        page={1}
        totalPages={28}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("prospects-skeleton-row")).toBeNull();
    });
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
    getAllMatchingProspectSelection.mockReset();
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
    expect(banner.textContent).toMatch(/All 2 eligible prospects on this page selected/);
    const link = screen.getByTestId("select-all-across-pages");
    expect(link.textContent).toMatch(/Select all eligible matching prospects/);
  });

  it("clicking 'Select all N' calls the action with search + an empty blockStack and switches the banner to all-matching mode", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const eligibleIds = Array.from({ length: 1382 }, (_, i) => `prop-${i}`);
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds, eligibleCount: 1382, dncLockedCount: 0, matchedCount: 1382 },
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

    expect(getAllMatchingProspectSelection).toHaveBeenCalledWith({
      search: "oak",
      blockStack: EMPTY_BLOCK_STACK,
      imported: null,
    });
    const banner = await screen.findByTestId("select-all-banner");
    expect(banner.dataset.mode).toBe("all-matching");
    expect(banner.textContent).toMatch(/All 1,382 eligible prospects selected/);
  });

  it("uses the server eligible count and reports DNC-locked exclusions separately", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: {
        eligibleIds: ["p1"],
        eligibleCount: 1,
        dncLockedCount: 1,
        matchedCount: 2,
      },
    });
    renderTable([makeRow({ id: "p1" })], [], { total: 2, pageSize: 1 });

    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));
    await user.click(screen.getByTestId("select-all-across-pages"));

    const banner = await screen.findByTestId("select-all-banner");
    expect(banner).toHaveTextContent("All 1 eligible prospects selected");
    expect(banner).toHaveTextContent("1 DNC locked and excluded");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Actions for 1 selected/ })).toBeEnabled();
    });
  });

  it("create/apply tag after select-all-matching sends filters instead of every id", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { createAndApplyCustomTagBulk, createAndApplyCustomTagBulkFromFilters } =
      await import("./dnc-safe-actions");
    const allIds = Array.from({ length: 1382 }, (_, i) => `prop-${i}`);
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds: allIds, eligibleCount: 1382, dncLockedCount: 0, matchedCount: 1382 },
    });
    vi.mocked(createAndApplyCustomTagBulkFromFilters).mockResolvedValue({
      ok: true,
      data: {
        tag: {
          id: "tag-all",
          name: "Probate wave",
          color: null,
          category: "custom",
          system_managed: false,
        },
        outcome: { succeeded: 1382, skipped: 0, failed: [] },
      },
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
    await waitFor(() => {
      expect(screen.getByTestId("select-all-banner").textContent).toMatch(
        /All 1,382 eligible prospects selected/,
      );
    });
    await user.click(
      screen.getByRole("button", { name: /Actions for 1382 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );
    expect(
      await screen.findByText("All 1,382 matching prospects"),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Tag name"), "Probate wave");
    await user.click(
      screen.getByRole("button", { name: /Create #Probate wave and apply/ }),
    );

    await waitFor(() => {
      expect(createAndApplyCustomTagBulkFromFilters).toHaveBeenCalledWith({
        name: "Probate wave",
        color: null,
        search: "oak",
        blockStack: EMPTY_BLOCK_STACK,
        imported: null,
      });
    });
    expect(createAndApplyCustomTagBulk).not.toHaveBeenCalled();
  });

  it("manual row selection after select-all-matching clears all-matching mode", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const allIds = [
      "p1",
      ...Array.from({ length: 1381 }, (_, i) => `prop-${i}`),
    ];
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds: allIds, eligibleCount: 1382, dncLockedCount: 0, matchedCount: 1382 },
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
    await waitFor(() => {
      expect(screen.getByTestId("select-all-banner").textContent).toMatch(
        /All 1,382 eligible prospects selected/,
      );
    });

    await user.click(screen.getByRole("checkbox", { name: "Select p1 Main St" }));

    expect(screen.queryByTestId("select-all-banner")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Actions for 1381 selected/ }),
    ).toBeEnabled();
  });

  it("create/apply tag partial failure after select-all-matching clears all-matching mode", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { createAndApplyCustomTagBulkFromFilters } = await import("./dnc-safe-actions");
    const allIds = [
      "p1",
      ...Array.from({ length: 1381 }, (_, i) => `prop-${i}`),
    ];
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds: allIds, eligibleCount: 1382, dncLockedCount: 0, matchedCount: 1382 },
    });
    vi.mocked(createAndApplyCustomTagBulkFromFilters).mockResolvedValue({
      ok: true,
      data: {
        tag: {
          id: "tag-all-partial",
          name: "Retry all",
          color: null,
          category: "custom",
          system_managed: false,
        },
        outcome: {
          succeeded: 1381,
          skipped: 0,
          failed: [{ propertyId: "prop-7", message: "Property not found" }],
        },
      },
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
    await waitFor(() => {
      expect(screen.getByTestId("select-all-banner").textContent).toMatch(
        /All 1,382 eligible prospects selected/,
      );
    });
    await user.click(
      screen.getByRole("button", { name: /Actions for 1382 selected/ }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Create\/apply tag/ }),
    );
    await user.type(screen.getByLabelText("Tag name"), "Retry all");
    await user.click(
      screen.getByRole("button", { name: /Create #Retry all and apply/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Actions for 1 selected/ }),
      ).toBeEnabled();
    });
    expect(screen.queryByTestId("select-all-banner")).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select p1 Main St" }),
    ).not.toBeChecked();
  });

  it("clears a stale all-matching selection when search scope changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const eligibleIds = Array.from({ length: 1382 }, (_, i) => `prop-${i}`);
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds, eligibleCount: 1382, dncLockedCount: 0, matchedCount: 1382 },
    });
    const { rerender } = render(
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
    await waitFor(() => {
      expect(screen.getByTestId("select-all-banner").textContent).toMatch(
        /All 1,382 eligible prospects selected/,
      );
    });

    rerender(
      <ProspectsTable
        prospects={[makeRow({ id: "p1" })]}
        lists={[]}
        tags={[]}
        teamMembers={[]}
        currentUserId={null}
        canDelete={false}
        headerCount=""
        search="pine"
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

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Actions \(select prospects first\)/ }),
      ).toBeDisabled();
    });
    expect(screen.queryByTestId("select-all-banner")).toBeNull();
  });

  it("Clear button empties the selection and hides the banner", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds: ["a", "b", "c"], eligibleCount: 3, dncLockedCount: 0, matchedCount: 3 },
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
  // to getAllMatchingProspectSelection so the resulting set covers the SAME rows
  // the page is rendering. Plan 09 swapped the legacy `filters` arg for
  // `blockStack`; this test pins the new contract so a future rewrite that
  // forgets to thread blockStack through (or accidentally re-introduces the
  // old chip-shape) fails fast.
  // -------------------------------------------------------------------------
  it("select-all-matching with an active block stack passes the stack to getAllMatchingProspectSelection (R9)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const eligibleIds = Array.from({ length: 1382 }, (_, i) => `prop-${i}`);
    getAllMatchingProspectSelection.mockResolvedValue({
      ok: true,
      data: { eligibleIds, eligibleCount: 1382, dncLockedCount: 0, matchedCount: 1382 },
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

    expect(getAllMatchingProspectSelection).toHaveBeenCalledWith({
      search: null,
      imported: null,
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
