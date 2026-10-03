import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NO_ACTIVE_DRIP } from "./lead-outcome-drip";
import { LeadDripCard, LeadOutcomeProvider, LeadOutcomeSection } from "./lead-outcome-section";

const setOutreachDispoMock = vi.hoisted(() => vi.fn());
const setInboxDispoAndStartDripMock = vi.hoisted(() => vi.fn());
const listDripChoicesMock = vi.hoisted(() => vi.fn());
const startDripForLeadsMock = vi.hoisted(() => vi.fn());
const changeDripActionMock = vi.hoisted(() => vi.fn());
const listDripProgressMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: refreshMock }) }));
vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({
  setOutreachDispo: setOutreachDispoMock,
  setInboxDispoAndStartDrip: setInboxDispoAndStartDripMock,
  moveMessageThreadToLead: vi.fn(),
}));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: listDripChoicesMock,
  startDripForLeads: startDripForLeadsMock,
  changeDripAction: changeDripActionMock,
  pauseEnrollmentAction: vi.fn(),
  resumeEnrollmentAction: vi.fn(),
  retrySequenceStepAction: vi.fn(),
  cancelEnrollment: vi.fn(),
}));
vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: listDripProgressMock }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/errors/call-action", () => ({ callAction: (promise: Promise<unknown>) => promise }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

function page(props: { training?: boolean; drip?: typeof NO_ACTIVE_DRIP; dripUnknown?: boolean; initialDispo?: string | null } = {}) {
  const training = props.training ?? false;
  return (
    <LeadOutcomeProvider>
      <fieldset disabled={training} inert={training || undefined} className="contents" data-testid="outcome-fieldset">
        <LeadOutcomeSection
          propertyId="prop-1"
          address="123 Main St"
          initialDispo={props.initialDispo ?? null}
          propertyStatus="new_lead"
          currentUserId="user-1"
          drip={props.drip ?? NO_ACTIVE_DRIP}
          dripUnknown={props.dripUnknown ?? false}
        />
      </fieldset>
      <LeadDripCard propertyId="prop-1" />
    </LeadOutcomeProvider>
  );
}

describe("lead page outcome section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOutreachDispoMock.mockResolvedValue({ ok: true });
    setInboxDispoAndStartDripMock.mockResolvedValue({ ok: true, enrollment: { status: "enrolled", reason: "Enrolled" } });
    listDripChoicesMock.mockResolvedValue({
      ok: true,
      data: [{ id: "s1", name: "Seller follow-up", textCount: 2, days: 3, firstSend: "Monday" }],
    });
    startDripForLeadsMock.mockResolvedValue({
      ok: true,
      data: { results: [{ propertyId: "prop-1", status: "enrolled", reason: "Enrolled" }] },
    });
    listDripProgressMock.mockResolvedValue([]);
  });

  it("remounts the drip card (refetch) and refreshes the page after Not interested then Also start a drip", async () => {
    const user = userEvent.setup();
    render(page({ initialDispo: "not_interested" }));
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Also start a drip" }));
    await user.click(await screen.findByRole("button", { name: /Seller follow-up/ }));
    await waitFor(() => expect(startDripForLeadsMock).toHaveBeenCalledWith("s1", ["prop-1"]));
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(2));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("Needs drip saves via setInboxDispoAndStartDrip and refetches the drip card", async () => {
    const user = userEvent.setup();
    render(page());
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
    await user.click(await screen.findByRole("button", { name: /Seller follow-up/ }));
    await waitFor(() =>
      expect(setInboxDispoAndStartDripMock).toHaveBeenCalledWith("prop-1", "needs_sequence", "s1"),
    );
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(2));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("opt-out from the lead page refetches the drip card", async () => {
    const user = userEvent.setup();
    render(page());
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("dispo-more"));
    await user.click(await screen.findByTestId("dispo-opted-out"));
    await waitFor(() => expect(setOutreachDispoMock).toHaveBeenCalledWith("prop-1", "opted_out"));
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(2));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("a failed switch still refetches the drip card and keeps the alert", async () => {
    changeDripActionMock.mockResolvedValue({ ok: false, error: { message: "Replacement failed" } });
    const user = userEvent.setup();
    render(
      page({
        drip: {
          activeDripEnrollmentId: "e1",
          activeDripSequenceId: "current",
          activeDripName: "Current drip",
          activeDripStep: 1,
          activeDripTotal: 2,
        },
      }),
    );
    await waitFor(() => expect(listDripProgressMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
    await user.click(await screen.findByRole("button", { name: /Seller follow-up/ }));
    await user.click(await screen.findByRole("button", { name: "Switch to this drip" }));
    await waitFor(() => expect(listDripProgressMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("drip-cant-start")).toHaveTextContent("Replacement failed");
  });

  it("disables the drip pickers but not other outcomes when drip state is unknown", () => {
    render(page({ dripUnknown: true }));
    expect(screen.getByTestId("dispo-needs-sequence").querySelector("button")).toBeDisabled();
    expect(screen.getByTestId("dispo-wrong-number")).toBeEnabled();
    expect(screen.getByTestId("dispo-follow-up")).toBeEnabled();
  });

  it("disables and makes every control inert for a training lead", () => {
    render(page({ training: true }));
    const fieldset = screen.getByTestId("outcome-fieldset");
    expect(fieldset).toHaveAttribute("inert");
    for (const id of ["dispo-wrong-number", "dispo-not-interested", "dispo-follow-up", "dispo-more"]) {
      expect(screen.getByTestId(id)).toBeDisabled();
    }
  });

  it("does not render the Messages-only controls", () => {
    render(page());
    expect(screen.queryByTestId("message-move-to-lead")).toBeNull();
    expect(screen.queryByText("Book appt")).toBeNull();
    expect(screen.getByTestId("dispo-dnc-deferred")).toBeDisabled();
  });

  it("shows the saved outcome and follows a refreshed server value", async () => {
    const user = userEvent.setup();
    const { rerender } = render(page());
    await user.click(screen.getByTestId("dispo-follow-up"));
    await waitFor(() => expect(screen.getByText("Follow up", { selector: "span" })).toBeInTheDocument());
    rerender(page({ initialDispo: "wrong_number" }));
    expect(screen.getByText("Wrong #")).toBeInTheDocument();
  });
});
