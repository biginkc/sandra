import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PROPOSED (RED): /norma/queue page client table. `NormaQueueTable` in ./queue-table.tsx (the server page loads rows with the
// member's RLS client and passes them in). Bulk actions call ./actions: resumeNormaQueueEntries(ids) / cancelNormaQueueEntries(ids),
// each returning { ok:true, results:[{ entryId, ok, code? }] } — per-entry org authorisation happens server-side (plan UI section).
const mocks = vi.hoisted(() => ({
  resumeNormaQueueEntries: vi.fn(),
  cancelNormaQueueEntries: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./actions", () => ({
  resumeNormaQueueEntries: mocks.resumeNormaQueueEntries,
  cancelNormaQueueEntries: mocks.cancelNormaQueueEntries,
}));

import { NormaQueueTable, type NormaQueueRow } from "./queue-table";

const row = (id: string, over: Partial<NormaQueueRow> = {}): NormaQueueRow => ({
  id,
  propertyId: `p-${id}`,
  address: `${id} Main St`,
  status: "queued",
  pauseReason: null,
  blockedReason: null,
  nextAttemptAt: "2030-01-09T15:00:00Z",
  displayTz: "America/Chicago",
  needsReassignment: false,
  ...over,
});

const ROWS = [
  row("q1"),
  row("c1", { status: "calling", nextAttemptAt: null }),
  row("p1", { status: "paused", pauseReason: "inbound_reply", nextAttemptAt: null }),
  row("p2", { status: "paused", pauseReason: "rep_paused", nextAttemptAt: null }),
  row("b1", { status: "calling", blockedReason: "dnc", nextAttemptAt: null }),
  row("r1", { needsReassignment: true }),
];

const renderTable = (props: Partial<React.ComponentProps<typeof NormaQueueTable>> = {}) =>
  render(<NormaQueueTable rows={ROWS} todayCount={37} dailyCap={200} heldSlots={2} {...props} />);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resumeNormaQueueEntries.mockResolvedValue({ ok: true, results: [{ entryId: "p1", ok: true }, { entryId: "p2", ok: true }] });
  mocks.cancelNormaQueueEntries.mockResolvedValue({ ok: true, results: [{ entryId: "q1", ok: true }, { entryId: "p1", ok: true }] });
});

describe("NormaQueueTable — rows and selection", () => {
  it("lists every entry with its status", () => {
    renderTable();
    for (const r of ROWS) expect(screen.getByTestId(`norma-queue-row-${r.id}`)).toHaveAttribute("data-status", r.status);
  });

  it("bulk Resume and Cancel are disabled until something is selected", () => {
    renderTable();
    expect(screen.getByTestId("norma-queue-bulk-resume")).toBeDisabled();
    expect(screen.getByTestId("norma-queue-bulk-cancel")).toBeDisabled();
    fireEvent.click(screen.getByTestId("norma-queue-select-p1"));
    expect(screen.getByTestId("norma-queue-bulk-resume")).toBeEnabled();
    expect(screen.getByTestId("norma-queue-bulk-cancel")).toBeEnabled();
  });

  it("select-all selects every visible row", () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-all"));
    for (const r of ROWS) expect(screen.getByTestId(`norma-queue-select-${r.id}`)).toBeChecked();
  });

  it("shows today-vs-cap and the slots held by unresolved calls", () => {
    renderTable();
    const today = screen.getByTestId("norma-queue-today-cap");
    expect(today).toHaveTextContent("37");
    expect(today).toHaveTextContent("200");
    expect(screen.getByTestId("norma-queue-held-slots")).toHaveTextContent("2");
  });
});

