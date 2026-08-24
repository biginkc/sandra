import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dndHandlers, dragPointerDown, routerPush, routerRefresh, updatePropertyStatus, loadLeadBoardAction, setLeadNextActionAction } = vi.hoisted(() => ({
  dndHandlers: {
    onDragStart: null as null | ((event: unknown) => void),
    onDragEnd: null as null | ((event: unknown) => Promise<void>),
  },
  dragPointerDown: vi.fn(),
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
  updatePropertyStatus: vi.fn(),
  loadLeadBoardAction: vi.fn((_input: unknown) => new Promise(() => {})),
  setLeadNextActionAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, refresh: routerRefresh }),
}));

vi.mock("./actions", () => ({
  updatePropertyStatus,
}));

vi.mock("./board-actions", () => ({
  loadLeadBoardAction,
  setLeadNextActionAction,
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
    listeners: { onPointerDown: dragPointerDown },
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
    homeowner_sms_opted_out: false,
    homeowner_sms_opted_out_at: null,
    homeowner: {
      first_name: "Taylor",
      last_name: "Seller",
      entity_name: null,
    },
    has_unread: false,
    next_task_id: null,
    next_task_title: null,
    next_task_due_at: null,
    ...overrides,
  };
}

const baseProps = {
  initialTotals: {
    prospect: 0,
    new_lead: 1,
    contacted: 0,
    interested: 0,
    offer_sent: 0,
    offer_declined: 0,
    under_contract: 0,
    closed: 0,
    dead: 0,
  },
  initialBaselineTotals: {
    prospect: 0,
    new_lead: 1,
    contacted: 0,
    interested: 0,
    offer_sent: 0,
    offer_declined: 0,
    under_contract: 0,
    closed: 0,
    dead: 0,
  },
  initialUrgencyCounts: { all: 1, overdue: 0, today: 0, scheduled: 0, none: 1 },
  initialNextCursors: {},
  initialHasMore: {},
  initialSnapshotGenerations: {},
  initialFilters: {
    search: "",
    ownership: "all" as const,
    motivation: "all" as const,
    urgency: "all" as const,
    attention: null,
    hotOnly: false,
    noActiveSequence: false,
    skipTraced: null,
  },
  dayStart: "2026-08-15T05:00:00.000Z",
  dayEnd: "2026-08-16T05:00:00.000Z",
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

function emptyBoardData() {
  const totals = Object.fromEntries(
    Object.keys(baseProps.initialTotals).map((status) => [status, 0]),
  ) as typeof baseProps.initialTotals;
  return {
    leads: [],
    totals,
    baselineTotals: totals,
    urgencyCounts: { all: 0, overdue: 0, today: 0, scheduled: 0, none: 0 },
    nextCursors: {},
    hasMore: {},
    snapshotGenerations: {},
    unreadPropertyIds: [],
    listMemberships: {},
    customTags: {},
    lastMessageByPropertyId: {},
  };
}

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
  vi.restoreAllMocks();
  window.localStorage.clear();
  updatePropertyStatus.mockReset();
  loadLeadBoardAction.mockReset();
  loadLeadBoardAction.mockImplementation(() => new Promise(() => {}));
  setLeadNextActionAction.mockReset();
  routerPush.mockReset();
  routerRefresh.mockReset();
  dragPointerDown.mockReset();
  dndHandlers.onDragStart = null;
  dndHandlers.onDragEnd = null;
});

