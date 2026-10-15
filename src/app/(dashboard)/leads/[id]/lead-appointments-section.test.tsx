import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LeadAppointmentsSection,
  type LeadAppointmentRow,
} from "./lead-appointments-section";

const refresh = vi.fn();
const loadHistory = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("./lead-appointments-actions", () => ({
  loadLeadAppointmentHistory: (...args: unknown[]) => loadHistory(...args),
}));

// Lifecycle controls are covered by their own suites; stub them so this suite
// asserts which control each row gets and who sees it.
vi.mock("@/components/appointments/appointment-outcome-row", () => ({
  AppointmentOutcomeRow: ({ taskId, assigneeId }: { taskId: string; assigneeId: string }) => (
    <div data-testid={`stub-outcome-row-${taskId}`}>outcome row (assignee={assigneeId})</div>
  ),
  AppointmentUpcomingActions: ({ taskId, assigneeId }: { taskId: string; assigneeId: string }) => (
    <div data-testid={`stub-upcoming-actions-${taskId}`}>upcoming actions (assignee={assigneeId})</div>
  ),
}));
vi.mock("@/app/(dashboard)/dashboard/_components/task-actions-row", () => ({
  TaskActionsRow: ({ taskId }: { taskId: string }) => (
    <div data-testid={`stub-task-actions-${taskId}`}>done / snooze</div>
  ),
}));

