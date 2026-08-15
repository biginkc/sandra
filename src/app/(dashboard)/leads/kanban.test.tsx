import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dndHandlers, routerPush, updatePropertyStatus } = vi.hoisted(() => ({
  dndHandlers: {
    onDragStart: null as null | ((event: unknown) => void),
    onDragEnd: null as null | ((event: unknown) => Promise<void>),
  },
  routerPush: vi.fn(),
  updatePropertyStatus: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("./actions", () => ({
  updatePropertyStatus,
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: (promise: Promise<unknown>) => promise,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragStart: (event: unknown) => void;
    onDragEnd: (event: unknown) => Promise<void>;
  }) => {
    dndHandlers.onDragStart = onDragStart;
    dndHandlers.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: function PointerSensor() {},
  TouchSensor: function TouchSensor() {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    isDragging: false,
  }),
  useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
}));

import { Kanban, type Lead } from "./kanban";

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead-a",
    address: "123 Main St",
    city: "Kansas City",
    state: "MO",
    zip: "64111",
    market: "Jackson County MO",
    status: "new_lead",
    is_vacant: false,
    cass_status: "verified",
    absentee_flag: false,
    assigned_user_id: "user-me",
    motivation_level: "hot",
    outreach_dispo: "callback_requested",
    homeowner: {
      first_name: "Taylor",
      last_name: "Seller",
      entity_name: null,
    },
    ...overrides,
  };
}

const baseProps = {
  unreadPropertyIds: [] as string[],
  assigneeEmails: {
    "user-me": "me@example.com",
    "user-other": "teammate@example.com",
  },
  teamMembers: [
    { id: "user-me", email: "me@example.com" },
    { id: "user-other", email: "teammate@example.com" },
  ],
  currentUserId: "user-me",
  listMemberships: {},
  customTags: {},
  lastMessageByPropertyId: {},
  renderedAt: new Date().toISOString(),
};

function renderBoard(leads: Lead[]) {
  return render(<Kanban {...baseProps} initialLeads={leads} />);
}

function column(status: string): HTMLElement {
  const element = document.querySelector(`[data-status="${status}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing ${status} column`);
  }
  return element;
}

beforeEach(() => {
  window.localStorage.clear();
  updatePropertyStatus.mockReset();
  routerPush.mockReset();
  dndHandlers.onDragStart = null;
  dndHandlers.onDragEnd = null;
});

