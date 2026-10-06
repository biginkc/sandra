import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openLead: vi.fn(),
  dialLeadAction: vi.fn(),
  getStatus: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./softphone-provider", () => ({
  useOptionalSoftphone: () => ({ openLead: mocks.openLead, callingEnabled: true }),
}));
vi.mock("@/app/(dashboard)/my-leads/dialpad-actions", () => ({
  dialLeadAction: mocks.dialLeadAction,
  getDialpadCallStatusAction: mocks.getStatus,
}));

import { StrictMode } from "react";
import { CallLockProvider, useCallLock } from "@/components/calls/call-lock-context";
import type { CallLock } from "@/lib/calls/call-lock";
import { DIAL_CALL_CEILING_MS, useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";
import { useOptionalDialpadCall } from "@/components/dialpad/dialpad-call-context";
import { DialpadCallProvider } from "@/components/dialpad/dialpad-call-provider";
import { SoftphoneLeadButton } from "./softphone-lead-button";

const lead = {
  id: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  firstName: "Seller",
  name: "Seller One",
  address: "1 Main St",
  state: "MO",
  phones: ["+18165550123"],
  dncLocked: false,
  contactDnc: false,
  callable: true,
};

const probe: { lock: CallLock | null } = { lock: null };
function LockProbe() {
  const lock = useCallLock();
  useEffect(() => {
    probe.lock = lock;
  });
  return null;
}

function renderButton(enabled: boolean, leadOverride = lead) {
  return render(
    <CallLockProvider>
      <LockProbe />
      <DialpadCallProvider enabled={enabled}>
        <SoftphoneLeadButton lead={leadOverride} />
      </DialpadCallProvider>
    </CallLockProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStatus.mockResolvedValue({ ok: false, code: "denied", message: "x" });
});

describe("SoftphoneLeadButton Dialpad routing", () => {
  it("uses the softphone and never Dialpad when the server route is off", async () => {
    const user = userEvent.setup();
    renderButton(false);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.openLead).toHaveBeenCalledWith(lead);
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
  });

  it("route off shows only the existing Call", () => {
    renderButton(false);
    expect(screen.getByTestId("call-lead-button")).toBeInTheDocument();
    expect(screen.queryByText("Call with coach")).not.toBeInTheDocument();
  });

  it("route on shows both; Call goes to Dialpad, Call with coach opens the softphone", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderButton(true);
    expect(screen.getByTestId("call-lead-button")).toBeInTheDocument();
    await user.click(screen.getByText("Call with coach"));
    expect(mocks.openLead).toHaveBeenCalledWith(lead);
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1));
    expect(mocks.openLead).toHaveBeenCalledTimes(1);
  });

  it("uses the softphone when there is no provider at all", async () => {
    const user = userEvent.setup();
    render(<SoftphoneLeadButton lead={lead} />);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.openLead).toHaveBeenCalledWith(lead);
  });

  it("places the call through Dialpad with the property and contact ids when the route is on", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1));
    expect(mocks.dialLeadAction).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: lead.id, contactId: lead.contactId, idempotencyKey: expect.any(String) }),
    );
    expect(mocks.openLead).not.toHaveBeenCalled();
    expect(await screen.findByTestId("dialpad-call-status")).toBeInTheDocument();
  });

  it("keeps the softphone path for a lead with no contact even when the route is on", async () => {
    const user = userEvent.setup();
    renderButton(true, { ...lead, contactId: null } as unknown as typeof lead);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.openLead).toHaveBeenCalled();
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
  });

  it("falls back to the softphone when the server answers not_configured", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: false, code: "not_configured", message: "off" });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(mocks.openLead).toHaveBeenCalledWith(lead));
    expect(screen.queryByTestId("dial-status")).not.toBeInTheDocument();
  });

  it("shows the quiet-hours denial without opening the softphone", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: false, code: "denied", denial: "outside_calling_hours", message: "Calling is unavailable during quiet hours." });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByText(/quiet hours/)).toBeInTheDocument();
    expect(mocks.openLead).not.toHaveBeenCalled();
  });

  it("shows a denial and offers a confirmed redial for an unresolved prior call", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "denied", message: "Your Dialpad account is not verified." });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByText(/not verified/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "prior_call_unresolved", message: "An earlier call may have rung.", priorIntentId: "33333333-3333-4333-8333-333333333333" });
    await user.click(screen.getByTestId("call-lead-button"));
    await user.click(await screen.findByRole("button", { name: "Call again anyway" }));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenLastCalledWith(expect.objectContaining({ confirmRedialOf: "33333333-3333-4333-8333-333333333333" })));
  });

  it("disables Call with coach while a Dialpad call is active", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderButton(true);
    expect(screen.getByText("Call with coach")).toBeEnabled();
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(screen.getByText("Call with coach")).toBeDisabled());
    await user.click(screen.getByText("Call with coach"));
    expect(mocks.openLead).not.toHaveBeenCalled();
  });

  it("refuses a Dialpad call while the softphone holds the call lock", async () => {
    const user = userEvent.setup();
    renderButton(true);
    expect(probe.lock?.acquire("softphone", Symbol("test"))).toBe(true);
    await user.click(screen.getByTestId("call-lead-button"));
    expect(mocks.dialLeadAction).not.toHaveBeenCalled();
    expect(await screen.findByText(/Finish your current call before starting another/)).toBeInTheDocument();
    expect(probe.lock?.holder()).toBe("softphone");
  });

  it("does not auto-dial the softphone for not_configured after an attempt that may have rung", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockRejectedValueOnce(new Error("network"));
    function SameFlightRetry() {
      const dialpad = useOptionalDialpadCall();
      return (
        <button type="button" onClick={() => dialpad?.startCall({ propertyId: lead.id, contactId: lead.contactId, label: lead.name, onFallback: mocks.openLead })}>
          retry same lead
        </button>
      );
    }
    render(
      <CallLockProvider>
        <LockProbe />
        <DialpadCallProvider enabled>
          <SameFlightRetry />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    await user.click(screen.getByText("retry same lead"));
    await screen.findByText(/could not confirm/);
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "not_configured", message: "Dialpad click-to-dial is not enabled for this organization." });
    await user.click(screen.getByText("retry same lead"));
    expect(await screen.findByText(/not enabled/)).toBeInTheDocument();
    expect(mocks.openLead).not.toHaveBeenCalled();
  });

  it("holds Call with coach and shows a pending Call while the Dialpad request is still in flight", async () => {
    const user = userEvent.setup();
    let release: (value: unknown) => void = () => {};
    mocks.dialLeadAction.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(screen.getByText("Call with coach")).toBeDisabled());
    expect(screen.getByTestId("call-lead-button")).toBeDisabled();
    expect(screen.getByTestId("call-lead-button")).toHaveTextContent("Calling…");
    await user.click(screen.getByText("Call with coach"));
    expect(mocks.openLead).not.toHaveBeenCalled();
    release({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    await screen.findByTestId("dialpad-call-status");
  });

  it("a refusal releases the lock and re-enables both buttons", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "denied", message: "Your Dialpad account is not verified." });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/not verified/);
    expect(probe.lock?.holder()).toBeNull();
    expect(screen.getByTestId("call-lead-button")).toBeEnabled();
    expect(screen.getByText("Call with coach")).toBeEnabled();
  });

  it("after a thrown could-not-confirm request the lock stays held through Dismiss and is freed by a confirmed Mark call ended", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockRejectedValueOnce(new Error("network"));
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/could not confirm/);
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(screen.getByText("Call with coach")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(probe.lock?.holder()).toBe("dialpad");
    await user.click(screen.getByTestId("dialpad-call-show"));
    await user.click(screen.getByRole("button", { name: "Mark call ended" }));
    await user.click(screen.getByRole("button", { name: "Yes, it ended" }));
    expect(probe.lock?.holder()).toBeNull();
    expect(screen.getByText("Call with coach")).toBeEnabled();
  });

  it("\"Call again anyway\" is refused while the softphone is live", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "prior_call_unresolved", message: "An earlier call may have rung.", priorIntentId: "33333333-3333-4333-8333-333333333333" });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    const again = await screen.findByRole("button", { name: "Call again anyway" });
    expect(probe.lock?.acquire("softphone", Symbol("test"))).toBe(true);
    await user.click(again);
    expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Finish your current call before starting another/)).toBeInTheDocument();
  });
});

