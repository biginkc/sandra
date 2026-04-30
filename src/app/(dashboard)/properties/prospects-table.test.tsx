import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import {
  ProspectsTable,
  type ListOption,
  type ProspectRow,
} from "./prospects-table";

// `next/navigation`'s real router needs an App Router context Vitest
// doesn't provide. Stub the bits the table actually calls.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
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
  };
}

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
});