const TZ = "America/Chicago";
const NOW_MS = new Date("2026-08-16T18:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const iso = (offsetHours: number) => new Date(NOW_MS + offsetHours * HOUR).toISOString();

function makeRow(overrides: Partial<LeadAppointmentRow> & { id: string }): LeadAppointmentRow {
  return {
    title: "Appointment — 123 Main St",
    due_at: iso(24),
    end_at: null,
    assignee_id: "rep-1",
    type: "appointment",
    status: "open",
    outcome: null,
    ...overrides,
  };
}

const noHistory = { rows: [], hasMore: false, cursor: null };

function renderSection(
  props: Partial<React.ComponentProps<typeof LeadAppointmentsSection>> = {},
) {
  return render(
    <LeadAppointmentsSection
      propertyId="11111111-1111-4111-8111-111111111111"
      appointments={[]}
      history={noHistory}
      viewerId="rep-1"
      viewerIsOwner={false}
      timezone={TZ}
      nowMs={NOW_MS}
      {...props}
    />,
  );
}

beforeEach(() => {
  refresh.mockReset();
  loadHistory.mockReset();
});

describe("<LeadAppointmentsSection />", () => {
  it("renders an empty state with no tasks at all", () => {
    renderSection();
    expect(screen.getByTestId("lead-appointments-empty")).toHaveTextContent(
      "No appointments or callbacks",
    );
    expect(screen.queryByTestId("lead-appointments-section")).not.toBeInTheDocument();
  });

  it("groups open and snoozed work into Upcoming and Past due, and finished work into History", () => {
    renderSection({
      appointments: [
        makeRow({ id: "up-open", due_at: iso(5) }),
        makeRow({ id: "up-snoozed", due_at: iso(30), status: "snoozed", type: "callback" }),
        makeRow({ id: "past-open", due_at: iso(-2) }),
        makeRow({ id: "past-snoozed", due_at: iso(-3), status: "snoozed" }),
      ],
      history: {
        rows: [
          makeRow({ id: "h-held", due_at: iso(-50), status: "completed", outcome: "held" }),
          makeRow({ id: "h-noshow", due_at: iso(-60), status: "completed", outcome: "no_show" }),
          makeRow({ id: "h-cancel", due_at: iso(-70), status: "cancelled" }),
          makeRow({ id: "h-cb", due_at: iso(-80), status: "completed", type: "callback" }),
        ],
        hasMore: false,
        cursor: null,
      },
    });

    const inGroup = (group: string) =>
      Array.from(
        screen.getByTestId(`lead-appointments-${group}`).querySelectorAll("li"),
      ).map((li) => li.getAttribute("data-testid"));

    expect(inGroup("upcoming")).toEqual(["lead-appointment-up-open", "lead-appointment-up-snoozed"]);
    expect(inGroup("past-due")).toEqual(["lead-appointment-past-snoozed", "lead-appointment-past-open"]);
    expect(inGroup("history")).toEqual([
      "lead-appointment-h-held",
      "lead-appointment-h-noshow",
      "lead-appointment-h-cancel",
      "lead-appointment-h-cb",
    ]);
    expect(screen.getAllByText(/Snoozed/)).toHaveLength(2);
    expect(screen.getByText(/· Held/)).toBeInTheDocument();
    expect(screen.getByText(/· No-show/)).toBeInTheDocument();
    expect(screen.getByText(/· Cancelled/)).toBeInTheDocument();
  });

  it("gives each live row the right control: outcome row past due, overflow upcoming, Done/Snooze for callbacks", () => {
    renderSection({
      appointments: [
        makeRow({ id: "past", due_at: iso(-1), assignee_id: "rep-1" }),
        makeRow({ id: "future", due_at: iso(2), assignee_id: "rep-1" }),
        makeRow({ id: "cb-1", due_at: iso(3), type: "callback" }),
        makeRow({ id: "cb-2", due_at: iso(-4), type: "callback", status: "snoozed" }),
      ],
    });
    expect(screen.getByTestId("stub-outcome-row-past")).toHaveTextContent("assignee=rep-1");
    expect(screen.getByTestId("stub-upcoming-actions-future")).toBeInTheDocument();
    expect(screen.getByTestId("stub-task-actions-cb-1")).toBeInTheDocument();
    expect(screen.getByTestId("stub-task-actions-cb-2")).toBeInTheDocument();
    // callbacks never get the appointment lifecycle controls
    expect(screen.queryByTestId("stub-outcome-row-cb-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-upcoming-actions-cb-1")).not.toBeInTheDocument();
  });

  it("shows controls to the assignee and to an owner, but not to another rep", () => {
    const rows = [
      makeRow({ id: "a", assignee_id: "rep-1" }),
      makeRow({ id: "cb", assignee_id: "rep-1", type: "callback" }),
    ];
    const { unmount } = renderSection({ appointments: rows, viewerId: "rep-1" });
    expect(screen.getByTestId("stub-upcoming-actions-a")).toBeInTheDocument();
    expect(screen.getByTestId("stub-task-actions-cb")).toBeInTheDocument();
    unmount();

    const owner = renderSection({ appointments: rows, viewerId: "boss", viewerIsOwner: true });
    expect(screen.getByTestId("stub-upcoming-actions-a")).toBeInTheDocument();
    expect(screen.getByTestId("stub-task-actions-cb")).toBeInTheDocument();
    owner.unmount();

    renderSection({ appointments: rows, viewerId: "rep-2", viewerIsOwner: false });
    expect(screen.getByTestId("lead-appointment-a")).toBeInTheDocument();
    expect(screen.queryByTestId("stub-upcoming-actions-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-task-actions-cb")).not.toBeInTheDocument();
  });

  it("lists follow-up tasks labelled Follow-up, with no lifecycle controls (parity with the panel)", () => {
    renderSection({
      appointments: [makeRow({ id: "fu", type: "follow_up", title: "Check back" })],
    });
    const item = screen.getByTestId("lead-appointment-fu");
    expect(item).toHaveTextContent("Follow-up");
    expect(screen.queryByTestId("stub-upcoming-actions-fu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-task-actions-fu")).not.toBeInTheDocument();
  });

  it("never shows controls on finished history rows, even for the owner", () => {
    renderSection({
      viewerId: "boss",
      viewerIsOwner: true,
      history: {
        rows: [
          makeRow({ id: "done", status: "completed", outcome: "held" }),
          makeRow({ id: "done-cb", status: "completed", type: "callback" }),
        ],
        hasMore: false,
        cursor: null,
      },
    });
    expect(screen.queryByTestId("stub-upcoming-actions-done")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-outcome-row-done")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-task-actions-done-cb")).not.toBeInTheDocument();
  });

  it("pages History: loads more with the cursor, appends rows, dedupes, and hides the button at the end", async () => {
    const cursor = { dueAt: iso(-50), id: "h1" };
    loadHistory.mockResolvedValueOnce({
      ok: true,
      rows: [
        makeRow({ id: "h1", status: "completed" }),
        makeRow({ id: "h2", status: "cancelled", due_at: iso(-90) }),
      ],
      hasMore: false,
      cursor: null,
    });
    renderSection({
      history: {
        rows: [makeRow({ id: "h1", status: "completed", due_at: iso(-50) })],
        hasMore: true,
        cursor,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    await waitFor(() => expect(screen.getByTestId("lead-appointment-h2")).toBeInTheDocument());
    expect(loadHistory).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", cursor);
    expect(screen.getAllByTestId("lead-appointment-h1")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more history" })).not.toBeInTheDocument();
  });

  it("keeps loaded history and shows an error when paging fails", async () => {
    loadHistory.mockResolvedValueOnce({ ok: false, message: "History unavailable" });
    renderSection({
      history: {
        rows: [makeRow({ id: "h1", status: "completed" })],
        hasMore: true,
        cursor: { dueAt: iso(-50), id: "h1" },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    expect(screen.getByTestId("lead-appointment-h1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more history" })).toBeEnabled();
  });

  it("formats times in the passed timezone, not the runtime's zone", () => {
    renderSection({
      appointments: [makeRow({ id: "tz", due_at: "2026-09-15T17:30:00.000Z" })],
      timezone: "America/Los_Angeles",
    });
    expect(screen.getByText(/10:30\s*AM/)).toBeInTheDocument();
  });

  it("labels a fall-back offset transition even when the wall-clock end is later", () => {
    renderSection({
      appointments: [
        makeRow({
          id: "appt-dst",
          due_at: "2026-11-01T06:30:00.000Z",
          end_at: "2026-11-01T08:00:00.000Z",
        }),
      ],
    });
    expect(screen.getByText(/1:30 AM CDT–2:00 AM CST/)).toBeInTheDocument();
  });
});
