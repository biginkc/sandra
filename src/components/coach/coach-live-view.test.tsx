import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CoachCallContext } from "@/lib/coach/types";

type BroadcastHandler = (message: { payload: unknown }) => void;
type SubscribeCallback = (status: string) => void;

type MockChannel = {
  on: (type: string, filter: unknown, handler: BroadcastHandler) => MockChannel;
  subscribe: (cb: SubscribeCallback) => MockChannel;
  _broadcastHandler: BroadcastHandler | null;
};

const { loadCoachCallContext } = vi.hoisted(() => ({ loadCoachCallContext: vi.fn() }));

vi.mock("@/lib/coach/coach-context-actions", () => ({ loadCoachCallContext }));

let channels: MockChannel[] = [];

function makeMockChannel(): MockChannel {
  const channel: MockChannel = {
    _broadcastHandler: null,
    on(_type, _filter, handler) {
      channel._broadcastHandler = handler;
      return channel;
    },
    subscribe() {
      return channel;
    },
  };
  return channel;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
    channel: () => {
      const channel = makeMockChannel();
      channels.push(channel);
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));

import { CoachLiveView, type CoachLiveViewProps } from "./coach-live-view";

function latestChannel(): MockChannel {
  const channel = channels[channels.length - 1];
  if (!channel) throw new Error("No channel created yet");
  return channel;
}

function broadcast(payload: unknown) {
  act(() => latestChannel()._broadcastHandler?.({ payload }));
}

const sampleContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "Job relocation",
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

function baseProps(overrides: Partial<CoachLiveViewProps> = {}): CoachLiveViewProps {
  return {
    callId: "call-1",
    propertyId: "lead-1",
    sellerPhoneE164: "+18165559876",
    repPhoneE164: "+18165551234",
    callName: "Jane Homeowner",
    callStatus: "live",
    seconds: 12,
    muted: false,
    held: false,
    holdPending: false,
    onDigit: vi.fn(),
    onMute: vi.fn(),
    onHold: vi.fn(),
    onHangup: vi.fn(),
    onCollapse: vi.fn(),
    ...overrides,
  };
}

describe("<CoachLiveView />", () => {
  beforeEach(() => {
    channels = [];
    loadCoachCallContext.mockReset().mockResolvedValue(sampleContext);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the script and phase rail once context resolves", async () => {
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("phase-rail-introduction")).toBeInTheDocument();
    expect(screen.getAllByText(/Alex Rep/).length).toBeGreaterThan(0);
  });

  it("shows Ringing… (not a 00:00 timer) and a pre-connect pill while the call is still ringing", async () => {
    render(<CoachLiveView {...baseProps({ callStatus: "ringing", seconds: 0 })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Ringing…");
    expect(screen.getByTestId("call-status-pill")).toHaveTextContent("Ringing…");
  });

  it("shows Connecting… while the call is connecting", async () => {
    render(<CoachLiveView {...baseProps({ callStatus: "connecting", seconds: 0 })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Connecting…");
  });

  it("shows the running mm:ss timer once live", async () => {
    render(<CoachLiveView {...baseProps({ callStatus: "live", seconds: 65 })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("01:05");
  });

  it("calls onCollapse on Escape", async () => {
    const onCollapse = vi.fn();
    render(<CoachLiveView {...baseProps({ onCollapse })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.keyboard("{Escape}");
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("calls onCollapse from the collapse button", async () => {
    const onCollapse = vi.fn();
    render(<CoachLiveView {...baseProps({ onCollapse })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-collapse"));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("reacts to a phase event by advancing the rail", async () => {
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "phase", phaseId: "reveal", ts: "t1" });
    expect(screen.getByTestId("phase-rail-reveal")).toHaveAttribute("aria-current", "step");
  });

  it("shows a static, all-placeholder script and never an infinite spinner when context load fails", async () => {
    loadCoachCallContext.mockReset().mockRejectedValue(new Error("network"));
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-context-error")).toBeInTheDocument());
    expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("token-placeholder").length).toBeGreaterThan(0);
  });

  it("retries context loading from the error banner", async () => {
    loadCoachCallContext.mockReset().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(sampleContext);
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-context-error")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-context-retry"));
    await waitFor(() => expect(screen.queryByTestId("coach-context-error")).not.toBeInTheDocument());
    expect(loadCoachCallContext).toHaveBeenCalledTimes(2);
  });

  it("lets the rep fill an entry-token chip (e.g. offer price) inline", async () => {
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "phase", phaseId: "offer", ts: "t1" });
    const chip = screen.getAllByTestId("entry-chip-offer_price")[0];
    expect(chip).toHaveTextContent("offer price");
    await userEvent.click(chip);
    const input = screen.getByTestId("entry-input-offer_price");
    await userEvent.type(input, "$210,000");
    await userEvent.tab();
    expect(screen.getAllByTestId("entry-chip-offer_price")[0]).toHaveTextContent("$210,000");
  });

  it("lets the rep manually switch a branch's variant", async () => {
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    const fsboTab = screen.getByTestId("variant-Opener-fsbo");
    await userEvent.click(fsboTab);
    expect(fsboTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText(/For Sale by Owner/).length).toBeGreaterThan(0);
  });

  it("keeps every objection card's dismiss timer independent — a second card doesn't reset the first's", async () => {
    vi.useFakeTimers();
    render(<CoachLiveView {...baseProps()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t1" });
    expect(screen.getAllByTestId("objection-card")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    broadcast({ type: "objection", objectionId: "not_in_rush", ts: "t2" });
    expect(screen.getAllByTestId("objection-card")).toHaveLength(2);

    // 5s later: 45s have elapsed for card 1 (40s + 5s) — it should have
    // auto-dismissed. Only 5s have elapsed for card 2 — it must remain,
    // proving card 2 arriving didn't reset or clear card 1's own timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getAllByTestId("objection-card")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(screen.queryAllByTestId("objection-card")).toHaveLength(0);
  });

  it("dismisses an objection card on tap", async () => {
    render(<CoachLiveView {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t1" });
    const card = screen.getByTestId("objection-card");
    await userEvent.click(card);
    expect(screen.queryByTestId("objection-card")).not.toBeInTheDocument();
  });
});