describe("rate-limit countdown (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the lock during the countdown, blocks coach, then retries exactly once", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.dialLeadAction
      .mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "slow down", retryAfterSeconds: 2, freshAttemptKey: true })
      .mockResolvedValueOnce({ ok: true, intentId: "i2", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/Retrying in/);
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(screen.getByText("Call with coach")).toBeDisabled();
    expect(probe.lock?.acquire("softphone", Symbol("test"))).toBe(false);
    await user.click(screen.getByText("Call with coach"));
    expect(mocks.openLead).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(2));
    expect(mocks.openLead).not.toHaveBeenCalled();
  });

  it("releases the lock and resets the button after the rate limit gives up", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.dialLeadAction
      .mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "slow", retryAfterSeconds: 1, freshAttemptKey: true })
      .mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "slow", retryAfterSeconds: 1, freshAttemptKey: true });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/Retrying in/);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await screen.findByText(/still rate limiting/);
    expect(probe.lock?.holder()).toBeNull();
    expect(screen.getByTestId("call-lead-button")).toBeEnabled();
    expect(screen.getByText("Call with coach")).toBeEnabled();
  });

  it("dismissing the countdown releases the lock", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "rate_limited", message: "slow down", retryAfterSeconds: 30, freshAttemptKey: true });
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/Retrying in/);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(probe.lock?.holder()).toBeNull();
    expect(screen.getByText("Call with coach")).toBeEnabled();
  });
});

