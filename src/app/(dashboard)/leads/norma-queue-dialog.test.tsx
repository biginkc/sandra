import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PROPOSED (RED): leads bulk "Queue Norma calls" dialog. Component `NormaQueueDialog` in ./norma-queue-dialog.tsx,
// props like BulkStartDripDialog. It calls the shared server action `queueNormaCalls(propertyIds, repContext)` from ./queue-norma-actions.
// Result shape (see src/lib/norma/queue/queue-calls.test.ts): { ok:true, queueEnabled, results:[{ propertyId, result, reason? }] }.
// Copy is deliberately NOT asserted (role / test-id / data-attribute only); copy needs are it.todo below.
const { queueNormaCalls } = vi.hoisted(() => ({ queueNormaCalls: vi.fn() }));
vi.mock("./queue-norma-actions", () => ({ queueNormaCalls }));

import { NormaQueueDialog } from "./norma-queue-dialog";

const LEADS = [
  { id: "a", address: "1 Main St" },
  { id: "b", address: "2 Main St" },
  { id: "c", address: "3 Main St" },
  { id: "d", address: "4 Main St" },
];

function renderDialog(props: Partial<React.ComponentProps<typeof NormaQueueDialog>> = {}) {
  const onClose = vi.fn();
  const onComplete = vi.fn();
  render(<NormaQueueDialog open leads={LEADS} onClose={onClose} onComplete={onComplete} {...props} />);
  return { onClose, onComplete };
}

beforeEach(() => {
  vi.clearAllMocks();
  queueNormaCalls.mockResolvedValue({
    ok: true,
    queueEnabled: true,
    results: [
      { propertyId: "a", result: "queued" },
      { propertyId: "b", result: "queued" },
      { propertyId: "c", result: "already_queued" },
      { propertyId: "d", result: "blocked", reason: "dnc" },
    ],
  });
});