describe("Leads Kanban foundation", () => {
  it("shows the approved urgency strip without a suppressed bucket", () => {
    renderBoard([makeLead()]);
    const strip = screen.getByLabelText("Lead urgency");
    expect(within(strip).getByRole("button", { name: "All 1" })).toHaveAttribute("aria-pressed", "true");
    expect(within(strip).getByRole("button", { name: "Overdue 0" })).toBeVisible();
    expect(within(strip).getByRole("button", { name: "Due today 0" })).toBeVisible();
    expect(within(strip).getByRole("button", { name: "Scheduled later 0" })).toBeVisible();
    expect(within(strip).getByRole("button", { name: "No next action 1" })).toBeVisible();
    expect(within(strip).queryByText(/suppressed/i)).not.toBeInTheDocument();
  });

  it("shows SMS-only suppression as a channel restriction, not permanent DNC", () => {
    renderBoard([
      makeLead({
        outreach_dispo: null,
        homeowner_sms_opted_out: true,
        homeowner_sms_opted_out_at: "2026-08-15T14:00:00.000Z",
      }),
    ]);

    expect(screen.getByText("SMS opted out")).toBeVisible();
    expect(screen.queryByText(/DO NOT CONTACT/i)).not.toBeInTheDocument();
  });

  it("renders overdue, today, scheduled, and no-action rows in urgency order", () => {
    renderBoard([
      makeLead({ id: "none", address: "None St" }),
      makeLead({ id: "later", address: "Later St", next_task_id: "task-l", next_task_title: "Follow up on Later St", next_task_due_at: "2026-08-18T15:00:00.000Z" }),
      makeLead({ id: "today", address: "Today St", next_task_id: "task-t", next_task_title: "Follow up on Today St", next_task_due_at: "2026-08-15T15:30:00.000Z" }),
      makeLead({ id: "overdue", address: "Overdue St", next_task_id: "task-o", next_task_title: "Follow up on Overdue St", next_task_due_at: "2026-08-13T15:00:00.000Z" }),
    ]);

    const cards = within(column("new_lead")).getAllByRole("link", { name: /Open lead at/ }).map((card) => card.getAttribute("aria-label"));
    expect(cards).toEqual([
      "Open lead at Overdue St",
      "Open lead at Today St",
      "Open lead at Later St",
      "Open lead at None St",
    ]);
    expect(screen.getByTestId("leadcard-next-action-overdue")).toHaveTextContent("Overdue 2d");
    expect(screen.getByTestId("leadcard-next-action-today")).toHaveTextContent("Today 10:30 AM");
    expect(screen.getByTestId("leadcard-next-action-later")).toHaveTextContent("Tue, Aug 18");
    expect(screen.getByTestId("leadcard-next-action-none")).toHaveTextContent("No next action");
  });

  it("retries an inline next action with one idempotency key and only updates after proven save", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");
    setLeadNextActionAction
      .mockResolvedValueOnce({ ok: false, error: { code: "NEXT_ACTION_FAILED", message: "Temporary failure" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "task-1", title: "Follow up on 123 Main St", dueAt: "2026-08-16T14:00:00.000Z", created: true } });
    renderBoard([makeLead({ id: "11111111-1111-4111-8111-111111111111" })]);

    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.type(screen.getByLabelText("Due date and time"), "2026-08-16T09:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Temporary failure\s+Not saved\./);
    expect(screen.getByTestId("leadcard-next-action-11111111-1111-4111-8111-111111111111")).toHaveTextContent("No next action");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(setLeadNextActionAction).toHaveBeenCalledTimes(2));
    expect(setLeadNextActionAction.mock.calls[0][0].idempotencyKey).toBe("22222222-2222-4222-8222-222222222222");
    expect(setLeadNextActionAction.mock.calls[1][0].idempotencyKey).toBe("22222222-2222-4222-8222-222222222222");
    expect(screen.getByTestId("leadcard-next-action-11111111-1111-4111-8111-111111111111")).toHaveTextContent("Sun, Aug 16");
  });

  it("uses a fresh idempotency key for a later Set cycle on the same mounted card", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333");
    setLeadNextActionAction
      .mockResolvedValueOnce({ ok: true, data: { id: "task-1", title: "First follow up", dueAt: "2026-08-16T14:00:00.000Z", created: true } })
      .mockResolvedValueOnce({ ok: true, data: { id: "task-2", title: "Second follow up", dueAt: "2026-08-17T14:00:00.000Z", created: true } });
    loadLeadBoardAction
      .mockResolvedValueOnce({
        ok: true,
        data: {
          leads: [makeLead({ id: "11111111-1111-4111-8111-111111111111" })],
          totals: baseProps.initialTotals,
          urgencyCounts: baseProps.initialUrgencyCounts,
          nextCursors: {}, hasMore: {}, unreadPropertyIds: [],
          listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
        },
      })
      .mockImplementation(() => new Promise(() => {}));
    renderBoard([makeLead({ id: "11111111-1111-4111-8111-111111111111" })]);

    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.type(screen.getByLabelText("Due date and time"), "2026-08-16T09:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Set" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.type(screen.getByLabelText("Due date and time"), "2026-08-17T09:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setLeadNextActionAction).toHaveBeenCalledTimes(2));
    expect(setLeadNextActionAction.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("recovers inline Set from a rejected transport promise", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");
    setLeadNextActionAction.mockRejectedValueOnce(new Error("network disconnected"));
    renderBoard([makeLead()]);

    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.type(screen.getByLabelText("Due date and time"), "2026-08-16T09:00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the next action. Not saved.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("removes a stale card when inline Set discovers permanent DNC", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");
    setLeadNextActionAction.mockResolvedValue({
      ok: false,
      error: { code: "DNC_LOCKED", message: "This lead is permanently read-only." },
    });
    loadLeadBoardAction.mockResolvedValue({ ok: true, data: emptyBoardData() });
    renderBoard([makeLead({ id: "11111111-1111-4111-8111-111111111111" })]);

    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.type(screen.getByLabelText("Due date and time"), "2026-08-16T09:00");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText("123 Main St")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "All 0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "No next action 0" })).toBeVisible();
    expect(within(column("new_lead")).getByLabelText("0 matching, 0 total")).toHaveTextContent("0");
  });

  it("reconciles a delayed Set with the current filter generation", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");
    let resolveSet!: (value: unknown) => void;
    setLeadNextActionAction.mockImplementationOnce(() => new Promise((resolve) => { resolveSet = resolve; }));
    loadLeadBoardAction.mockResolvedValue({
      ok: true,
      data: {
        leads: [makeLead()], totals: baseProps.initialTotals,
        urgencyCounts: baseProps.initialUrgencyCounts,
        nextCursors: {}, hasMore: {}, unreadPropertyIds: [],
        listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
      },
    });
    renderBoard([makeLead()]);

    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.type(screen.getByLabelText("Due date and time"), "2026-08-16T09:00");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "My leads" }));
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(1));

    resolveSet({ ok: true, data: { id: "task-1", title: "Follow up", dueAt: "2026-08-16T14:00:00.000Z", created: true } });
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(2));
    expect(loadLeadBoardAction.mock.calls.every(([request]) =>
      (request as { filters: { ownership: string } }).filters.ownership === "mine",
    )).toBe(true);
  });

  it("re-queries visit-only urgency on the server and keeps the URL unchanged", async () => {
    const user = userEvent.setup();
    loadLeadBoardAction.mockResolvedValueOnce({
      ok: true,
      data: {
        leads: [], totals: { ...baseProps.initialTotals, new_lead: 0 },
        nextCursors: {}, hasMore: {}, unreadPropertyIds: [],
        urgencyCounts: { all: 5, overdue: 2, today: 1, scheduled: 1, none: 1 },
        listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
      },
    });
    renderBoard([makeLead()]);
    await user.click(screen.getByRole("button", { name: "Overdue 0" }));
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalled(), { timeout: 1000 });
    const request = loadLeadBoardAction.mock.calls.at(-1)?.[0] as { filters: { urgency: string } };
    expect(request.filters.urgency).toBe("overdue");
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "All 5" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overdue 2" })).toHaveAttribute("aria-pressed", "true");
  });

  it("recovers a full refresh from a rejected transport promise", async () => {
    const user = userEvent.setup();
    loadLeadBoardAction.mockRejectedValueOnce(new Error("network disconnected"));
    renderBoard([makeLead()]);

    await user.click(screen.getByRole("button", { name: "Overdue 0" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't refresh your leads.");
    expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("discards an in-flight column page when the active filter changes", async () => {
    const user = userEvent.setup();
    let resolvePage!: (value: unknown) => void;
    loadLeadBoardAction.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePage = resolve; }),
    );
    render(
      <Kanban
        {...baseProps}
        initialLeads={[makeLead()]}
        initialHasMore={{ new_lead: true }}
        initialNextCursors={{
          new_lead: { dueAt: null, id: "11111111-1111-4111-8111-111111111111" },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more New Lead" }));
    await user.click(screen.getByRole("button", { name: "Overdue 0" }));
    await act(async () => {
      resolvePage({
        ok: true,
        data: {
          leads: [makeLead({
            id: "33333333-3333-4333-8333-333333333333",
            address: "Stale Page Card",
            next_task_id: "task-stale",
            next_task_title: "Follow up on Stale Page Card",
            next_task_due_at: "2026-08-13T15:00:00.000Z",
          })],
          totals: { ...baseProps.initialTotals, new_lead: 99 },
          nextCursors: {}, hasMore: { new_lead: false }, unreadPropertyIds: [],
          urgencyCounts: null,
          listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
        },
      });
      await Promise.resolve();
    });

    expect(screen.queryByText("Stale Page Card")).not.toBeInTheDocument();
  });

  it("cannot use an old-filter cursor while the new filter refresh is pending", async () => {
    const user = userEvent.setup();
    let resolveRefresh!: (value: unknown) => void;
    loadLeadBoardAction.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );
    render(
      <Kanban
        {...baseProps}
        initialLeads={[makeLead()]}
        initialHasMore={{ new_lead: true }}
        initialNextCursors={{
          new_lead: { dueAt: null, id: "11111111-1111-4111-8111-111111111111" },
        }}
      />,
    );
    const oldLoadMore = screen.getByRole("button", { name: "Load more New Lead" });

    await user.click(screen.getByRole("button", { name: "Overdue 0" }));
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Load more New Lead" })).not.toBeInTheDocument();
    fireEvent.click(oldLoadMore);
    expect(loadLeadBoardAction).toHaveBeenCalledTimes(1);

    resolveRefresh({
      ok: true,
      data: {
        leads: [], totals: { ...baseProps.initialTotals, new_lead: 0 },
        urgencyCounts: { all: 1, overdue: 0, today: 0, scheduled: 0, none: 1 },
        nextCursors: {}, hasMore: {}, unreadPropertyIds: [],
        listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
      },
    });
    await waitFor(() => expect(screen.queryByText("Refreshing…")).not.toBeInTheDocument());
  });

  it("refreshes the full board when a later page reports a changed snapshot count", async () => {
    const user = userEvent.setup();
    loadLeadBoardAction
      .mockResolvedValueOnce({
        ok: true,
        data: {
          leads: [], totals: { ...baseProps.initialTotals, new_lead: 2 },
          nextCursors: {}, hasMore: { new_lead: false }, unreadPropertyIds: [],
          urgencyCounts: null,
          listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          leads: [makeLead()], totals: baseProps.initialTotals,
          nextCursors: {}, hasMore: {}, unreadPropertyIds: [],
          urgencyCounts: baseProps.initialUrgencyCounts,
          listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
        },
      });
    render(
      <Kanban
        {...baseProps}
        initialLeads={[makeLead()]}
        initialHasMore={{ new_lead: true }}
        initialNextCursors={{
          new_lead: { dueAt: null, id: "11111111-1111-4111-8111-111111111111" },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more New Lead" }));
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(2));
    expect(loadLeadBoardAction).toHaveBeenLastCalledWith({ filters: baseProps.initialFilters });
  });

  it("replaces the board when an equal-count concurrent swap changes the server snapshot", async () => {
    const user = userEvent.setup();
    const replacement = makeLead({
      id: "44444444-4444-4444-8444-444444444444",
      address: "Replacement Before Cursor",
    });
    loadLeadBoardAction
      .mockResolvedValueOnce({
        ok: true,
        data: {
          leads: [makeLead({
            id: "33333333-3333-4333-8333-333333333333",
            address: "Incoming After Cursor",
          })],
          totals: { ...baseProps.initialTotals, new_lead: 2 },
          nextCursors: {}, hasMore: { new_lead: false },
          snapshotGenerations: { new_lead: "generation-b" },
          unreadPropertyIds: [], urgencyCounts: null, baselineTotals: null,
          listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          leads: [replacement],
          totals: { ...baseProps.initialTotals, new_lead: 1 },
          nextCursors: {}, hasMore: { new_lead: false },
          snapshotGenerations: { new_lead: "generation-b" },
          unreadPropertyIds: [],
          urgencyCounts: { all: 1, overdue: 0, today: 0, scheduled: 0, none: 1 },
          baselineTotals: { ...baseProps.initialTotals, new_lead: 1 },
          listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
        },
      });
    render(
      <Kanban
        {...baseProps}
        initialLeads={[makeLead({ id: "11111111-1111-4111-8111-111111111111" })]}
        initialTotals={{ ...baseProps.initialTotals, new_lead: 2 }}
        initialHasMore={{ new_lead: true }}
        initialSnapshotGenerations={{ new_lead: "generation-a" }}
        initialNextCursors={{
          new_lead: { dueAt: null, id: "11111111-1111-4111-8111-111111111111" },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more New Lead" }));
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Incoming After Cursor")).not.toBeInTheDocument();
    expect(await screen.findByText("Replacement Before Cursor")).toBeVisible();
    expect(loadLeadBoardAction).toHaveBeenLastCalledWith({ filters: baseProps.initialFilters });
  });

  it("recovers Load more from a rejected transport promise", async () => {
    const user = userEvent.setup();
    loadLeadBoardAction.mockRejectedValueOnce(new Error("network disconnected"));
    render(
      <Kanban
        {...baseProps}
        initialLeads={[makeLead()]}
        initialHasMore={{ new_lead: true }}
        initialNextCursors={{
          new_lead: { dueAt: null, id: "11111111-1111-4111-8111-111111111111" },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Load more New Lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load more New Lead leads.");
    expect(screen.getByRole("button", { name: "Load more New Lead" })).toBeEnabled();
  });

  it("reconciles a delayed drag with the current filter generation", async () => {
    const user = userEvent.setup();
    let resolveMove!: (value: unknown) => void;
    updatePropertyStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveMove = resolve; }));
    loadLeadBoardAction.mockResolvedValue({
      ok: true,
      data: {
        leads: [], totals: { ...baseProps.initialTotals, new_lead: 0 },
        urgencyCounts: { all: 1, overdue: 0, today: 0, scheduled: 0, none: 1 },
        nextCursors: {}, hasMore: {}, unreadPropertyIds: [],
        listMemberships: {}, customTags: {}, lastMessageByPropertyId: {},
      },
    });
    renderBoard([makeLead()]);
    let movePromise: Promise<void> | undefined;
    act(() => {
      movePromise = dndHandlers.onDragEnd?.({ active: { id: "lead-a" }, over: { id: "contacted" } });
    });
    await user.click(screen.getByRole("button", { name: "Overdue 0" }));
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(1));

    resolveMove({ ok: true, data: { status: "contacted" } });
    await act(async () => { await movePromise; });
    await waitFor(() => expect(loadLeadBoardAction).toHaveBeenCalledTimes(2));
    expect(loadLeadBoardAction.mock.calls.every(([request]) =>
      (request as { filters: { urgency: string } }).filters.urgency === "overdue",
    )).toBe(true);
  });

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

  it("keeps matching/total badges compact while exposing loaded detail", () => {
    render(
      <Kanban
        {...baseProps}
        initialLeads={[makeLead()]}
        initialTotals={{ ...baseProps.initialTotals, new_lead: 37, closed: 4 }}
        initialBaselineTotals={{ ...baseProps.initialBaselineTotals, new_lead: 48, closed: 10 }}
        initialHasMore={{ new_lead: true }}
      />,
    );

    const newLeadBadge = within(column("new_lead")).getByLabelText("1 loaded, 37 matching, 48 total");
    expect(newLeadBadge).toHaveTextContent("1/37");
    expect(newLeadBadge.textContent?.length).toBeLessThanOrEqual(5);
    const collapsedBadge = within(column("closed")).getByLabelText("0 loaded, 4 matching, 10 total");
    expect(collapsedBadge).toHaveTextContent("0/4");
  });

  it("shows matching/total once every filtered match is loaded", () => {
    render(
      <Kanban
        {...baseProps}
        initialLeads={[
          makeLead({ id: "lead-1" }),
          makeLead({ id: "lead-2", address: "2 Main St" }),
          makeLead({ id: "lead-3", address: "3 Main St" }),
        ]}
        initialTotals={{ ...baseProps.initialTotals, new_lead: 3 }}
        initialBaselineTotals={{ ...baseProps.initialBaselineTotals, new_lead: 48 }}
      />,
    );
    expect(within(column("new_lead")).getByLabelText("3 matching, 48 total")).toHaveTextContent("3/48");
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
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("initializes a validated dashboard ownership filter and Reset restores the full board", async () => {
    const user = userEvent.setup();
    render(
      <Kanban
        {...baseProps}
        initialOwnership="mine"
        hasInboundFilter
        initialLeads={[
          makeLead(),
          makeLead({
            id: "lead-b",
            address: "456 Oak Ave",
            assigned_user_id: "user-other",
          }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "My leads" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("123 Main St")).toBeVisible();
    expect(screen.queryByText("456 Oak Ave")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reset all (1)" }));
    expect(routerPush).toHaveBeenCalledWith("/leads");
  });

  it("routes an inbound unassigned queue to the validated My leads queue", async () => {
    const user = userEvent.setup();
    render(
      <Kanban
        {...baseProps}
        initialOwnership="unassigned"
        hasInboundFilter
        initialLeads={[
          makeLead({ assigned_user_id: null }),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "My leads" }));
    expect(routerPush).toHaveBeenCalledWith("/leads?assignee=me");
  });

  it("routes an inbound My leads queue to a validated teammate queue", async () => {
    const user = userEvent.setup();
    render(
      <Kanban
        {...baseProps}
        initialOwnership="mine"
        hasInboundFilter
        initialLeads={[makeLead()]}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Choose a teammate" }),
      "user-other",
    );
    expect(routerPush).toHaveBeenCalledWith("/leads?assignee=user-other");
  });

  it("routes an inbound ownership queue to the active unassigned queue", async () => {
    const user = userEvent.setup();
    render(
      <Kanban
        {...baseProps}
        initialOwnership="mine"
        hasInboundFilter
        initialLeads={[makeLead()]}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Choose a teammate" }),
      "unassigned",
    );
    expect(routerPush).toHaveBeenCalledWith("/leads?unassigned=true");
  });

  it("shows inbound unassigned and attention filters truthfully and resets through the bare board", async () => {
    const user = userEvent.setup();
    const leads = [
      makeLead(),
      makeLead({
        id: "lead-unassigned",
        address: "789 Unassigned Rd",
        assigned_user_id: null,
      }),
    ];
    const view = render(
      <Kanban
        {...baseProps}
        initialOwnership="unassigned"
        hasInboundFilter
        initialLeads={leads}
      />,
    );

    expect(screen.getByText("789 Unassigned Rd")).toBeVisible();
    expect(screen.queryByText("123 Main St")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unassigned" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reset all (1)" }));
    expect(routerPush).toHaveBeenCalledWith("/leads");

    view.unmount();
    routerPush.mockClear();
    render(
      <Kanban
        {...baseProps}
        initialAttentionFilter="stale"
        hasInboundFilter
        initialFilters={{ ...baseProps.initialFilters, attention: "stale" }}
        initialLeads={[leads[1]]}
      />,
    );
    expect(screen.getByRole("button", { name: /Stale conversations/ })).toBeVisible();
    expect(screen.getByText("789 Unassigned Rd")).toBeVisible();
    expect(screen.queryByText("123 Main St")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset all (1)" }));
    expect(routerPush).toHaveBeenCalledWith("/leads");
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

  it("renders a native lead link without handing link gestures to card navigation or dragging", () => {
    renderBoard([makeLead()]);

    const link = screen.getByRole("link", { name: "Open lead at 123 Main St" });
    const card = screen.getByRole("group", { name: "Lead at 123 Main St" });
    const setButton = screen.getByRole("button", { name: "Set" });

    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/leads/lead-a");
    expect(link).not.toHaveAttribute("target", "_blank");
    link.focus();
    expect(link).toHaveFocus();

    link.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { metaKey: true });
    expect(routerPush).not.toHaveBeenCalled();

    fireEvent.pointerDown(link);
    fireEvent.pointerDown(setButton);
    expect(dragPointerDown).not.toHaveBeenCalled();

    fireEvent.pointerDown(card);
    expect(dragPointerDown).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Taylor Seller · Kansas City, MO"));
    expect(routerPush).toHaveBeenCalledWith("/leads/lead-a");
  });

  it("reconciles a stale move to the authoritative stage and retries from there", async () => {
    const user = userEvent.setup();
    updatePropertyStatus
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "STATUS_CONFLICT",
          message: "changed elsewhere",
          details: { currentStatus: "interested" },
        },
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

    expect(within(column("interested")).getByText("123 Main St")).toBeVisible();
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
      "interested",
    );
  });

  it("removes a card when a stale move discovers the permanent DNC lock", async () => {
    updatePropertyStatus.mockResolvedValue({
      ok: false,
      error: { code: "DNC_LOCKED", message: "This lead is permanently read-only." },
    });
    loadLeadBoardAction.mockResolvedValue({ ok: true, data: emptyBoardData() });
    renderBoard([makeLead()]);

    await act(async () => {
      await dndHandlers.onDragEnd?.({ active: { id: "lead-a" }, over: { id: "contacted" } });
    });

    expect(screen.queryByText("123 Main St")).not.toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "All 0" })).toBeVisible();
    expect(screen.getByRole("button", { name: "No next action 0" })).toBeVisible();
    expect(within(column("new_lead")).getByLabelText("0 matching, 0 total")).toHaveTextContent("0");
  });
});