function Extra({ onReady }: { onReady: (start: (propertyId: string, attempt: number) => Promise<boolean>) => void }) {
  const { startApiDial } = useApiDial(() => ({ contactId: lead.contactId, label: "Other" }));
  useEffect(() => {
    onReady(startApiDial);
  });
  return null;
}

describe.each([
  ["plain", false],
  ["StrictMode", true],
])("per-holder lock ownership (%s)", (_name, strict) => {
  const wrap = (node: React.ReactNode) => (strict ? <StrictMode>{node}</StrictMode> : <>{node}</>);

  it("a second useApiDial mounting and unmounting cannot free the provider's live call lock", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    const view = render(
      wrap(
        <CallLockProvider>
          <LockProbe />
          <DialpadCallProvider enabled>
            <SoftphoneLeadButton lead={lead} />
          </DialpadCallProvider>
        </CallLockProvider>,
      ),
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(probe.lock?.holder()).toBe("dialpad"));

    // A second Dialpad hook (for example the My Leads page) appears and goes away.
    let start: ((propertyId: string, attempt: number) => Promise<boolean>) | null = null;
    view.rerender(
      wrap(
        <CallLockProvider>
          <LockProbe />
          <DialpadCallProvider enabled>
            <SoftphoneLeadButton lead={lead} />
            <Extra onReady={(fn) => { start = fn; }} />
          </DialpadCallProvider>
        </CallLockProvider>,
      ),
    );
    expect(probe.lock?.holder()).toBe("dialpad");
    // Its own dial is refused while the provider's call holds the lock.
    await act(async () => {
      await start?.(lead.id, 1);
    });
    expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1);
    view.rerender(
      wrap(
        <CallLockProvider>
          <LockProbe />
          <DialpadCallProvider enabled>
            <SoftphoneLeadButton lead={lead} />
          </DialpadCallProvider>
        </CallLockProvider>,
      ),
    );
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(screen.getByText("Call with coach")).toBeDisabled();
  });
});

describe("one instance, one flight (N18)", () => {
  const leadB = { ...lead, id: "44444444-4444-4444-8444-444444444444", name: "Seller Two" };
  function Direct() {
    const dialpad = useOptionalDialpadCall();
    const go = (target: typeof lead) =>
      dialpad?.startCall({ propertyId: target.id, contactId: target.contactId, label: target.name, onFallback: () => {} });
    return (
      <>
        <button type="button" onClick={() => go(lead)}>dial A</button>
        <button type="button" onClick={() => go(leadB)}>dial B</button>
      </>
    );
  }
  const renderDirect = () =>
    render(
      <CallLockProvider>
        <LockProbe />
        <DialpadCallProvider enabled>
          <Direct />
        </DialpadCallProvider>
      </CallLockProvider>,
    );

  it("refuses a different lead while holding in an uncertain state, keeps the lock, and still allows the same flight", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockRejectedValueOnce(new Error("network"));
    renderDirect();
    await user.click(screen.getByText("dial A"));
    await screen.findByText(/could not confirm/);
    expect(probe.lock?.holder()).toBe("dialpad");

    await user.click(screen.getByText("dial B"));
    expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Finish your current call before starting another/)).toBeInTheDocument();
    expect(screen.getByText(/could not confirm/)).toBeInTheDocument();
    expect(probe.lock?.holder()).toBe("dialpad");

    mocks.dialLeadAction.mockResolvedValueOnce({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    await user.click(screen.getByText("dial A"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(2));
    expect(mocks.dialLeadAction.mock.calls[1]![0]).toMatchObject({ propertyId: lead.id });
    expect(probe.lock?.holder()).toBe("dialpad");
  });

  it("refuses a different lead while a call is live", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    renderDirect();
    await user.click(screen.getByText("dial A"));
    await screen.findByTestId("dialpad-call-status");
    await user.click(screen.getByText("dial B"));
    expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("dial-notice")).toHaveTextContent("Finish your current call");
    expect(probe.lock?.holder()).toBe("dialpad");
  });
});