describe("NormaQueueDialog", () => {
  it("shows how many leads are selected and nothing is sent until the rep confirms", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("norma-queue-count")).toHaveTextContent("4");
    expect(queueNormaCalls).not.toHaveBeenCalled();
  });

  it("sends the selected ids and the trimmed rep context", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("norma-queue-context"), "  seller texted yes  ");
    await user.click(screen.getByTestId("norma-queue-submit"));
    await waitFor(() => expect(queueNormaCalls).toHaveBeenCalledWith(["a", "b", "c", "d"], "seller texted yes"));
  });

  it("sends null context when the box is empty or whitespace", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("norma-queue-context"), "   ");
    await user.click(screen.getByTestId("norma-queue-submit"));
    await waitFor(() => expect(queueNormaCalls).toHaveBeenCalledWith(["a", "b", "c", "d"], null));
  });

  it("cannot be submitted twice while the request is running", async () => {
    const user = userEvent.setup();
    let resolve!: (value: unknown) => void;
    queueNormaCalls.mockReturnValue(new Promise((r) => (resolve = r)));
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    expect(screen.getByTestId("norma-queue-submit")).toBeDisabled();
    await user.click(screen.getByTestId("norma-queue-submit"));
    expect(queueNormaCalls).toHaveBeenCalledTimes(1);
    resolve({ ok: true, queueEnabled: true, results: [] });
  });

  it("groups results as queued / already queued / blocked, with counts and addresses", async () => {
    const user = userEvent.setup();
    const { onComplete } = renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    const queued = await screen.findByTestId("norma-queue-group-queued");
    expect(queued).toHaveAttribute("data-count", "2");
    expect(within(queued).getByText("1 Main St")).toBeInTheDocument();
    expect(within(queued).getByText("2 Main St")).toBeInTheDocument();
    const already = screen.getByTestId("norma-queue-group-already_queued");
    expect(already).toHaveAttribute("data-count", "1");
    expect(within(already).getByText("3 Main St")).toBeInTheDocument();
    const blocked = screen.getByTestId("norma-queue-group-blocked");
    expect(blocked).toHaveAttribute("data-count", "1");
    expect(within(blocked).getByText("4 Main St")).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("omits a group that has no leads", async () => {
    const user = userEvent.setup();
    queueNormaCalls.mockResolvedValue({ ok: true, queueEnabled: true, results: LEADS.map((l) => ({ propertyId: l.id, result: "queued" })) });
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    await screen.findByTestId("norma-queue-group-queued");
    expect(screen.queryByTestId("norma-queue-group-already_queued")).toBeNull();
    expect(screen.queryByTestId("norma-queue-group-blocked")).toBeNull();
  });

  it("shows the flag-off notice when the queue switch is off (leads are still queued)", async () => {
    const user = userEvent.setup();
    queueNormaCalls.mockResolvedValue({ ok: true, queueEnabled: false, results: [{ propertyId: "a", result: "queued" }] });
    renderDialog();
    expect(screen.queryByTestId("norma-queue-flag-off")).toBeNull();
    await user.click(screen.getByTestId("norma-queue-submit"));
    expect(await screen.findByTestId("norma-queue-flag-off")).toBeInTheDocument();
    expect(screen.getByTestId("norma-queue-group-queued")).toBeInTheDocument();
  });

  it("no flag-off notice when the queue switch is on", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    await screen.findByTestId("norma-queue-group-queued");
    expect(screen.queryByTestId("norma-queue-flag-off")).toBeNull();
  });

  it.each([
    [{ ok: false, code: "unauthenticated" }],
    [{ ok: false, code: "not_member" }],
    [{ ok: false, code: "error" }],
  ])("a refused action (%j) shows an error and no result groups", async (refusal) => {
    const user = userEvent.setup();
    queueNormaCalls.mockResolvedValue(refusal);
    const { onComplete } = renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    expect(await screen.findByTestId("norma-queue-error")).toBeInTheDocument();
    expect(screen.queryByTestId("norma-queue-group-queued")).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("a thrown action is shown as an error, not an unhandled rejection, and the rep can retry", async () => {
    const user = userEvent.setup();
    queueNormaCalls.mockRejectedValueOnce(new Error("network"));
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    expect(await screen.findByTestId("norma-queue-error")).toBeInTheDocument();
    expect(screen.getByTestId("norma-queue-submit")).toBeEnabled();
  });

  it("Done closes the dialog", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    await screen.findByTestId("norma-queue-group-queued");
    await user.click(screen.getByTestId("norma-queue-done"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the hours, retry and note copy before submitting", () => {
    renderDialog();
    expect(screen.getByText("Norma calls 9:00 AM to 7:30 PM in the seller's time zone, Monday to Saturday.")).toBeInTheDocument();
    expect(screen.getByText("If no one answers, she tries twice a day for 3 days, daily for 2 weeks, then monthly up to 6 times.")).toBeInTheDocument();
    expect(screen.getByText("Note for Norma (optional, used on every call)")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("Queue 4 leads for Norma");
    expect(screen.getByTestId("norma-queue-submit")).toHaveTextContent("Queue calls");
  });

  it("shows the capacity hint when the caller supplies it", () => {
    renderDialog({ capacity: { cap: 200, due: 12 } });
    expect(screen.getByTestId("norma-queue-capacity")).toHaveTextContent("Norma can place 200 calls today. 12 are already due.");
  });

  it("copy: flag-off notice, result headings and blocked reason text", async () => {
    const user = userEvent.setup();
    queueNormaCalls.mockResolvedValue({ ok: true, queueEnabled: false, results: [
      { propertyId: "a", result: "queued" }, { propertyId: "c", result: "already_queued" }, { propertyId: "d", result: "blocked", reason: "dnc_locked" },
    ] });
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    expect(await screen.findByTestId("norma-queue-flag-off")).toHaveTextContent("The Norma queue is switched off. Leads will be queued but not called until it is switched on.");
    expect(screen.getByTestId("norma-queue-group-queued")).toHaveTextContent("Queued: 1");
    expect(screen.getByTestId("norma-queue-group-already_queued")).toHaveTextContent("Already queued: 1");
    expect(screen.getByTestId("norma-queue-group-blocked")).toHaveTextContent("Not queued: 1");
    expect(screen.getByTestId("norma-queue-reason-d")).toHaveTextContent("This lead is marked do-not-contact.");
  });
  it("leads that were not queued (open_request, unknown_state, not_found) are shown in one 'not queued' group, each with its reason", async () => {
    const user = userEvent.setup();
    queueNormaCalls.mockResolvedValue({
      ok: true,
      queueEnabled: true,
      results: [
        { propertyId: "a", result: "queued" },
        { propertyId: "b", result: "open_request" },
        { propertyId: "c", result: "unknown_state" },
        { propertyId: "d", result: "not_found" },
      ],
    });
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    const notQueued = await screen.findByTestId("norma-queue-group-not_queued");
    expect(notQueued).toHaveAttribute("data-count", "3");
    for (const [id, address, reason] of [["b", "2 Main St", "open_request"], ["c", "3 Main St", "unknown_state"], ["d", "4 Main St", "not_found"]] as const) {
      expect(within(notQueued).getByText(address)).toBeInTheDocument();
      expect(within(notQueued).getByTestId(`norma-queue-reason-${id}`)).toHaveAttribute("data-reason", reason);
    }
    expect(within(screen.getByTestId("norma-queue-group-queued")).queryByText("2 Main St")).toBeNull();
    expect(screen.queryByTestId("norma-queue-group-blocked")).toBeNull();
  });

  it("a blocked lead keeps its own group and shows its reason", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId("norma-queue-submit"));
    const blocked = await screen.findByTestId("norma-queue-group-blocked");
    expect(within(blocked).getByTestId("norma-queue-reason-d")).toHaveAttribute("data-reason", "dnc");
    expect(screen.queryByTestId("norma-queue-group-not_queued")).toBeNull();
  });
});
