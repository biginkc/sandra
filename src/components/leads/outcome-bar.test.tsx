import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DISPO_LABELS, OutcomeBar } from "./outcome-bar";

const setOutreachDispoMock = vi.hoisted(() => vi.fn());
const setInboxDispoAndStartDripMock = vi.hoisted(() => vi.fn());
const moveMessageThreadToLeadMock = vi.hoisted(() => vi.fn());
const listDripChoicesMock = vi.hoisted(() => vi.fn());
const startDripForLeadsMock = vi.hoisted(() => vi.fn());
const changeDripActionMock = vi.hoisted(() => vi.fn());
const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("@/app/(dashboard)/messages/dispo-actions", () => ({
  setOutreachDispo: setOutreachDispoMock,
  setInboxDispoAndStartDrip: setInboxDispoAndStartDripMock,
  moveMessageThreadToLead: moveMessageThreadToLeadMock,
}));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listDripChoices: listDripChoicesMock,
  startDripForLeads: startDripForLeadsMock,
  changeDripAction: changeDripActionMock,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: ({ triggerLabel, onBooked }: { triggerLabel: string; onBooked?: () => void }) => (
    <button data-testid="book-appointment" onClick={onBooked}>{triggerLabel}</button>
  ),
}));

type BarProps = React.ComponentProps<typeof OutcomeBar>;

/** The configuration the lead page uses. */
const leadPage: Partial<BarProps> = {
  showMoveToLead: false,
  showBookAppointment: false,
  syncFromProps: true,
};

function renderBar(props: Partial<BarProps> = {}, config: Partial<BarProps> = leadPage) {
  const onDispositionChanged = vi.fn();
  const onDripChanged = vi.fn();
  const view = render(
    <OutcomeBar
      propertyId="prop-1"
      contactId="contact-1"
      propertyAddress="123 Main St"
      initialDispo={null}
      propertyStatus="new_lead"
      currentUserId="user-1"
      onDispositionChanged={onDispositionChanged}
      onDripChanged={onDripChanged}
      {...config}
      {...props}
    />,
  );
  return { ...view, onDispositionChanged, onDripChanged };
}

async function pickSeedDrip(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Seller follow-up/ }));
}

