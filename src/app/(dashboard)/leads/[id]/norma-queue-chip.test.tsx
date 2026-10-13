import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PROPOSED (RED): lead-detail queue chip. Component `NormaQueueChip` in ./norma-queue-chip.tsx. With `entry` it shows the
// queue state + Pause/Resume/Cancel; without a live entry it offers "Add to queue" (beside Have Norma call).
// Server actions live in ./norma-queue-actions (same pattern as ./norma-actions): addToNormaQueue(propertyId, repContext|null),
// pauseNormaQueueEntry(entryId), resumeNormaQueueEntry(entryId), cancelNormaQueueEntry(entryId); each returns { ok:true } | { ok:false, code, reason? }.
const mocks = vi.hoisted(() => ({
  addToNormaQueue: vi.fn(),
  pauseNormaQueueEntry: vi.fn(),
  resumeNormaQueueEntry: vi.fn(),
  cancelNormaQueueEntry: vi.fn(),
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./norma-queue-actions", () => ({
  addToNormaQueue: mocks.addToNormaQueue,
  pauseNormaQueueEntry: mocks.pauseNormaQueueEntry,
  resumeNormaQueueEntry: mocks.resumeNormaQueueEntry,
  cancelNormaQueueEntry: mocks.cancelNormaQueueEntry,
}));

import { NormaQueueChip, type NormaQueueChipEntry } from "./norma-queue-chip";

const entry = (over: Partial<NormaQueueChipEntry> = {}): NormaQueueChipEntry => ({
  id: "e1",
  status: "queued",
  pauseReason: null,
  nextAttemptAt: "2030-01-09T15:00:00Z", // 09:00 CST
  displayTz: "America/Chicago",
  attemptCount: 0,
  ...over,
});

const renderChip = (e: NormaQueueChipEntry | null, extra: Partial<React.ComponentProps<typeof NormaQueueChip>> = {}) =>
  render(<NormaQueueChip propertyId="p1" entry={e} {...extra} />);

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [mocks.addToNormaQueue, mocks.pauseNormaQueueEntry, mocks.resumeNormaQueueEntry, mocks.cancelNormaQueueEntry]) {
    fn.mockResolvedValue({ ok: true });
  }
});