const statusOf = (state: string) => ({
  ok: true,
  status: {
    intentId: "i1", state, connected: state === "ended", propertyId: lead.id, expiresAt: "x", dispatchAuthorizedAt: null, failedAt: null,
    callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null, recordingCaptureId: null,
  },
});

describe("the persistent provider owns the flight and the lock", () => {
  const leadB = { ...lead, id: "44444444-4444-4444-8444-444444444444", name: "Seller Two" };
  const accepted = { ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 };
  function Page({ target }: { target: typeof lead }) {
    const dialpad = useOptionalDialpadCall();
    return (
      <button type="button" onClick={() => dialpad?.startCall({ propertyId: target.id, contactId: target.contactId, label: target.name })}>
        {`dial ${target.name}`}
      </button>
    );
  }
  const shell = (page: React.ReactNode) => (
    <CallLockProvider>
      <LockProbe />
      <DialpadCallProvider enabled>{page}</DialpadCallProvider>
    </CallLockProvider>
  );

  it("a connected call keeps the lock when the page unmounts, and a second dial is refused", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(statusOf("connected"));
    const view = render(shell(<Page key="a" target={lead} />));
    await user.click(screen.getByText("dial Seller One"));
    await screen.findByText(/Connected/);
    expect(probe.lock?.holder()).toBe("dialpad");

    // Navigate away: the page unmounts, the layout provider does not.
    view.rerender(shell(<Page key="b" target={leadB} />));
    expect(probe.lock?.holder()).toBe("dialpad");
    await user.click(screen.getByText("dial Seller Two"));
    expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("dial-notice")).toHaveTextContent("Finish your current call");
    expect(probe.lock?.holder()).toBe("dialpad");
  });

  it("Dismiss while the status is not confirmed only hides the panel; the lock stays held", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(statusOf("failed"));
    render(shell(<Page target={lead} />));
    await user.click(screen.getByText("dial Seller One"));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(screen.getByTestId("dialpad-call-show")).toBeInTheDocument();
  });

  it("a connected call with healthy polling still offers Mark call ended, and a confirmed click releases the lock", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(statusOf("connected"));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    render(shell(<Page target={lead} />));
    await user.click(screen.getByText("dial Seller One"));
    await screen.findByText(/Connected/);
    await user.click(screen.getByRole("button", { name: "Mark call ended" }));
    expect(probe.lock?.holder()).toBe("dialpad");
    await user.click(screen.getByRole("button", { name: "Yes, it ended" }));
    expect(probe.lock?.holder()).toBeNull();
  });

  it("a terminal hangup status releases the lock", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(statusOf("ended"));
    render(shell(<Page target={lead} />));
    await user.click(screen.getByText("dial Seller One"));
    await screen.findByText(/Call ended/);
    await waitFor(() => expect(probe.lock?.holder()).toBeNull());
  });

  it("\"Mark call ended\" asks for confirmation and then releases", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(statusOf("failed"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    render(shell(<Page target={lead} />));
    await user.click(screen.getByText("dial Seller One"));
    await user.click(await screen.findByRole("button", { name: "Mark call ended" }));
    expect(probe.lock?.holder()).toBe("dialpad");
    await user.click(screen.getByRole("button", { name: "Yes, it ended" }));
    expect(probe.lock?.holder()).toBeNull();
    expect(info).toHaveBeenCalledWith("[dialpad] call lock released manually", expect.objectContaining({ propertyId: lead.id }));
    info.mockRestore();
  });

  it("the ceiling releases the lock with a visible notice", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mocks.dialLeadAction.mockResolvedValue(accepted);
      mocks.getStatus.mockResolvedValue(statusOf("connected"));
      render(shell(<Page target={lead} />));
      await user.click(screen.getByText("dial Seller One"));
      await screen.findByText(/Connected/);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DIAL_CALL_CEILING_MS + 1000);
      });
      expect(probe.lock?.holder()).toBeNull();
      expect(screen.getByTestId("dial-notice")).toHaveTextContent("released the call lock");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("unknown status and ceilings (fake timers)", () => {
    const TEN_MIN = 10 * 60 * 1000;
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const start = async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mocks.dialLeadAction.mockResolvedValue(accepted);
      render(shell(<Page target={lead} />));
      await user.click(screen.getByText("dial Seller One"));
    };
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    it("connected, one failed check, connected again: still held at 10 minutes + 1s", async () => {
      let n = 0;
      mocks.getStatus.mockImplementation(async () => {
        n += 1;
        if (n === 2) throw new Error("blip");
        return statusOf("connected");
      });
      await start();
      await screen.findByText(/Connected/);
      await advance(TEN_MIN + 1000);
      expect(probe.lock?.holder()).toBe("dialpad");
      expect(n).toBeGreaterThan(3);
    });

    it("connected, then repeated failures: held at 10 minutes + 1s, released at 2h with a notice", async () => {
      let n = 0;
      mocks.getStatus.mockImplementation(async () => {
        n += 1;
        if (n >= 2) throw new Error("down");
        return statusOf("connected");
      });
      await start();
      await screen.findByText(/Connected/);
      await advance(TEN_MIN + 1000);
      expect(probe.lock?.holder()).toBe("dialpad");
      await advance(2 * 60 * 60 * 1000);
      expect(probe.lock?.holder()).toBeNull();
      expect(screen.getByTestId("dial-notice")).toHaveTextContent("2 hours");
    });

    it("a never-confirmed call with unknown status is released at 10 minutes", async () => {
      mocks.getStatus.mockResolvedValue(statusOf("failed"));
      await start();
      await screen.findByRole("button", { name: "Mark call ended" });
      await advance(TEN_MIN - 5000);
      expect(probe.lock?.holder()).toBe("dialpad");
      await advance(10000);
      expect(probe.lock?.holder()).toBeNull();
      expect(screen.getByTestId("dial-notice")).toHaveTextContent("10 minutes");
    });

    it("lost response, a same-lead retry in flight when the 10-minute ceiling is due: the lock stays held and the retry then holds it", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      mocks.dialLeadAction.mockRejectedValueOnce(new Error("lost"));
      mocks.getStatus.mockResolvedValue(statusOf("connected"));
      render(shell(<Page target={lead} />));
      await user.click(screen.getByText("dial Seller One"));
      await screen.findByText(/could not confirm/);
      await advance(TEN_MIN - 1000);
      expect(probe.lock?.holder()).toBe("dialpad");

      // The retry is still awaiting its response when the original ceiling would fire.
      let resolveRetry: (value: unknown) => void = () => {};
      mocks.dialLeadAction.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
      await user.click(screen.getByText("dial Seller One"));
      await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(2));
      await advance(5000);
      expect(probe.lock?.holder()).toBe("dialpad");
      expect(probe.lock?.acquire("softphone", Symbol("telnyx"))).toBe(false);

      await act(async () => {
        resolveRetry(accepted);
      });
      await screen.findByText(/Connected/);
      expect(probe.lock?.holder()).toBe("dialpad");
      expect(probe.lock?.acquire("softphone", Symbol("telnyx"))).toBe(false);
      // The old ceiling never fires on the new hold.
      await advance(TEN_MIN);
      expect(probe.lock?.holder()).toBe("dialpad");
    });

    it("a 2h ceiling armed for a live call releases once, with a notice, and never early; a re-click near it is not a new attempt", async () => {
      mocks.getStatus.mockResolvedValue(statusOf("connected"));
      await start();
      await screen.findByText(/Connected/);
      await advance(2 * 60 * 60 * 1000 - 2000);
      // A re-click on the live lead only re-shows the panel.
      await act(async () => {
        screen.getByText("dial Seller One").click();
      });
      expect(mocks.dialLeadAction).toHaveBeenCalledTimes(1);
      expect(probe.lock?.holder()).toBe("dialpad");
      await advance(5000);
      expect(probe.lock?.holder()).toBeNull();
      expect(screen.getByTestId("dial-notice")).toHaveTextContent("2 hours");
    });

    it("the 2h ceiling does not fire early", async () => {
      mocks.getStatus.mockResolvedValue(statusOf("connected"));
      await start();
      await screen.findByText(/Connected/);
      await advance(2 * 60 * 60 * 1000 - 60 * 1000);
      expect(probe.lock?.holder()).toBe("dialpad");
      await advance(2 * 60 * 1000);
      expect(probe.lock?.holder()).toBeNull();
    });
  });

  it("the panel stays visible while the lock is held even if the route flips off", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(statusOf("connected"));
    const view = render(shell(<Page target={lead} />));
    await user.click(screen.getByText("dial Seller One"));
    await screen.findByText(/Connected/);
    view.rerender(
      <CallLockProvider>
        <LockProbe />
        <DialpadCallProvider enabled={false}>
          <Page target={lead} />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    expect(screen.getByTestId("dialpad-call-status")).toBeInTheDocument();
    expect(probe.lock?.holder()).toBe("dialpad");
  });
});