describe("<OutcomeBar />", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOutreachDispoMock.mockResolvedValue({ ok: true });
    setInboxDispoAndStartDripMock.mockResolvedValue({
      ok: true,
      enrollment: { status: "enrolled", reason: "Enrolled" },
    });
    listDripChoicesMock.mockResolvedValue({
      ok: true,
      data: [{ id: "s1", name: "Seller follow-up", textCount: 2, days: 3, firstSend: "Monday" }],
    });
    startDripForLeadsMock.mockResolvedValue({
      ok: true,
      data: { results: [{ propertyId: "prop-1", status: "enrolled", reason: "Enrolled" }] },
    });
    changeDripActionMock.mockResolvedValue({ ok: true, data: { status: "enrolled", reason: "Enrolled" } });
  });

  describe("lead page configuration", () => {
    it("hides Move to Lead and Book appt and keeps DNC disabled", () => {
      renderBar();
      expect(screen.queryByTestId("message-move-to-lead")).toBeNull();
      expect(screen.queryByTestId("book-appointment")).toBeNull();
      const dnc = screen.getByTestId("dispo-dnc-deferred");
      expect(dnc).toBeDisabled();
      expect(dnc).toHaveTextContent("Permanent DNC unavailable here");
    });

    it.each([
      ["dispo-wrong-number", "wrong_number"],
      ["dispo-not-interested", "not_interested"],
      ["dispo-follow-up", "nurture"],
    ])("%s saves %s", async (testId, dispo) => {
      const user = userEvent.setup();
      renderBar();
      await user.click(screen.getByTestId(testId));
      expect(setOutreachDispoMock).toHaveBeenCalledWith("prop-1", dispo);
      await waitFor(() => expect(screen.getByText(DISPO_LABELS[dispo], { selector: "span" })).toBeInTheDocument());
    });

    it.each([
      ["dispo-bad-number", "bad_number"],
      ["dispo-opted-out", "opted_out"],
    ])("%s from More saves %s", async (testId, dispo) => {
      const user = userEvent.setup();
      renderBar();
      await user.click(screen.getByTestId("dispo-more"));
      await user.click(await screen.findByTestId(testId));
      expect(setOutreachDispoMock).toHaveBeenCalledWith("prop-1", dispo);
      await waitFor(() => expect(screen.getByText(DISPO_LABELS[dispo], { selector: "span" })).toBeInTheDocument());
    });

    it("Needs drip saves and starts the chosen drip in one call", async () => {
      const user = userEvent.setup();
      const { onDispositionChanged, onDripChanged } = renderBar();
      await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
      await pickSeedDrip(user);
      await waitFor(() =>
        expect(setInboxDispoAndStartDripMock).toHaveBeenCalledWith("prop-1", "needs_sequence", "s1"),
      );
      await waitFor(() => expect(onDripChanged).toHaveBeenCalled());
      expect(onDispositionChanged).toHaveBeenCalled();
      expect(screen.getByText("Needs drip", { selector: "span" })).toBeInTheDocument();
    });

    it("Leave it to the follow-up owner saves needs_sequence only", async () => {
      const user = userEvent.setup();
      const { onDripChanged } = renderBar();
      await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
      await user.click(await screen.findByRole("button", { name: "Leave it to the follow-up owner" }));
      await waitFor(() => expect(setOutreachDispoMock).toHaveBeenCalledWith("prop-1", "needs_sequence"));
      expect(setInboxDispoAndStartDripMock).not.toHaveBeenCalled();
      await waitFor(() => expect(onDripChanged).toHaveBeenCalled());
      expect(toast.success).toHaveBeenCalledWith("Saved: Needs drip — left for lead owner", { description: "123 Main St" });
    });

    it("Not interested then Also start a drip enrolls and notifies the drip card", async () => {
      const user = userEvent.setup();
      const { onDripChanged } = renderBar({ initialDispo: "not_interested" });
      await user.click(screen.getByRole("button", { name: "Also start a drip" }));
      await pickSeedDrip(user);
      await waitFor(() => expect(startDripForLeadsMock).toHaveBeenCalledWith("s1", ["prop-1"]));
      await waitFor(() => expect(onDripChanged).toHaveBeenCalledTimes(1));
      expect(setOutreachDispoMock).not.toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith("Drip started", { description: "123 Main St" });
    });

    it("does not notify the drip card when the extra drip is refused", async () => {
      startDripForLeadsMock.mockResolvedValue({
        ok: true,
        data: { results: [{ propertyId: "prop-1", status: "skipped", reason: "Nope" }] },
      });
      const user = userEvent.setup();
      const { onDripChanged } = renderBar({ initialDispo: "not_interested" });
      await user.click(screen.getByRole("button", { name: "Also start a drip" }));
      await pickSeedDrip(user);
      await screen.findByTestId("drip-cant-start");
      expect(onDripChanged).not.toHaveBeenCalled();
    });

    it("shows the existing error and keeps the old label on {ok:false}", async () => {
      setOutreachDispoMock.mockResolvedValue({ ok: false, error: "Could not save" });
      const user = userEvent.setup();
      const { onDispositionChanged, onDripChanged } = renderBar({ initialDispo: "nurture" });
      await user.click(screen.getByTestId("dispo-wrong-number"));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not save", { description: "123 Main St" }));
      expect(screen.getByText("Follow up", { selector: "span" })).toBeInTheDocument();
      expect(onDispositionChanged).not.toHaveBeenCalled();
      expect(onDripChanged).not.toHaveBeenCalled();
    });

    it("keeps the Open lead link pointing at the lead", async () => {
      setInboxDispoAndStartDripMock.mockResolvedValue({ ok: true, enrollment: { status: "skipped", reason: "Already in Current drip. Stop it or switch." } });
      const user = userEvent.setup();
      renderBar({ activeDripEnrollmentId: "e1", activeDripSequenceId: "cur", activeDripName: "Current", activeDripStep: 1, activeDripTotal: 2 });
      await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
      await pickSeedDrip(user);
      expect(await screen.findByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads/prop-1");
    });

    it.each(["wrong_number", "bad_number", "callback_requested", "booked_appointment"])("checks the server block for %s even when an existing drip is shown", async (dispo) => {
      setInboxDispoAndStartDripMock.mockResolvedValue({ ok: false, error: "Resolve this outcome before starting a drip." });
      const user = userEvent.setup();
      const { onDispositionChanged, onDripChanged } = renderBar({
        initialDispo: dispo, activeDripEnrollmentId: "e1", activeDripSequenceId: "current",
        activeDripName: "Current drip", activeDripStep: 1, activeDripTotal: 2,
      });
      await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
      await pickSeedDrip(user);
      expect(setInboxDispoAndStartDripMock).toHaveBeenCalledWith("prop-1", "needs_sequence", "s1");
      expect(setOutreachDispoMock).not.toHaveBeenCalled();
      expect(onDispositionChanged).not.toHaveBeenCalled();
      expect(onDripChanged).not.toHaveBeenCalled();
      expect(await screen.findByTestId("drip-cant-start")).toHaveTextContent("Resolve this outcome");
      expect(screen.getByText(DISPO_LABELS[dispo], { selector: "span" })).toBeVisible();
    });

    it("disables only the drip pickers when drip state is unknown", async () => {
      const user = userEvent.setup();
      renderBar({ dripPickersDisabled: true, initialDispo: "not_interested" });
      expect(screen.getByTestId("dispo-needs-sequence").querySelector("button")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Also start a drip" })).toBeDisabled();
      expect(screen.getByTestId("dispo-wrong-number")).toBeEnabled();
      await user.click(screen.getByTestId("dispo-wrong-number"));
      expect(setOutreachDispoMock).toHaveBeenCalledWith("prop-1", "wrong_number");
    });
  });

  describe("drip notifications", () => {
    it.each(["wrong_number", "opted_out", "bad_number"])("%s fires onDripChanged on success", async (dispo) => {
      const user = userEvent.setup();
      const { onDripChanged } = renderBar();
      if (dispo === "wrong_number") await user.click(screen.getByTestId("dispo-wrong-number"));
      else {
        await user.click(screen.getByTestId("dispo-more"));
        await user.click(await screen.findByTestId(dispo === "opted_out" ? "dispo-opted-out" : "dispo-bad-number"));
      }
      await waitFor(() => expect(onDripChanged).toHaveBeenCalledTimes(1));
    });

    it("does not fire onDripChanged for outcomes that never touch a drip", async () => {
      const user = userEvent.setup();
      const { onDripChanged } = renderBar();
      await user.click(screen.getByTestId("dispo-follow-up"));
      await waitFor(() => expect(screen.getByText("Follow up", { selector: "span" })).toBeInTheDocument());
      expect(onDripChanged).not.toHaveBeenCalled();
    });

    it("fires again on an unchanged-dispo retry", async () => {
      const user = userEvent.setup();
      const { onDripChanged, onDispositionChanged } = renderBar({ initialDispo: "opted_out" });
      await user.click(screen.getByTestId("dispo-more"));
      await user.click(await screen.findByTestId("dispo-opted-out"));
      await waitFor(() => expect(onDripChanged).toHaveBeenCalledTimes(1));
      expect(onDispositionChanged).not.toHaveBeenCalled();
    });

    it("reconciles a committed failure: new label, error toast, callbacks", async () => {
      setOutreachDispoMock.mockResolvedValueOnce({ ok: false, error: "Consent failed", committed: true });
      const user = userEvent.setup();
      const { onDripChanged, onDispositionChanged } = renderBar();
      await user.click(screen.getByTestId("dispo-more"));
      await user.click(await screen.findByTestId("dispo-opted-out"));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Consent failed", { description: "123 Main St" }));
      expect(screen.getByText("SMS opted out")).toBeInTheDocument();
      expect(onDispositionChanged).toHaveBeenCalledTimes(1);
      expect(onDripChanged).toHaveBeenCalledTimes(1);

      // Retry with the same outcome succeeds and notifies the drip card again.
      await user.click(screen.getByTestId("dispo-more"));
      await user.click(await screen.findByTestId("dispo-opted-out"));
      await waitFor(() => expect(onDripChanged).toHaveBeenCalledTimes(2));
      expect(onDispositionChanged).toHaveBeenCalledTimes(1);
    });

    it("a plain failure does not reconcile", async () => {
      setOutreachDispoMock.mockResolvedValueOnce({ ok: false, error: "Nope" });
      const user = userEvent.setup();
      const { onDripChanged } = renderBar();
      await user.click(screen.getByTestId("dispo-wrong-number"));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope", { description: "123 Main St" }));
      expect(screen.queryByText("Wrong #")).toBeNull();
      expect(onDripChanged).not.toHaveBeenCalled();
    });

    it.each(["failed", "skipped"] as const)("announces a refused drip switch: %s", async (status) => {
      changeDripActionMock.mockResolvedValue({ ok: true, data: { status, reason: "Replacement not started" } });
      const user = userEvent.setup();
      renderBar({ activeDripEnrollmentId: "e1", activeDripSequenceId: "current", initialFailedStart: { sequenceId: "s1", reason: "Already in Current drip", saved: true } });
      await user.click(screen.getByRole("button", { name: "Switch to this drip" }));
      expect(toast.error).toHaveBeenCalledOnce();
      expect(toast.error).toHaveBeenCalledWith("Replacement not started", { description: "123 Main St" });
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("refreshes the drip card in finally after a failed switch, keeping the alert", async () => {
      setInboxDispoAndStartDripMock.mockResolvedValue({ ok: true, enrollment: { status: "skipped", reason: "Already in Current drip. Stop it or switch." } });
      changeDripActionMock.mockResolvedValue({ ok: false, error: { message: "Replacement failed" } });
      const user = userEvent.setup();
      const { onDripChanged } = renderBar({
        activeDripEnrollmentId: "e1",
        activeDripSequenceId: "current",
        activeDripName: "Current drip",
        activeDripStep: 1,
        activeDripTotal: 2,
      });
      await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
      await pickSeedDrip(user);
      await user.click(await screen.findByRole("button", { name: "Switch to this drip" }));
      await waitFor(() => expect(onDripChanged).toHaveBeenCalled());
      expect(await screen.findByTestId("drip-cant-start")).toHaveTextContent("Replacement failed");
      expect(toast.error).toHaveBeenLastCalledWith("Replacement failed", { description: "123 Main St" });
    });

    it("refreshes the drip card after a thrown switch", async () => {
      setInboxDispoAndStartDripMock.mockResolvedValue({ ok: true, enrollment: { status: "skipped", reason: "Already in Current drip. Stop it or switch." } });
      changeDripActionMock.mockRejectedValue(new Error("network"));
      const user = userEvent.setup();
      const { onDripChanged } = renderBar({
        activeDripEnrollmentId: "e1",
        activeDripSequenceId: "current",
        activeDripName: "Current drip",
        activeDripStep: 1,
        activeDripTotal: 2,
      });
      await user.click(screen.getByTestId("dispo-needs-sequence").querySelector("button")!);
      await pickSeedDrip(user);
      await user.click(await screen.findByRole("button", { name: "Switch to this drip" }));
      await waitFor(() => expect(onDripChanged).toHaveBeenCalled());
      expect(await screen.findByTestId("drip-cant-start")).toHaveTextContent("Could not switch drips");
      expect(toast.error).toHaveBeenLastCalledWith("Could not switch drips. Open the lead to review its current drip.", { description: "123 Main St" });
    });
  });

  describe("syncFromProps", () => {
    it("follows a new server value without remounting and keeps the failed-start alert", async () => {
      startDripForLeadsMock.mockResolvedValue({
        ok: true,
        data: { results: [{ propertyId: "prop-1", status: "skipped", reason: "Refused" }] },
      });
      const user = userEvent.setup();
      const { rerender } = renderBar({ initialDispo: "not_interested" });
      await user.click(screen.getByRole("button", { name: "Also start a drip" }));
      await pickSeedDrip(user);
      await screen.findByTestId("drip-cant-start");
      rerender(
        <OutcomeBar
          propertyId="prop-1"
          propertyAddress="123 Main St"
          initialDispo="nurture"
          propertyStatus="new_lead"
          currentUserId="user-1"
          {...leadPage}
        />,
      );
      expect(screen.getByText("Follow up", { selector: "span" })).toBeInTheDocument();
      expect(screen.getByTestId("drip-cant-start")).toBeInTheDocument();
    });

    it("ignores new server values by default", () => {
      const { rerender } = renderBar({ initialDispo: "not_interested" }, {});
      rerender(
        <OutcomeBar
          propertyId="prop-1"
          contactId="contact-1"
          propertyAddress="123 Main St"
          initialDispo="nurture"
          propertyStatus="new_lead"
          currentUserId="user-1"
        />,
      );
      expect(screen.getByText("Not interested", { selector: "span" })).toBeInTheDocument();
      expect(screen.queryByText("Follow up", { selector: "span" })).toBeNull();
    });
  });

  describe("Messages defaults", () => {
    it("announces a saved outcome when its drip start fails", async () => {
      setInboxDispoAndStartDripMock.mockResolvedValue({ ok: false, committed: true, error: "Enrollment failed" });
      const user = userEvent.setup();
      renderBar({}, {});
      await user.click(screen.getByRole("button", { name: /^Needs drip$/ }));
      await pickSeedDrip(user);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Outcome saved. Drip not started: Enrollment failed", { description: "123 Main St" }));
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("announces completion only after the outcome is saved", async () => {
      let complete!: (result: { ok: true }) => void;
      setOutreachDispoMock.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
      const user = userEvent.setup();
      renderBar({}, {});
      await user.click(screen.getByTestId("dispo-follow-up"));
      expect(toast.success).not.toHaveBeenCalled();
      expect(screen.getByTestId("dispo-follow-up")).toBeDisabled();
      complete({ ok: true });
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Saved: Follow up", { description: "123 Main St" }));
    });

    it.each([
      ["dispo-wrong-number", "Marked wrong number — consider skip-tracing a new number."],
      ["dispo-not-interested", "Saved: Not interested"],
      ["dispo-bad-number", "Saved: Bad / disconnected #"],
      ["dispo-opted-out", "Saved: SMS opted out"],
    ])("announces the saved outcome for %s", async (button, message) => {
      const user = userEvent.setup();
      renderBar({}, {});
      if (button === "dispo-bad-number" || button === "dispo-opted-out") await user.click(screen.getByTestId("dispo-more"));
      await user.click(await screen.findByTestId(button));
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith(message, { description: "123 Main St" });
    });

    it.each([false, true])("does not announce success for a failed outcome (committed=%s)", async (committed) => {
      setOutreachDispoMock.mockResolvedValue({ ok: false, committed, error: "Safety update failed" });
      const user = userEvent.setup();
      renderBar({}, {});
      await user.click(screen.getByTestId("dispo-follow-up"));
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith("Safety update failed", { description: "123 Main St" });
    });

    it.each(["enrolled", "failed", "skipped"] as const)("announces the actual drip result: %s", async (status) => {
      setInboxDispoAndStartDripMock.mockResolvedValue({ ok: true, enrollment: { status, reason: "Result detail" } });
      const user = userEvent.setup();
      renderBar({}, {});
      await user.click(screen.getByRole("button", { name: /^Needs drip$/ }));
      await pickSeedDrip(user);
      if (status === "enrolled") expect(toast.success).toHaveBeenCalledWith("Drip started", { description: "123 Main St" });
      else {
        expect(toast.success).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith("Outcome saved. Drip not started: Result detail", { description: "123 Main St" });
      }
    });

    it.each([false, true])("keeps Messages open after promotion (alreadyQualified=%s)", async (alreadyQualified) => {
      moveMessageThreadToLeadMock.mockResolvedValue({ ok: true, alreadyQualified });
      const user = userEvent.setup();
      renderBar({ propertyStatus: "prospect" }, {});

      await user.click(screen.getByTestId("message-move-to-lead"));

      expect(moveMessageThreadToLeadMock).toHaveBeenCalledWith("prop-1");
      expect(routerMock.push).not.toHaveBeenCalled();
      expect(routerMock.refresh).toHaveBeenCalledOnce();
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith(alreadyQualified ? "Already a lead" : "Moved to lead", { description: "123 Main St" });
      expect(screen.getByTestId("message-move-to-lead")).toBeDisabled();
    });

    it("keeps a failed promotion retryable without navigating", async () => {
      moveMessageThreadToLeadMock.mockResolvedValue({ ok: false, error: "Qualification did not save" });
      const user = userEvent.setup();
      renderBar({ propertyStatus: "prospect" }, {});

      await user.click(screen.getByTestId("message-move-to-lead"));

      expect(toast.error).toHaveBeenCalledWith("Qualification did not save", { description: "123 Main St" });
      expect(routerMock.push).not.toHaveBeenCalled();
      expect(routerMock.refresh).not.toHaveBeenCalled();
      expect(screen.getByTestId("message-move-to-lead")).toBeEnabled();
    });

    it("shows Move to Lead and Book appt unless told otherwise", () => {
      renderBar({}, {});
      expect(screen.getByTestId("message-move-to-lead")).toBeInTheDocument();
      expect(screen.getByTestId("book-appointment")).toHaveTextContent("Book appt");
    });

    it("omits Book appt when there is no contact", () => {
      renderBar({ contactId: null }, {});
      expect(screen.queryByTestId("book-appointment")).toBeNull();
    });
  });
});
