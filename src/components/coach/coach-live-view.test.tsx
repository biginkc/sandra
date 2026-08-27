import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_NUDGES, MAX_OBJECTION_CARDS } from "@/lib/coach/event-reducer";
import { CLOSR_SCRIPT } from "@/lib/coach/script-block";
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
const DEFAULT_VERSIONS = { scriptVersion: CLOSR_SCRIPT.version, matcherVersion: "3" };

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
  yearBuilt: null,
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

/** Same wiring as Harness, but with the session-owning component kept
 * mounted while CoachLiveView itself is conditionally rendered — mirrors
 * softphone-provider.tsx exactly (coachSession lives in the provider;
 * coachCollapsed only toggles whether CoachLiveView is portaled). Lets a
 * test simulate a real collapse/reopen cycle (CoachLiveView unmounts and
 * remounts) without destroying the session state that must survive it. */
function CollapsibleHarness({
  collapsed,
  callId = "call-1",
  propertyId = "lead-1",
  sellerPhoneE164 = "+18165559876",
  repPhoneE164 = "+18165551234",
  ...rest
}: HarnessProps & { collapsed: boolean }) {
  const session = useCoachSession(callId, propertyId, sellerPhoneE164, repPhoneE164);
  if (collapsed) return null;
  return <CoachLiveView session={session} {...rest} />;
}