describe("a joining attempt never frees an existing hold (lost response)", () => {
  function Page({ onFallback }: { onFallback?: () => void }) {
    const dialpad = useOptionalDialpadCall();
    return (
      <button type="button" onClick={() => dialpad?.startCall({ propertyId: lead.id, contactId: lead.contactId, label: lead.name, onFallback })}>
        dial
      </button>
    );
  }
  const setup = async (onFallback?: () => void) => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockRejectedValueOnce(new Error("lost response"));
    render(
      <CallLockProvider>
        <LockProbe />
        <DialpadCallProvider enabled>
          <Page onFallback={onFallback} />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    await user.click(screen.getByText("dial"));
    await screen.findByText(/could not confirm/);
    expect(probe.lock?.holder()).toBe("dialpad");
    return user;
  };
  const expectStillHeld = () => {
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(probe.lock?.acquire("softphone", Symbol("telnyx"))).toBe(false);
  };

  it("a retry answered call_in_flight keeps the lock", async () => {
    const user = await setup();
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "call_in_flight", message: "A call is already being placed." });
    await user.click(screen.getByText("dial"));
    await screen.findByText(/already being placed/);
    expectStillHeld();
    // Dismiss only hides it; still held.
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expectStillHeld();
  });

  it("a thrown retry keeps the lock", async () => {
    const user = await setup();
    mocks.dialLeadAction.mockRejectedValueOnce(new Error("lost again"));
    await user.click(screen.getByText("dial"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(2));
    expectStillHeld();
  });

  it("a retry answered not_configured keeps the lock and does not fall back", async () => {
    const fallback = vi.fn();
    const user = await setup(fallback);
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "not_configured", message: "Dialpad click-to-dial is not enabled for this organization." });
    await user.click(screen.getByText("dial"));
    await screen.findByText(/not enabled/);
    expect(fallback).not.toHaveBeenCalled();
    expectStillHeld();
  });
});

