import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DialpadCallStatus } from "@/lib/dialpad-cti/contracts";

const statusMock = vi.fn();
vi.mock("../dialpad-actions", () => ({ getDialpadCallStatusAction: (...a: unknown[]) => statusMock(...a) }));

import { DialStatus, type DialFlight } from "./dial-status";

const mk = (over: Partial<DialpadCallStatus> = {}): DialpadCallStatus => ({
  intentId: "i1", state: "dialing", connected: false, propertyId: "p1", expiresAt: "x",
  dispatchAuthorizedAt: null, failedAt: null, callActivityId: null, attemptId: null, startedAt: null,
  endedAt: null, durationSeconds: null, talkDurationSeconds: null, recordingCaptureId: null, ...over,
});
const flight = (over: Partial<Extract<DialFlight, { kind: "in_flight" }>> = {}): DialFlight => ({
  kind: "in_flight", intentId: "i1", propertyId: "p1", label: "12 Elm", uncertain: false, ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  statusMock.mockReset();
});
afterEach(() => vi.useRealTimers());

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setup = (f: DialFlight | null, extra: Partial<Parameters<typeof DialStatus>[0]> = {}) => {
  const p = { onRetry: vi.fn(), onDismiss: vi.fn(), onEnded: vi.fn(), onLogOutcome: vi.fn(), ...extra };
  render(<DialStatus flight={f} {...p} />);
  return p;
};

describe("<DialStatus /> in flight", () => {
  it.each([
    ["prepared", "Preparing"],
    ["awaiting_provider", "Calling. Waiting for Dialpad to confirm."],
    ["dialing", "Dialing. Not answered yet."],
    ["connected", "Connected. Confirmed by Dialpad."],
    ["cancelled", "Cancelled. Nothing was dialed."],
    ["expired", "No confirmation from Dialpad. Check the dialer before calling again."],
    ["failed", "Dialpad never confirmed this call. Nothing was logged. Is the Dialpad desktop app open?"],
  ] as const)("shows the %s label", async (state, label) => {
    statusMock.mockResolvedValue({ ok: true, status: mk({ state }) });
    setup(flight());
    await tick(0);
    expect(screen.getByTestId("dial-status")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("dial-status")).toHaveTextContent(label);
  });

  it("describes an unanswered ended call with duration and stops polling, firing onEnded once", async () => {
    statusMock.mockResolvedValue({ ok: true, status: mk({ state: "ended", connected: false, durationSeconds: 65, callActivityId: "ca1" }) });
    const p = setup(flight());
    await tick(0);
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Call ended. Not answered. (1:05)");
    await tick(20_000);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(p.onEnded).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while active", async () => {
    statusMock.mockResolvedValue({ ok: true, status: mk({ state: "dialing" }) });
    setup(flight(), { pollMs: 1000 });
    await tick(0);
    await tick(3000);
    expect(statusMock).toHaveBeenCalledTimes(4);
  });

  it("shows the uncertain copy until a status arrives and never retries", async () => {
    statusMock.mockReturnValue(new Promise(() => {}));
    const p = setup(flight({ uncertain: true }));
    await tick(10_000);
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Sandra sent the call but Dialpad has not confirmed it yet.");
    expect(p.onRetry).not.toHaveBeenCalled();
  });

  it("Log outcome passes the property and call activity", async () => {
    statusMock.mockResolvedValue({ ok: true, status: mk({ state: "ended", connected: true, callActivityId: "ca1" }) });
    vi.useRealTimers();
    const p = setup(flight());
    await userEvent.click(await screen.findByRole("button", { name: "Log outcome" }));
    expect(p.onLogOutcome).toHaveBeenCalledWith("p1", "ca1");
  });

  it("shows the message and stops polling on {ok:false}", async () => {
    statusMock.mockResolvedValue({ ok: false, code: "x", message: "Status unavailable." });
    setup(flight());
    await tick(0);
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Status unavailable.");
    await tick(20_000);
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it("dismiss is available on terminal displays", async () => {
    statusMock.mockResolvedValue({ ok: true, status: mk({ state: "cancelled" }) });
    vi.useRealTimers();
    const p = setup(flight());
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(p.onDismiss).toHaveBeenCalled();
  });
});

describe("<DialStatus /> rate limited and error", () => {
  const rl = (attempt: number): DialFlight => ({ kind: "rate_limited", propertyId: "p1", label: "12 Elm", retryAfterSeconds: 3, attempt });

  it("counts down then retries exactly once", async () => {
    const p = setup(rl(1));
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Retrying in 3s…");
    await tick(2000);
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Retrying in 1s…");
    expect(p.onRetry).not.toHaveBeenCalled();
    await tick(1000);
    expect(p.onRetry).toHaveBeenCalledTimes(1);
    expect(p.onRetry).toHaveBeenCalledWith("p1");
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Retrying…");
    await tick(10_000);
    expect(p.onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not auto retry on attempt 2 or later", async () => {
    const p = setup(rl(2));
    await tick(10_000);
    expect(p.onRetry).not.toHaveBeenCalled();
    expect(screen.getByTestId("dial-status")).toHaveTextContent("Dialpad is still rate limiting calls. Try again in a minute.");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("never re-dials an in-flight call", async () => {
    statusMock.mockResolvedValue({ ok: true, status: mk({ state: "expired" }) });
    const p = setup(flight({ uncertain: true }));
    await tick(30_000);
    expect(p.onRetry).not.toHaveBeenCalled();
  });

  it("shows an error with Dismiss", () => {
    setup({ kind: "error", propertyId: "p1", label: "12 Elm", message: "No phone." });
    expect(screen.getByTestId("dial-status")).toHaveTextContent("No phone.");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("renders nothing without a flight", () => {
    setup(null);
    expect(screen.queryByTestId("dial-status")).not.toBeInTheDocument();
  });
});