describe("NormaQueueTable — bulk actions", () => {
  it("bulk Resume sends exactly the selected entry ids, then refreshes", async () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-p1"));
    fireEvent.click(screen.getByTestId("norma-queue-select-p2"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
    await waitFor(() => expect(mocks.resumeNormaQueueEntries).toHaveBeenCalledWith(["p1", "p2"]));
    expect(mocks.cancelNormaQueueEntries).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("bulk Cancel sends exactly the selected entry ids, then refreshes", async () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-q1"));
    fireEvent.click(screen.getByTestId("norma-queue-select-p1"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-cancel"));
    fireEvent.click(await screen.findByTestId("norma-queue-bulk-cancel-confirm"));
    await waitFor(() => expect(mocks.cancelNormaQueueEntries).toHaveBeenCalledWith(["q1", "p1"]));
    expect(mocks.resumeNormaQueueEntries).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("bulk Cancel asks for confirmation and dismissing it cancels nothing", async () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-q1"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-cancel"));
    expect(await screen.findByText("Stop Norma calling these leads?")).toBeInTheDocument();
    expect(mocks.cancelNormaQueueEntries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("norma-queue-bulk-cancel-confirm")).toBeNull());
    expect(mocks.cancelNormaQueueEntries).not.toHaveBeenCalled();
  });

  it("a bulk action cannot be fired twice while running", async () => {
    let resolve!: (value: unknown) => void;
    mocks.resumeNormaQueueEntries.mockReturnValue(new Promise((r) => (resolve = r)));
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-p1"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
    await waitFor(() => expect(screen.getByTestId("norma-queue-bulk-resume")).toBeDisabled());
    fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
    expect(mocks.resumeNormaQueueEntries).toHaveBeenCalledTimes(1);
    resolve({ ok: true, results: [{ entryId: "p1", ok: true }] });
  });

  it("per-entry refusals (e.g. not authorised, open request) are shown against their rows; the others still succeed", async () => {
    mocks.resumeNormaQueueEntries.mockResolvedValue({
      ok: true,
      results: [{ entryId: "p1", ok: true }, { entryId: "p2", ok: false, code: "refused" }],
    });
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-p1"));
    fireEvent.click(screen.getByTestId("norma-queue-select-p2"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
    expect(await screen.findByTestId("norma-queue-result-p2")).toHaveAttribute("data-ok", "false");
    expect(screen.getByTestId("norma-queue-result-p1")).toHaveAttribute("data-ok", "true");
  });

  it("a whole-action failure shows an error and refreshes nothing", async () => {
    mocks.cancelNormaQueueEntries.mockResolvedValue({ ok: false, code: "unauthenticated" });
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-q1"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-cancel"));
    fireEvent.click(await screen.findByTestId("norma-queue-bulk-cancel-confirm"));
    expect(await screen.findByTestId("norma-queue-bulk-error")).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("a thrown action is contained", async () => {
    mocks.resumeNormaQueueEntries.mockRejectedValue(new Error("network"));
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-select-p1"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
    expect(await screen.findByTestId("norma-queue-bulk-error")).toBeInTheDocument();
  });
});

describe("NormaQueueTable — filters", () => {
  const visible = () => screen.queryAllByTestId(/^norma-queue-row-/).map((el) => el.getAttribute("data-testid")!.replace("norma-queue-row-", "")).sort();

  it("shows everything by default", () => {
    renderTable();
    expect(visible()).toEqual(["b1", "c1", "p1", "p2", "q1", "r1"]);
  });

  it("calling filter shows calling entries", () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-filter-calling"));
    expect(visible()).toEqual(["b1", "c1"]);
  });

  it("parked filter shows paused entries", () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-filter-parked"));
    expect(visible()).toEqual(["p1", "p2"]);
  });

  it("blocked filter shows entries carrying a blocked reason", () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-filter-blocked"));
    expect(visible()).toEqual(["b1"]);
  });

  it("needs-reassignment filter shows entries whose follow-up needs a new owner", () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-filter-reassignment"));
    expect(visible()).toEqual(["r1"]);
  });

  it("selection only counts rows in the current view for bulk actions", async () => {
    renderTable();
    fireEvent.click(screen.getByTestId("norma-queue-filter-parked"));
    fireEvent.click(screen.getByTestId("norma-queue-select-all"));
    fireEvent.click(screen.getByTestId("norma-queue-bulk-cancel"));
    fireEvent.click(await screen.findByTestId("norma-queue-bulk-cancel-confirm"));
    await waitFor(() => expect(mocks.cancelNormaQueueEntries).toHaveBeenCalledWith(["p1", "p2"]));
  });

  it("next attempt is rendered in the seller's zone", () => {
    renderTable();
    const cell = within(screen.getByTestId("norma-queue-row-q1")).getByTestId("norma-queue-next-attempt");
    expect(cell).toHaveTextContent(/\b0?9:00/);
    expect(cell).not.toHaveTextContent(/\b(15:00|3:00)/);
  });

  describe("due-today filter: 'today' is the SELLER-local date (display zone of each row)", () => {
    // 2030-01-09T05:30Z = Wed 8 Jan 23:30 in Chicago, but already Thu 9 Jan 00:30 in New York.
    const NOW = new Date("2030-01-09T05:30:00Z");
    const rows = [
      row("chi-today", { nextAttemptAt: "2030-01-09T04:00:00Z", displayTz: "America/Chicago" }), // 22:00 on the 8th, Chicago: today
      row("ny-same-instant", { nextAttemptAt: "2030-01-09T04:00:00Z", displayTz: "America/New_York" }), // 23:00 on the 8th, but NY 'today' is the 9th: not today
      row("chi-tomorrow", { nextAttemptAt: "2030-01-09T15:00:00Z", displayTz: "America/Chicago" }), // 09:00 on the 9th, Chicago: tomorrow
      row("ny-today", { nextAttemptAt: "2030-01-09T14:00:00Z", displayTz: "America/New_York" }), // 09:00 on the 9th, NY: today
      row("no-time", { status: "paused", pauseReason: "rep_paused", nextAttemptAt: null }),
    ];
    const visible = () => screen.queryAllByTestId(/^norma-queue-row-/).map((el) => el.getAttribute("data-testid")!.replace("norma-queue-row-", "")).sort();

    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    it("keeps rows whose next attempt falls on today's date in their own seller zone; not UTC, not one global zone", () => {
      render(<NormaQueueTable rows={rows} todayCount={0} dailyCap={200} heldSlots={0} />);
      fireEvent.click(screen.getByTestId("norma-queue-filter-due-today"));
      expect(visible()).toEqual(["chi-today", "ny-today"]);
    });
  });

  describe("bulk Resume on non-paused rows (per-row refusal, not UI gating)", () => {
    it("queued and calling rows stay selectable for Resume and are sent to the action", async () => {
      mocks.resumeNormaQueueEntries.mockResolvedValue({
        ok: true,
        results: [{ entryId: "q1", ok: false, code: "refused" }, { entryId: "c1", ok: false, code: "refused" }, { entryId: "p1", ok: true }],
      });
      renderTable();
      for (const id of ["q1", "c1", "p1"]) {
        expect(screen.getByTestId(`norma-queue-select-${id}`)).toBeEnabled();
        fireEvent.click(screen.getByTestId(`norma-queue-select-${id}`));
      }
      expect(screen.getByTestId("norma-queue-bulk-resume")).toBeEnabled();
      fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
      await waitFor(() => expect(mocks.resumeNormaQueueEntries).toHaveBeenCalledWith(["q1", "c1", "p1"]));
    });

    it("shows a per-row refusal on each non-paused row and a success on the paused one", async () => {
      mocks.resumeNormaQueueEntries.mockResolvedValue({
        ok: true,
        results: [{ entryId: "q1", ok: false, code: "refused" }, { entryId: "c1", ok: false, code: "refused" }, { entryId: "p1", ok: true }],
      });
      renderTable();
      for (const id of ["q1", "c1", "p1"]) fireEvent.click(screen.getByTestId(`norma-queue-select-${id}`));
      fireEvent.click(screen.getByTestId("norma-queue-bulk-resume"));
      expect(await screen.findByTestId("norma-queue-result-q1")).toHaveAttribute("data-ok", "false");
      expect(screen.getByTestId("norma-queue-result-c1")).toHaveAttribute("data-ok", "false");
      expect(screen.getByTestId("norma-queue-result-p1")).toHaveAttribute("data-ok", "true");
    });
  });

  it("copy: filters, today-vs-cap, held slots and status labels", () => {
    renderTable();
    expect(screen.getByTestId("norma-queue-filter-calling")).toHaveTextContent("Calling now");
    expect(screen.getByTestId("norma-queue-filter-due-today")).toHaveTextContent("Due today");
    expect(screen.getByTestId("norma-queue-filter-parked")).toHaveTextContent("Paused");
    expect(screen.getByTestId("norma-queue-filter-blocked")).toHaveTextContent("Blocked");
    expect(screen.getByTestId("norma-queue-filter-reassignment")).toHaveTextContent("Needs new owner");
    expect(screen.getByTestId("norma-queue-today-cap")).toHaveTextContent("37 of 200 calls placed today");
    expect(screen.getByTestId("norma-queue-held-slots")).toHaveTextContent("2 calls waiting for review are holding a calling slot");
    expect(screen.getByTestId("norma-queue-row-q1")).toHaveTextContent("Queued");
    expect(screen.getByTestId("norma-queue-row-c1")).toHaveTextContent("Calling now");
  });
});