describe("panel actions are bound to their own flight", () => {
  const leadB = { ...lead, id: "44444444-4444-4444-8444-444444444444", name: "Seller Two" };
  function Pair() {
    const dialpad = useOptionalDialpadCall();
    const go = (t: typeof lead) => dialpad?.startCall({ propertyId: t.id, contactId: t.contactId, label: t.name });
    return (
      <>
        <button type="button" onClick={() => go(lead)}>dial A</button>
        <button type="button" onClick={() => go(leadB)}>dial B</button>
      </>
    );
  }

  it("an old refusal panel's Dismiss cannot free a newer pending call's lock", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "denied", message: "Not verified for A." });
    let resolveB: (value: unknown) => void = () => {};
    mocks.dialLeadAction.mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    mocks.getStatus.mockResolvedValue(statusOf("connected"));
    render(
      <CallLockProvider>
        <LockProbe />
        <DialpadCallProvider enabled>
          <Pair />
        </DialpadCallProvider>
      </CallLockProvider>,
    );
    // A is refused and its panel stays visible.
    await user.click(screen.getByText("dial A"));
    await screen.findByText(/Not verified for A/);
    expect(probe.lock?.holder()).toBeNull();
    // Another lead's call goes pending.
    await user.click(screen.getByText("dial B"));
    await waitFor(() => expect(probe.lock?.holder()).toBe("dialpad"));
    // Dismiss on the old panel leaves the new flight's lock held.
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(probe.lock?.acquire("softphone", Symbol("telnyx"))).toBe(false);
    // The new flight then resolves normally and keeps the lock while connected.
    await act(async () => {
      resolveB({ ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 });
    });
    await screen.findByText(/Connected/);
    expect(probe.lock?.holder()).toBe("dialpad");
  });
});

