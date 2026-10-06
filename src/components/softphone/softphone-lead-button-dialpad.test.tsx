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
import { useApiDial } from "@/app/(dashboard)/my-leads/_components/use-api-dial";
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
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/could not confirm/);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    mocks.dialLeadAction.mockResolvedValueOnce({ ok: false, code: "not_configured", message: "Dialpad click-to-dial is not enabled for this organization." });
    await user.click(screen.getByTestId("call-lead-button"));
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

  it("after a thrown could-not-confirm request the lock stays held until Dismiss", async () => {
    const user = userEvent.setup();
    mocks.dialLeadAction.mockRejectedValueOnce(new Error("network"));
    renderButton(true);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText(/could not confirm/);
    expect(probe.lock?.holder()).toBe("dialpad");
    expect(screen.getByText("Call with coach")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
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

function Extra({ onReady }: { onReady: (start: (propertyId: string, attempt: number) => Promise<void>) => void }) {
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
    let start: ((propertyId: string, attempt: number) => Promise<void>) | null = null;
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
