import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCoachSession } from "@/lib/coach/use-coach-session";
import type { CoachCallContext } from "@/lib/coach/types";

type BroadcastHandler = (message: { payload: unknown }) => void;
type SubscribeCallback = (status: string) => void;

type MockChannel = {
  on: (type: string, filter: unknown, handler: BroadcastHandler) => MockChannel;
  subscribe: (cb: SubscribeCallback) => MockChannel;
  _broadcastHandler: BroadcastHandler | null;
  _subscribeCallback: SubscribeCallback | null;
};

const { loadCoachCallContext } = vi.hoisted(() => ({ loadCoachCallContext: vi.fn() }));

vi.mock("@/lib/coach/coach-context-actions", () => ({ loadCoachCallContext }));

let channels: MockChannel[] = [];

function makeMockChannel(): MockChannel {
  const channel: MockChannel = {
    _broadcastHandler: null,
    _subscribeCallback: null,
    on(_type, _filter, handler) {
      channel._broadcastHandler = handler;
      return channel;
    },
    subscribe(cb) {
      channel._subscribeCallback = cb;
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

/** Every wire event carries both content versions, always — required. Tests
 * that care about a specific version value pass it explicitly and it wins
 * over this default. */
const DEFAULT_VERSIONS = { scriptVersion: "1.0.1", matcherVersion: "3" };

function broadcast(payload: Record<string, unknown>) {
  act(() => latestChannel()._broadcastHandler?.({ payload: { ...DEFAULT_VERSIONS, ...payload } }));
}

const sampleContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: null,
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: null,
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

type HarnessProps = Omit<CoachLiveViewProps, "session"> & {
  callId?: string;
  propertyId?: string | null;
  sellerPhoneE164?: string | null;
  repPhoneE164?: string | null;
};

/** Mirrors how softphone-provider actually wires this up: the session is
 * owned outside CoachLiveView (via useCoachSession) and passed in as a
 * prop, so it survives the view unmounting on collapse. */
function Harness({ callId = "call-1", propertyId = "lead-1", sellerPhoneE164 = "+18165559876", repPhoneE164 = "+18165551234", ...rest }: HarnessProps) {
  const session = useCoachSession(callId, propertyId, sellerPhoneE164, repPhoneE164);
  return <CoachLiveView session={session} {...rest} />;
}

function baseProps(overrides: Partial<HarnessProps> = {}): HarnessProps {
  return {
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
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("phase-rail-introduction")).toBeInTheDocument();
    expect(screen.getAllByText(/Alex Rep/).length).toBeGreaterThan(0);
  });

  it("shows Ringing… (not a 00:00 timer) and a pre-connect pill while the call is still ringing", async () => {
    render(<Harness {...baseProps({ callStatus: "ringing", seconds: 0 })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Ringing…");
    expect(screen.getByTestId("call-status-pill")).toHaveTextContent("Ringing…");
  });

  it("shows Connecting… while the call is connecting", async () => {
    render(<Harness {...baseProps({ callStatus: "connecting", seconds: 0 })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Connecting…");
  });

  it("shows the running mm:ss timer once live", async () => {
    render(<Harness {...baseProps({ callStatus: "live", seconds: 65 })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("01:05");
  });

  it("disables Hold whenever the call isn't actually live yet (connecting/ringing)", async () => {
    render(<Harness {...baseProps({ callStatus: "connecting" })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-hold")).toBeDisabled();
  });

  it("enables Hold once the call is live", async () => {
    render(<Harness {...baseProps({ callStatus: "live" })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.getByTestId("coach-hold")).toBeEnabled();
  });

  it("calls onCollapse on Escape", async () => {
    const onCollapse = vi.fn();
    render(<Harness {...baseProps({ onCollapse })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.keyboard("{Escape}");
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("calls onCollapse from the collapse button", async () => {
    const onCollapse = vi.fn();
    render(<Harness {...baseProps({ onCollapse })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-collapse"));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("reacts to a phase event by advancing the rail", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "phase", phaseId: "reveal", ts: "t1" });
    expect(screen.getByTestId("phase-rail-reveal")).toHaveAttribute("aria-current", "step");
  });

  it("shows a static, all-placeholder script and never an infinite spinner when context load fails", async () => {
    loadCoachCallContext.mockReset().mockRejectedValue(new Error("network"));
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-context-error")).toBeInTheDocument());
    expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("token-placeholder").length).toBeGreaterThan(0);
  });

  it("retries context loading from the error banner", async () => {
    loadCoachCallContext.mockReset().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(sampleContext);
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-context-error")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-context-retry"));
    await waitFor(() => expect(screen.queryByTestId("coach-context-error")).not.toBeInTheDocument());
    expect(loadCoachCallContext).toHaveBeenCalledTimes(2);
  });

  it("lets the rep fill an entry-token chip (e.g. offer price) inline", async () => {
    render(<Harness {...baseProps()} />);
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
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    const fsboTab = screen.getByTestId("variant-Opener-fsbo");
    await userEvent.click(fsboTab);
    expect(fsboTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText(/For Sale by Owner/).length).toBeGreaterThan(0);
    // Restructured opener variants still lead with the shared greeting.
    expect(screen.getAllByText(/Alex Rep/).length).toBeGreaterThan(0);
  });

  it("shows the reconnect-gap banner after a real reconnect, and dismiss clears it", async () => {
    const { REALTIME_SUBSCRIBE_STATES } = await import("@supabase/supabase-js");
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("coach-reconnect-gap")).not.toBeInTheDocument();

    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(screen.queryByTestId("coach-reconnect-gap")).not.toBeInTheDocument(); // first subscribe isn't a reconnect

    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR));
    act(() => latestChannel()._subscribeCallback?.(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED));
    expect(screen.getByTestId("coach-reconnect-gap")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("dismiss-reconnect-gap"));
    expect(screen.queryByTestId("coach-reconnect-gap")).not.toBeInTheDocument();
  });

  it("keeps every objection card's dismiss timer independent — a second card doesn't reset the first's", async () => {
    vi.useFakeTimers();
    render(<Harness {...baseProps()} />);
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
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t1" });
    const card = screen.getByTestId("objection-card");
    await userEvent.click(card);
    expect(screen.queryByTestId("objection-card")).not.toBeInTheDocument();
  });

  it("resolves tokens in objection card text — no raw {seller_name} braces on screen", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "objection", objectionId: "end_buyer", ts: "t1" });
    const card = screen.getByTestId("objection-card");
    expect(card).toHaveTextContent("Jane, that's a fantastic question");
    expect(card).not.toHaveTextContent("{seller_name}");
  });

  it("auto-selects the not_in_rush objection's owner_occupied overcome track from context occupancy", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "objection", objectionId: "not_in_rush", ts: "t1" });
    const card = screen.getByTestId("objection-card");
    expect(card).toHaveTextContent("where do you plan on going next");
  });

  it("renders the zillow_worth objection's live-math template guidance", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "objection", objectionId: "zillow_worth", ts: "t1" });
    const card = screen.getByTestId("objection-card");
    expect(card).toHaveTextContent(/live worked example/i);
  });

  it("renders a coach_note as a nudge card and never counts it as a dropped/unknown event", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "coach_note", text: "Say their name twice in the first line.", phaseId: "introduction", ts: "t1" });
    expect(screen.getByTestId("coach-nudge")).toHaveTextContent("Say their name twice in the first line.");
  });

  it("dismisses a nudge on tap, independent of any objection cards showing", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "coach_note", text: "Pain word — go deeper.", phaseId: "reveal", ts: "t1" });
    const nudge = screen.getByTestId("coach-nudge");
    await userEvent.click(nudge);
    expect(screen.queryByTestId("coach-nudge")).not.toBeInTheDocument();
  });

  it("keeps every nudge's dismiss timer independent, same as objection cards", async () => {
    vi.useFakeTimers();
    render(<Harness {...baseProps()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    broadcast({ type: "coach_note", text: "First nudge.", phaseId: "introduction", ts: "t1" });
    expect(screen.getAllByTestId("coach-nudge")).toHaveLength(1);

    // 15s in, first nudge has 5s left on its 20s TTL.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    broadcast({ type: "coach_note", text: "Second nudge.", phaseId: "introduction", ts: "t2" });
    expect(screen.getAllByTestId("coach-nudge")).toHaveLength(2);

    // 6s later: 21s elapsed for the first nudge — it should have
    // auto-dismissed. Only 6s elapsed for the second — it must remain,
    // proving the second nudge arriving didn't reset the first's timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.getAllByTestId("coach-nudge")).toHaveLength(1);
    expect(screen.getByTestId("coach-nudge")).toHaveTextContent("Second nudge.");
  });

  it("shows the 'coach out of sync' banner when an event reports a different script version, and clears it once versions match again", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("coach-version-mismatch")).not.toBeInTheDocument();

    broadcast({ type: "counter", probeCount: 1, ts: "t1", scriptVersion: "0.9.0" });
    expect(screen.getByTestId("coach-version-mismatch")).toHaveTextContent("0.9.0");

    broadcast({ type: "counter", probeCount: 2, ts: "t2", scriptVersion: "1.0.1" });
    expect(screen.queryByTestId("coach-version-mismatch")).not.toBeInTheDocument();
  });
});