describe("an ended call's panel clears when its attempt is saved", () => {
  const accepted = { ok: true, intentId: "i1", state: "awaiting_provider", uncertain: false, phoneSlot: 1 };
  const ended = (callActivityId: string) => {
    const base = statusOf("ended");
    return { ...base, status: { ...base.status, callActivityId, durationSeconds: 44 } };
  };
  function Page() {
    const dialpad = useOptionalDialpadCall();
    return (
      <>
        <button type="button" onClick={() => dialpad?.startCall({ propertyId: lead.id, contactId: lead.contactId, label: lead.name })}>dial</button>
        <button type="button" onClick={() => dialpad?.clearEndedCall?.("act-other")}>save other</button>
        <button type="button" onClick={() => dialpad?.clearEndedCall?.("act-1")}>save this</button>
      </>
    );
  }
  const renderPage = () =>
    render(
      <CallLockProvider>
        <LockProbe />
        <DialpadCallProvider enabled>
          <Page />
        </DialpadCallProvider>
      </CallLockProvider>,
    );

  it("clears on the matching call activity, ignores another, and the lock was already released", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue(ended("act-1"));
    renderPage();
    await user.click(screen.getByText("dial"));
    await screen.findByText(/Call ended/);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(probe.lock?.holder()).toBeNull();

    await user.click(screen.getByText("save other"));
    expect(screen.getByText(/Call ended/)).toBeInTheDocument();

    await user.click(screen.getByText("save this"));
    await waitFor(() => expect(screen.queryByText(/Call ended/)).not.toBeInTheDocument());
    expect(probe.lock?.holder()).toBeNull();
  });

  it("a stale ended panel's Dismiss never deletes a newer attempt's key; the lost response then reuses it", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce(accepted);
    mocks.getStatus.mockResolvedValue(ended("act-1"));
    renderPage();
    await user.click(screen.getByText("dial"));
    await screen.findByText(/Call ended/);
    // Start a new call to the same lead; it is pending when the old panel is dismissed.
    let rejectB: (error: Error) => void = () => {};
    mocks.dialLeadAction.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectB = reject; }));
    await user.click(screen.getByText("dial"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    // The response is lost; the retry reuses the same key.
    await act(async () => {
      rejectB(new Error("lost"));
    });
    await screen.findByText(/could not confirm/);
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "call_in_flight", message: "A call is already being placed." });
    await user.click(screen.getByText("dial"));
    await waitFor(() => expect(mocks.dialLeadAction).toHaveBeenCalledTimes(3));
    const keys = mocks.dialLeadAction.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });

  it("clearEndedCall is a no-op against a live flight", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValue(accepted);
    mocks.getStatus.mockResolvedValue({ ...statusOf("connected"), status: { ...statusOf("connected").status, callActivityId: "act-1" } });
    renderPage();
    await user.click(screen.getByText("dial"));
    await screen.findByText(/Connected/);
    await user.click(screen.getByText("save this"));
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
    expect(probe.lock?.holder()).toBe("dialpad");
  });

  it("clearEndedCall for the old call cannot clear a newer flight for the same lead", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockResolvedValueOnce(accepted);
    mocks.getStatus.mockResolvedValueOnce(ended("act-1"));
    renderPage();
    await user.click(screen.getByText("dial"));
    await screen.findByText(/Call ended/);
    // A newer call to the same lead goes live.
    mocks.dialLeadAction.mockResolvedValueOnce({ ...accepted, intentId: "i2" });
    mocks.getStatus.mockResolvedValue({ ...statusOf("connected"), status: { ...statusOf("connected").status, intentId: "i2" } });
    await user.click(screen.getByText("dial"));
    await screen.findByText(/Connected/);
    await user.click(screen.getByText("save this"));
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
    expect(probe.lock?.holder()).toBe("dialpad");
  });
});