describe("NormaQueueChip — no live entry", () => {
  it("offers Add to queue and nothing else", () => {
    renderChip(null);
    expect(screen.getByTestId("norma-queue-add")).toBeEnabled();
    expect(screen.queryByTestId("norma-queue-chip")).toBeNull();
    for (const id of ["norma-queue-pause", "norma-queue-resume", "norma-queue-cancel"]) expect(screen.queryByTestId(id)).toBeNull();
  });

  it("Add to queue calls the shared enqueue path for this lead, refreshes, and cannot be double-clicked", async () => {
    renderChip(null);
    fireEvent.click(screen.getByTestId("norma-queue-add"));
    fireEvent.click(screen.getByTestId("norma-queue-add"));
    await waitFor(() => expect(mocks.addToNormaQueue).toHaveBeenCalledWith("p1", null));
    expect(mocks.addToNormaQueue).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("a refused add shows an error and does not refresh", async () => {
    mocks.addToNormaQueue.mockResolvedValue({ ok: false, code: "blocked", reason: "dnc" });
    renderChip(null);
    fireEvent.click(screen.getByTestId("norma-queue-add"));
    expect(await screen.findByTestId("norma-queue-notice")).toHaveAttribute("data-tone", "error");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled", "exhausted"] as const)("an ended (%s) entry shows its state but no Pause/Resume/Cancel", (status) => {
    renderChip(entry({ status }));
    expect(screen.getByTestId("norma-queue-chip")).toHaveAttribute("data-status", status);
    for (const id of ["norma-queue-pause", "norma-queue-resume", "norma-queue-cancel"]) expect(screen.queryByTestId(id)).toBeNull();
  });

  it.each(["done", "cancelled", "exhausted"] as const)("an ended (%s) entry offers Add to queue again (the property has no LIVE entry)", async (status) => {
    renderChip(entry({ status }));
    const add = screen.getByTestId("norma-queue-add");
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(mocks.addToNormaQueue).toHaveBeenCalledWith("p1", null));
  });

  it.each(["queued", "calling", "paused"] as const)("a live (%s) entry does not offer Add to queue", (status) => {
    renderChip(entry({ status, pauseReason: status === "paused" ? "rep_paused" : null }));
    expect(screen.queryByTestId("norma-queue-add")).toBeNull();
  });
});

describe("NormaQueueChip — live entry", () => {
  it("shows the state and the next attempt in the SELLER's zone, not the browser's", () => {
    renderChip(entry());
    const chip = screen.getByTestId("norma-queue-chip");
    expect(chip).toHaveAttribute("data-status", "queued");
    expect(screen.getByTestId("norma-queue-next-attempt")).toHaveTextContent(/\b0?9:00/);
    expect(screen.getByTestId("norma-queue-next-attempt")).not.toHaveTextContent(/\b(15:00|3:00)/);
  });

  it("shows how many attempts have been made", () => {
    renderChip(entry({ attemptCount: 3 }));
    expect(screen.getByTestId("norma-queue-attempts")).toHaveTextContent("3");
  });

  it("queued: Pause and Cancel, no Resume, no Add to queue", () => {
    renderChip(entry({ status: "queued" }));
    expect(screen.getByTestId("norma-queue-pause")).toBeEnabled();
    expect(screen.getByTestId("norma-queue-cancel")).toBeEnabled();
    expect(screen.queryByTestId("norma-queue-resume")).toBeNull();
    expect(screen.queryByTestId("norma-queue-add")).toBeNull();
  });

  it("calling: Pause and Cancel", () => {
    renderChip(entry({ status: "calling", nextAttemptAt: null }));
    expect(screen.getByTestId("norma-queue-pause")).toBeInTheDocument();
    expect(screen.getByTestId("norma-queue-cancel")).toBeInTheDocument();
    expect(screen.queryByTestId("norma-queue-resume")).toBeNull();
  });

  it.each(["inbound_reply", "needs_review", "reviewed", "rep_paused", "unknown_state", "provider_refused"] as const)("paused (%s): Resume and Cancel, with the reason exposed", (pauseReason) => {
    renderChip(entry({ status: "paused", pauseReason, nextAttemptAt: null }));
    expect(screen.getByTestId("norma-queue-chip")).toHaveAttribute("data-pause-reason", pauseReason);
    expect(screen.getByTestId("norma-queue-resume")).toBeEnabled();
    expect(screen.getByTestId("norma-queue-cancel")).toBeEnabled();
    expect(screen.queryByTestId("norma-queue-pause")).toBeNull();
  });

  it.each([
    ["norma-queue-pause", "pauseNormaQueueEntry", "queued"],
    ["norma-queue-resume", "resumeNormaQueueEntry", "paused"],
    ["norma-queue-cancel", "cancelNormaQueueEntry", "queued"],
  ] as const)("%s calls %s with the entry id, then refreshes, once", async (testId, action, status) => {
    renderChip(entry({ status, pauseReason: status === "paused" ? "rep_paused" : null }));
    fireEvent.click(screen.getByTestId(testId));
    // Jarrad 2026-10-07: Cancel asks "Stop Norma calling this lead?" first; the action only runs after the confirm click.
    if (testId === "norma-queue-cancel") {
      expect(mocks[action]).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByTestId("norma-queue-cancel-confirm"));
    }
    await waitFor(() => expect(mocks[action]).toHaveBeenCalledWith("e1"));
    expect(mocks[action]).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("disables every action while one is running", async () => {
    let resolve!: (value: unknown) => void;
    mocks.pauseNormaQueueEntry.mockReturnValue(new Promise((r) => (resolve = r)));
    renderChip(entry());
    fireEvent.click(screen.getByTestId("norma-queue-pause"));
    await waitFor(() => expect(screen.getByTestId("norma-queue-cancel")).toBeDisabled());
    expect(screen.getByTestId("norma-queue-pause")).toBeDisabled();
    resolve({ ok: true });
  });

  it("a refused Resume (e.g. an open request) shows an error notice and does not refresh", async () => {
    mocks.resumeNormaQueueEntry.mockResolvedValue({ ok: false, code: "refused", reason: "open_request" });
    renderChip(entry({ status: "paused", pauseReason: "rep_paused", nextAttemptAt: null }));
    fireEvent.click(screen.getByTestId("norma-queue-resume"));
    expect(await screen.findByTestId("norma-queue-notice")).toHaveAttribute("data-tone", "error");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("a thrown action is contained and shown as an error", async () => {
    mocks.cancelNormaQueueEntry.mockRejectedValue(new Error("network"));
    renderChip(entry());
    fireEvent.click(screen.getByTestId("norma-queue-cancel"));
    fireEvent.click(await screen.findByTestId("norma-queue-cancel-confirm"));
    expect(await screen.findByTestId("norma-queue-notice")).toHaveAttribute("data-tone", "error");
  });

  it("shows the reassignment notice only when a follow-up needs reassigning", () => {
    const a = renderChip(entry(), { reassignment: null });
    expect(screen.queryByTestId("norma-queue-reassignment")).toBeNull();
    a.unmount();
    renderChip(entry(), { reassignment: { kind: "callback_task", status: "open" } });
    expect(screen.getByTestId("norma-queue-reassignment")).toHaveAttribute("data-kind", "callback_task");
  });

  it.each([
    ["queued", null, "Queued"],
    ["calling", null, "Calling now"],
    ["paused", "inbound_reply", "Seller replied"],
    ["paused", "needs_review", "Needs review"],
    ["paused", "reviewed", "Needs review"],
    ["paused", "rep_paused", "Paused by a teammate"],
    ["paused", "unknown_state", "Unknown time zone"],
    ["paused", "provider_refused", "Bland refused the call"],
    ["done", null, "Done"],
    ["cancelled", null, "Cancelled"],
    ["exhausted", null, "Finished trying"],
  ] as const)("copy: %s / %s shows %s", (status, pauseReason, text) => {
    renderChip(entry({ status, pauseReason, nextAttemptAt: null }));
    expect(screen.getByTestId("norma-queue-chip")).toHaveTextContent(text);
  });

  it("copy: next call, attempts, named pause and reassignment lines", () => {
    const a = renderChip(entry({ attemptCount: 3 }), { reassignment: { kind: "callback_task", status: "open" } });
    expect(screen.getByTestId("norma-queue-next-attempt")).toHaveTextContent(/^Next call .*9:00.* \(seller's time\)$/);
    expect(screen.getByTestId("norma-queue-attempts")).toHaveTextContent("3 of 24 tries");
    expect(screen.getByTestId("norma-queue-reassignment")).toHaveTextContent("Needs a new callback owner");
    a.unmount();
    renderChip(entry({ status: "paused", pauseReason: "rep_paused", nextAttemptAt: null }), { pausedByName: "Sam" });
    expect(screen.getByTestId("norma-queue-chip")).toHaveTextContent("Paused by Sam");
  });

  it("Cancel asks for confirmation first and does nothing until confirmed", async () => {
    renderChip(entry());
    fireEvent.click(screen.getByTestId("norma-queue-cancel"));
    expect(await screen.findByText("Stop Norma calling this lead?")).toBeInTheDocument();
    expect(mocks.cancelNormaQueueEntry).not.toHaveBeenCalled();
  });
});
