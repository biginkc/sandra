import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import {
  ProspectsTable,
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
// server client at module load. Replace them with no-op stubs — these
// tests don't open the Actions menu, so the action handlers never fire.
vi.mock("../leads/actions", () => ({
  addPropertiesToListBulk: vi.fn(),
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

function renderTable(rows: ProspectRow[]) {
  return render(
    <ProspectsTable
      prospects={rows}
      lists={[]}
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
});