function DialogLifecycleHarness() {
  const [open, setOpen] = useState(false);
  const session = useCoachSession("call-1", "lead-1", "+18165559876", "+18165551234");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open live coach</button>
      {open ? (
        <CoachLiveView
          session={session}
          {...baseProps({ onCollapse: () => setOpen(false) })}
        />
      ) : null}
    </>
  );
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
    expect(screen.getByTestId("say-this-card")).toBeVisible();
    expect(screen.getByTestId("next-phase-preview")).toHaveTextContent(/Coming next · Reveal/i);
    expect(screen.getAllByText(/Alex Rep/).length).toBeGreaterThan(0);
  });

  it("keeps the full two-speaker transcript surface and interim/final semantics beside focus mode", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());

    broadcast({ type: "transcript", speaker: "seller", text: "The yard is getting expensive.", isFinal: true, ts: "t1" });
    broadcast({ type: "transcript", speaker: "rep", text: "Who has been maintaining it?", isFinal: false, ts: "t2" });

    const transcript = screen.getByTestId("coach-transcript");
    expect(transcript.closest("aside")).toHaveAttribute("aria-label", "Live transcript");
    expect(transcript).toHaveTextContent("Seller");
    expect(transcript).toHaveTextContent("The yard is getting expensive.");
    expect(transcript).toHaveTextContent("Rep");
    expect(transcript).toHaveTextContent("Who has been maintaining it?");
    expect(screen.getAllByTestId("transcript-line").map((line) => line.getAttribute("data-final"))).toEqual(["true", "false"]);
  });

  it("keeps one authored branch dominant while retaining the rest of the phase in an on-demand full-script disclosure", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());

    const disclosure = screen.getByTestId("full-phase-script");
    expect(disclosure).not.toHaveAttribute("open");
    expect(disclosure).toHaveTextContent("Frame the call");
    expect(disclosure).toHaveTextContent("Pen & paper — contact details");

    await userEvent.click(screen.getByText(/Full Introduction script/i));
    expect(disclosure).toHaveAttribute("open");
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
    expect(screen.getByTestId("coach-live-pill")).toHaveTextContent(/Live/i);
    expect(screen.queryByTestId("call-status-pill")).not.toBeInTheDocument();
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

  it("uses the shared modal primitive to enter and contain keyboard focus, and closes on Escape", async () => {
    // Focus-RESTORATION is intentionally NOT asserted here. This harness's
    // own "Open live coach" button stays mounted for the harness's whole
    // lifetime — the exact "kept-alive button" shape production doesn't
    // have (the real launch control unmounts along with the rest of the
    // dialer popover once the coach view takes over). The dialog's
    // finalFocus now targets the always-mounted header dialer button
    // instead of whatever triggered the open, so a real-mount-lifecycle
    // restoration test belongs in softphone-provider.test.tsx, against the
    // actual SoftphoneProvider/SoftphoneHeaderButton wiring, not here.
    const user = userEvent.setup();
    render(<DialogLifecycleHarness />);
    const trigger = screen.getByRole("button", { name: "Open live coach" });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Live call coach" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(dialog).toHaveAttribute("data-slot", "dialog-content");

    for (let index = 0; index < 8; index += 1) await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Live call coach" })).not.toBeInTheDocument());
  });

  it("calls onCollapse from the collapse button", async () => {
    const onCollapse = vi.fn();
    render(<Harness {...baseProps({ onCollapse })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-collapse"));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("dials DTMF via the keyboard once the keypad is open during a live call — parity with the classic popover", async () => {
    const onDigit = vi.fn();
    render(<Harness {...baseProps({ onDigit, callStatus: "live" })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-keypad-toggle"));

    await userEvent.keyboard("5*#");

    expect(onDigit).toHaveBeenNthCalledWith(1, "5");
    expect(onDigit).toHaveBeenNthCalledWith(2, "*");
    expect(onDigit).toHaveBeenNthCalledWith(3, "#");
  });

  it("ignores keyboard digits while the keypad is closed", async () => {
    const onDigit = vi.fn();
    render(<Harness {...baseProps({ onDigit, callStatus: "live" })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());

    await userEvent.keyboard("5");

    expect(onDigit).not.toHaveBeenCalled();
  });

  it("never dials DTMF from keystrokes typed into the entry-token editor, even with the keypad open", async () => {
    // The popover never needed this guard — it has no free-text fields.
    // This dialog's EntryTokenChip does, so typing an offer price like
    // "210000" must land in the field, not also dial touch-tones into the
    // live call.
    const onDigit = vi.fn();
    render(<Harness {...baseProps({ onDigit, callStatus: "live" })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("coach-keypad-toggle"));
    broadcast({ type: "phase", phaseId: "offer", ts: "t1" });
    await userEvent.click(screen.getAllByTestId("entry-chip-offer_price")[0]);
    const input = screen.getByTestId("entry-input-offer_price");

    await userEvent.type(input, "210000");

    expect(onDigit).not.toHaveBeenCalled();
    expect(input).toHaveValue("210000");
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

  it("keeps editor Escape local instead of collapsing the entire coach dialog", async () => {
    const onCollapse = vi.fn();
    render(<Harness {...baseProps({ onCollapse })} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    broadcast({ type: "phase", phaseId: "offer", ts: "t1" });
    await userEvent.click(screen.getAllByTestId("entry-chip-offer_price")[0]);
    const input = screen.getByTestId("entry-input-offer_price");

    await userEvent.type(input, "{Escape}");

    expect(screen.queryByTestId("entry-input-offer_price")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Live call coach" })).toBeInTheDocument();
    expect(onCollapse).not.toHaveBeenCalled();
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

  it("an objection card dismisses at its ORIGINAL deadline even after a collapse/reopen — remounting must not restart its 45s clock", async () => {
    // The bug this guards: before absolute expiresAt, each card's dismiss
    // timer was scheduled for a fixed 45s from MOUNT. A collapse/reopen
    // unmounts and remounts every card (CoachLiveView itself unmounts on
    // collapse), so a fixed-TTL-per-mount card would silently get a fresh
    // 45s on every reopen — staying on screen indefinitely across enough
    // collapse/reopen cycles. None of the OTHER TTL tests in this file
    // would catch that regression, since none of them ever unmount
    // CoachLiveView mid-countdown.
    vi.useFakeTimers();
    const { rerender } = render(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t1" });
    expect(screen.getAllByTestId("objection-card")).toHaveLength(1);

    // 30s into the 45s TTL: collapse (unmount CoachLiveView, session
    // persists via CollapsibleHarness staying mounted), wait 10s while
    // collapsed, then reopen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    rerender(<CollapsibleHarness {...baseProps()} collapsed={true} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    rerender(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 40s total have elapsed (30s + 10s) — 5s remain on the ORIGINAL
    // deadline. The card must still be there (proves it wasn't dismissed
    // early) but dismiss on the next 5s, not 45s from this reopen.
    expect(screen.getAllByTestId("objection-card")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
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

  it("keeps an empty live region mounted before announcing useful nudge and objection guidance", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    const announcer = screen.getByTestId("coach-guidance-announcer");
    expect(announcer).toBeEmptyDOMElement();

    broadcast({ type: "coach_note", text: "Slow down and mirror the seller.", phaseId: "introduction", ts: "t1" });
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t2" });

    // role="alert" carries an implicit aria-live="assertive" — distinct
    // from the softphone toast's role="status" so the two never collide
    // under the same accessible-role query.
    expect(announcer).toHaveAttribute("role", "alert");
    expect(announcer).toHaveTextContent("Slow down and mirror the seller.");
    expect(announcer).toHaveTextContent("Acknowledge: *Sighhh* Yeah…");
    expect(announcer).toHaveTextContent("Overcome: What were you hoping I was AT LEAST going to say?");
    expect(announcer).not.toHaveTextContent("price_too_low");
  });

  it("uses one focus surface: objection preempts nudge, then dismissals restore nudge and script in order", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    window.dispatchEvent(new Event("resize"));
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());

    broadcast({ type: "coach_note", text: "Ask one more question.", phaseId: "reveal", ts: "t1" });
    expect(screen.getByTestId("coach-nudge")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("coach-script-panel")).toHaveAttribute("hidden");

    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t2" });
    const stack = screen.getByTestId("coach-guidance-stack");
    expect(stack).toContainElement(screen.getByTestId("coach-nudge"));
    expect(stack).toContainElement(screen.getByTestId("objection-card"));
    expect(stack.className).toMatch(/overflow-y-auto/);
    expect(stack.className).not.toMatch(/\babsolute\b|\bfixed\b/);
    expect(screen.getByTestId("objection-card")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("coach-nudge")).toHaveAttribute("data-active", "false");

    await userEvent.click(screen.getByTestId("objection-card"));
    expect(screen.queryByTestId("objection-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("coach-nudge")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("coach-script-panel")).toHaveAttribute("hidden");

    await userEvent.click(screen.getByTestId("coach-nudge"));
    expect(screen.queryByTestId("coach-guidance-stack")).not.toBeInTheDocument();
    expect(screen.getByTestId("coach-script-panel")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("say-this-card")).toBeVisible();
  });

  it("keeps hidden queued guidance mounted so its absolute expiry still runs before focus returns to it", async () => {
    vi.useFakeTimers();
    render(<Harness {...baseProps()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    broadcast({ type: "coach_note", text: "This nudge must expire while hidden.", phaseId: "reveal", ts: "t1" });
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "t2" });
    expect(screen.getByTestId("coach-nudge")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("objection-card")).toHaveAttribute("data-active", "true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.queryByTestId("coach-nudge")).not.toBeInTheDocument();

    act(() => screen.getByTestId("objection-card").click());
    expect(screen.queryByTestId("coach-guidance-stack")).not.toBeInTheDocument();
    expect(screen.getByTestId("coach-script-panel")).not.toHaveAttribute("hidden");
  });

  it("never renders more than the capped number of cards/nudges, even during a rapid-fire burst — the stack's scroll is a backstop, not the only guard", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());

    const objectionIds = ["price_too_low", "not_in_rush", "end_buyer", "zillow_worth", "list_with_realtor"];
    for (const [index, objectionId] of objectionIds.entries()) {
      broadcast({ type: "objection", objectionId, ts: `obj-${index}` });
    }
    const nudgeTexts = ["A", "B", "C", "D", "E"];
    for (const [index, text] of nudgeTexts.entries()) {
      broadcast({ type: "coach_note", text, phaseId: "introduction", ts: `nudge-${index}` });
    }

    expect(objectionIds.length).toBeGreaterThan(MAX_OBJECTION_CARDS);
    expect(nudgeTexts.length).toBeGreaterThan(MAX_NUDGES);
    expect(screen.getAllByTestId("objection-card")).toHaveLength(MAX_OBJECTION_CARDS);
    expect(screen.getAllByTestId("coach-nudge")).toHaveLength(MAX_NUDGES);
  });

  it("keeps every call action, including Hang up, in the 375px responsive control grid", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    window.dispatchEvent(new Event("resize"));
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());

    const controls = screen.getByTestId("coach-call-controls");
    expect(controls.className).toMatch(/grid-cols-2/);
    expect(controls).toContainElement(screen.getByTestId("coach-mute"));
    expect(controls).toContainElement(screen.getByTestId("coach-keypad-toggle"));
    expect(controls).toContainElement(screen.getByTestId("coach-hold"));
    expect(controls).toContainElement(screen.getByTestId("coach-hangup"));
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

  it("a nudge dismisses at its ORIGINAL deadline even after a collapse/reopen — remounting must not restart its 20s clock", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    broadcast({ type: "coach_note", text: "Say their name twice.", phaseId: "introduction", ts: "t1" });
    expect(screen.getAllByTestId("coach-nudge")).toHaveLength(1);

    // 12s into the 20s TTL: collapse, wait 5s while collapsed, reopen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    rerender(<CollapsibleHarness {...baseProps()} collapsed={true} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    rerender(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // 17s total elapsed — 3s remain on the ORIGINAL deadline.
    expect(screen.getAllByTestId("coach-nudge")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.queryAllByTestId("coach-nudge")).toHaveLength(0);
  });

  it("shows the 'coach out of sync' banner when an event reports a different script version, and clears it once versions match again", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("coach-script-panel")).toBeInTheDocument());
    expect(screen.queryByTestId("coach-version-mismatch")).not.toBeInTheDocument();

    broadcast({ type: "counter", probeCount: 1, ts: "t1", scriptVersion: "0.9.0" });
    expect(screen.getByTestId("coach-version-mismatch")).toHaveTextContent("0.9.0");

    broadcast({ type: "counter", probeCount: 2, ts: "t2", scriptVersion: CLOSR_SCRIPT.version });
    expect(screen.queryByTestId("coach-version-mismatch")).not.toBeInTheDocument();
  });
});