describe("Leads Kanban foundation", () => {
  it("renders the approved column order and defaults Closed/Dead to collapsed without a stored preference", () => {
    renderBoard([makeLead()]);
    expect(
      Array.from(document.querySelectorAll("[data-status]")).map((element) =>
        element.getAttribute("data-status"),
      ),
    ).toEqual([
      "new_lead",
      "contacted",
      "interested",
      "offer_sent",
      "offer_declined",
      "under_contract",
      "closed",
      "dead",
    ]);
    expect(screen.getByRole("button", { name: "Expand Closed" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Expand Dead" })).toBeVisible();

  });

  it("restores and updates a valid collapsed-column preference", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "sandra.leads.collapsed",
      JSON.stringify(["interested"]),
    );
    renderBoard([makeLead()]);

    expect(
      await screen.findByRole("button", { name: "Expand Interested" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse Closed" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Collapse Closed" }));
    expect(JSON.parse(window.localStorage.getItem("sandra.leads.collapsed")!)).toEqual(
      expect.arrayContaining(["interested", "closed"]),
    );
  });

  it("defaults to All leads and keeps My leads and teammate selection exclusive", async () => {
    const user = userEvent.setup();
    renderBoard([
      makeLead(),
      makeLead({
        id: "lead-b",
        address: "456 Oak Ave",
        assigned_user_id: "user-other",
      }),
    ]);

    const all = screen.getByRole("button", { name: "All leads" });
    const mine = screen.getByRole("button", { name: "My leads" });
    const teammateSelect = screen.getByRole("combobox", {
      name: "Choose a teammate",
    });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(mine).toHaveAttribute("aria-pressed", "false");
    expect(teammateSelect).toHaveValue("");
    expect(screen.getByText("123 Main St")).toBeVisible();
    expect(screen.getByText("456 Oak Ave")).toBeVisible();

    await user.click(mine);
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(mine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("123 Main St")).toBeVisible();
    expect(screen.queryByText("456 Oak Ave")).not.toBeInTheDocument();

    await user.selectOptions(teammateSelect, "user-other");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(mine).toHaveAttribute("aria-pressed", "false");
    expect(teammateSelect).toHaveValue("user-other");
    expect(screen.queryByText("123 Main St")).not.toBeInTheDocument();
    expect(screen.getByText("456 Oak Ave")).toBeVisible();
  });

  it("keeps filters visit-only and Reset all restores the default view", async () => {
    const user = userEvent.setup();
    renderBoard([
      makeLead(),
      makeLead({ id: "lead-b", address: "456 Oak Ave", motivation_level: "cold" }),
    ]);

    await user.type(screen.getByRole("textbox", { name: "Search leads" }), "Main");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by motivation" }),
      "hot",
    );
    expect(screen.getByRole("button", { name: "Reset all (2)" })).toBeVisible();
    expect(window.localStorage.length).toBe(0);

    await user.click(screen.getByRole("button", { name: "Reset all (2)" }));
    expect(screen.getByRole("textbox", { name: "Search leads" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Filter by motivation" })).toHaveValue(
      "all",
    );
    expect(screen.queryByRole("button", { name: /Reset all \(/ })).not.toBeInTheDocument();
  });

  it("shows board-level no-results with removable chips", async () => {
    const user = userEvent.setup();
    renderBoard([makeLead()]);

    await user.type(
      screen.getByRole("textbox", { name: "Search leads" }),
      "not-a-real-lead",
    );
    expect(screen.getByText("No leads match these filters")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Search: not-a-real-lead/ }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Reset all" }));
    expect(screen.getByText("123 Main St")).toBeVisible();
  });

  it("shows homeowner/location and a directional one-line message with age", () => {
    const renderedAtMs = Date.now();
    const createdAt = new Date(
      renderedAtMs - 3 * 24 * 60 * 60 * 1000,
    ).toISOString();
    render(
      <Kanban
        {...baseProps}
        renderedAt={new Date(renderedAtMs).toISOString()}
        initialLeads={[makeLead()]}
        lastMessageByPropertyId={{
          "lead-a": {
            direction: "inbound",
            body: "Can you call me tomorrow?",
            createdAt,
          },
        }}
      />,
    );

    expect(screen.getByText("Taylor Seller · Kansas City, MO")).toBeVisible();
    expect(screen.getByTestId("leadcard-last-message-lead-a")).toHaveTextContent(
      "Them: Can you call me tomorrow? · 3d",
    );
  });

  it("shows No messages when a lead has no message history", () => {
    renderBoard([makeLead()]);
    expect(screen.getByTestId("leadcard-last-message-lead-a")).toHaveTextContent(
      "No messages",
    );
  });

  it("opens a lead from the card with the keyboard", async () => {
    const user = userEvent.setup();
    renderBoard([makeLead()]);

    const card = screen.getByRole("link", { name: "Open lead at 123 Main St" });
    card.focus();
    await user.keyboard("{Enter}");

    expect(routerPush).toHaveBeenCalledWith("/leads/lead-a");
  });

  it("reverts a failed move, keeps a Retry marker, then moves after a verified retry", async () => {
    const user = userEvent.setup();
    updatePropertyStatus
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "STATUS_UPDATE_NOT_SAVED", message: "not saved" },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { propertyId: "lead-a", status: "contacted" },
      });
    renderBoard([makeLead()]);

    await act(async () => {
      await dndHandlers.onDragEnd?.({
        active: { id: "lead-a" },
        over: { id: "contacted" },
      });
    });

    expect(within(column("new_lead")).getByText("123 Main St")).toBeVisible();
    expect(
      screen.getByText("Couldn't move to Contacted. Not saved."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await within(column("contacted")).findByText("123 Main St")).toBeVisible();
    expect(
      screen.queryByText("Couldn't move to Contacted. Not saved."),
    ).not.toBeInTheDocument();
    expect(updatePropertyStatus).toHaveBeenCalledTimes(2);
    expect(updatePropertyStatus).toHaveBeenNthCalledWith(
      1,
      "lead-a",
      "contacted",
      "new_lead",
    );
    expect(updatePropertyStatus).toHaveBeenNthCalledWith(
      2,
      "lead-a",
      "contacted",
      "new_lead",
    );
  });
});
