import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLOSR_SCRIPT } from "@/lib/coach/script-block";
import type {
  CoachRecommendationRequest,
  CoachRecommendationRequestFn,
  CoachRecommendationResult,
} from "@/lib/coach/recommendation-types";
import type { CoachCallContext } from "@/lib/coach/types";
import { useCoachSession, type PreparedCoachTarget } from "@/lib/coach/use-coach-session";

import { CoachLiveView, selectSpokenLine, type CoachLiveViewProps } from "./coach-live-view";

type BroadcastHandler = (message: { payload: unknown }) => void;
type SubscribeCallback = (status: string) => void;

type MockChannel = {
  on: (type: string, filter: unknown, handler: BroadcastHandler) => MockChannel;
  subscribe: (callback: SubscribeCallback) => MockChannel;
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
    subscribe(callback) {
      channel._subscribeCallback = callback;
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

const sampleContext: CoachCallContext = {
  sellerName: "Jane Homeowner",
  propertyAddress: "123 Main St",
  propertyCounty: "Jackson",
  repName: "Alex Rep",
  authenticatedRepName: "Alex Rep",
  repPhoneE164: "+18165551234",
  motivation: "move closer to family",
  leadId: "lead-1",
  sellerPhoneE164: "+18165559876",
  coldCallerName: "Taylor",
  yearBuilt: "1987",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};

type HarnessProps = Omit<CoachLiveViewProps, "session"> & {
  callId?: string;
  preparedTarget?: PreparedCoachTarget;
};

function Harness({ callId = "call-1", preparedTarget, ...props }: HarnessProps) {
  const session = useCoachSession(callId, "unauthorized-abcdef", "+18165559876", "+18165551234", true, preparedTarget);
  return <CoachLiveView session={session} {...props} />;
}

function CollapsibleHarness({ collapsed, ...props }: HarnessProps & { collapsed: boolean }) {
  const session = useCoachSession("call-1", "lead-1", "+18165559876", "+18165551234");
  if (collapsed) return null;
  return <CoachLiveView session={session} {...props} />;
}

function DialogLifecycleHarness() {
  const [open, setOpen] = useState(true);
  const session = useCoachSession("call-1", "lead-1", "+18165559876", "+18165551234");
  return (
    <>
      <button type="button" data-testid="header-dialer-button">Dialer</button>
      <button type="button" onClick={() => setOpen(true)}>Open live coach</button>
      {open ? <CoachLiveView session={session} {...baseProps({ onCollapse: () => setOpen(false) })} /> : null}
    </>
  );
}

// Builds a mode-aware recommendationRequest mock: follow_up gets the given
// canned questions, objection_help gets the given classification (defaults
// to a truthful no-match so a test that never overrides this doesn't
// accidentally assert on a fabricated objection).
function stubRecommendationRequest(
  followUpQuestions: string[],
  objection: { objectionId: string | null; evidenceQuote: string | null } = { objectionId: null, evidenceQuote: null },
) {
  return vi.fn(async (input: CoachRecommendationRequest): Promise<CoachRecommendationResult> => (
    input.mode === "objection_help"
      ? {
          ok: true,
          requestId: input.requestId,
          callId: input.callId,
          activeSectionId: input.activeSectionId,
          mode: "objection_help",
          objectionId: objection.objectionId,
          evidenceQuote: objection.evidenceQuote,
        }
      : {
          ok: true,
          requestId: input.requestId,
          callId: input.callId,
          activeSectionId: input.activeSectionId,
          mode: "follow_up",
          followUpQuestions,
        }
  ));
}

function baseProps(overrides: Partial<HarnessProps> = {}): HarnessProps {
  const recommendationRequest: CoachRecommendationRequestFn = stubRecommendationRequest([
    "What repairs concern you most?", "How long has that been a problem?", "What happens if nothing changes?",
  ]);
  return {
    callName: "Jane Homeowner",
    callStatus: "live",
    seconds: 83,
    muted: false,
    held: false,
    holdPending: false,
    onDigit: vi.fn(),
    onMute: vi.fn(),
    onHold: vi.fn(),
    onHangup: vi.fn(),
    onCollapse: vi.fn(),
    recommendationRequest,
    ...overrides,
  };
}

function latestChannel(): MockChannel {
  const channel = channels.at(-1);
  if (!channel) throw new Error("No coach channel");
  return channel;
}

function broadcast(payload: Record<string, unknown>) {
  act(() => {
    latestChannel()._broadcastHandler?.({
      payload: {
        scriptVersion: CLOSR_SCRIPT.version,
        matcherVersion: "3",
        ...payload,
      },
    });
  });
}

describe("<CoachLiveView /> manual navigation", () => {
  beforeEach(() => {
    channels = [];
    loadCoachCallContext.mockReset().mockResolvedValue(sampleContext);
  });

  it("shows the full first section, boundary state, transcript, and next-section preview", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    expect(screen.getByTestId("coach-back")).toBeDisabled();
    expect(screen.getByTestId("coach-next")).toBeEnabled();
    expect(screen.getByTestId("next-section-preview")).toHaveTextContent("Set the qualification frame");
    expect(screen.getByTestId("current-section-script")).toHaveTextContent("Alex Rep");
    expect(screen.getByTestId("current-section-script")).toHaveTextContent("spoke to one of my assistants Taylor");
    expect(screen.queryByTestId("entry-chip-motivation")).not.toBeInTheDocument();
    expect(screen.queryByTestId("entry-chip-cold_caller_name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Live transcript")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("follow-up-questions")).toBeDisabled();
  });

  it("keeps file-number identity placeholder-only while loading, then shows the authorized context value", async () => {
    let resolveContext!: (context: CoachCallContext) => void;
    loadCoachCallContext.mockReturnValue(new Promise((resolve) => { resolveContext = resolve; }));
    const user = userEvent.setup();
    render(<Harness {...baseProps()} preparedTarget={{
      repName: "Jarrad Henry",
      sellerName: "Prepared Homeowner",
      propertyAddress: "55 Oak Ave",
      sellerPhoneE164: "+18165559876",
      maskedSellerPhone: "+1 (816) 555-9876",
    }} />);

    expect(screen.getByTestId("coach-file-number")).toHaveTextContent("File number: —");

    for (let step = 0; step < 5; step += 1) await user.click(screen.getByTestId("coach-next"));
    const script = screen.getByTestId("current-section-script");
    expect(script).not.toHaveTextContent("JH-abcdef");
    expect(script).toHaveTextContent("—");

    act(() => resolveContext({
      ...sampleContext,
      repName: "Jarrad Henry",
      authenticatedRepName: "Jarrad Henry",
      leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
    }));
    await waitFor(() => expect(screen.getByTestId("coach-file-number")).toHaveTextContent("File number: JH-c1c524"));
    expect(script).toHaveTextContent("JH-c1c524");
  });

  it("keeps the authorized file number visible while the rep advances through the script", async () => {
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      repName: "Jarrad Henry",
      authenticatedRepName: "Jarrad Henry",
      leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
    });
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);

    const fileNumber = await screen.findByTestId("coach-file-number");
    await waitFor(() => expect(fileNumber).toHaveTextContent("File number: JH-c1c524"));
    for (let step = 0; step < 25; step += 1) {
      expect(fileNumber).toBeVisible();
      expect(fileNumber).toHaveTextContent("File number: JH-c1c524");
      await user.click(screen.getByTestId("coach-next"));
    }
    expect(fileNumber).toBeVisible();
    expect(fileNumber).toHaveTextContent("File number: JH-c1c524");
  });

  it("never exposes requested/prepared file-number identity after a property authorization failure", async () => {
    loadCoachCallContext.mockRejectedValue(new Error("permission denied for property"));
    const user = userEvent.setup();
    render(<Harness {...baseProps()} preparedTarget={{
      repName: "Jarrad Henry",
      sellerName: "Prepared Homeowner",
      propertyAddress: "55 Oak Ave",
      sellerPhoneE164: "+18165559876",
      maskedSellerPhone: "+1 (816) 555-9876",
    }} />);

    await waitFor(() => expect(screen.getByTestId("coach-context-error")).toBeVisible());
    expect(screen.getByTestId("coach-file-number")).toHaveTextContent("File number: —");
    for (let step = 0; step < 5; step += 1) await user.click(screen.getByTestId("coach-next"));
    const script = screen.getByTestId("current-section-script");
    expect(script).not.toHaveTextContent("JH-abcdef");
    expect(script).toHaveTextContent("—");
  });

  it("keeps the file number placeholder when the authorized property loads without an authenticated rep", async () => {
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      repName: null,
      authenticatedRepName: null,
      leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
    });
    const user = userEvent.setup();
    render(<Harness {...baseProps()} preparedTarget={{
      repName: "Jarrad Henry",
      sellerName: "Prepared Homeowner",
      propertyAddress: "55 Oak Ave",
      sellerPhoneE164: "+18165559876",
      maskedSellerPhone: "+1 (816) 555-9876",
    }} />);

    await waitFor(() => expect(loadCoachCallContext).toHaveBeenCalled());
    expect(screen.getByTestId("coach-file-number")).toHaveTextContent("File number: —");
    for (let step = 0; step < 5; step += 1) await user.click(screen.getByTestId("coach-next"));
    const script = screen.getByTestId("current-section-script");
    expect(script).not.toHaveTextContent("JH-c1c524");
    expect(script).toHaveTextContent("—");
  });

  it("keeps the coach visible and exposes manual audio recovery without ending the call", async () => {
    const user = userEvent.setup();
    const onReconnectAudio = vi.fn();
    const onHangup = vi.fn();
    render(<Harness {...baseProps({
      callStatus: "audio_reconnect_required",
      onReconnectAudio,
      onHangup,
    })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    expect(screen.getByTestId("coach-audio-reconnect-warning")).toHaveTextContent("Call live · audio interrupted");
    expect(screen.getByLabelText("Live transcript")).toBeVisible();
    expect(screen.getByTestId("current-section-script")).toBeVisible();
    expect(screen.getByTestId("coach-hangup")).toBeEnabled();
    expect(screen.getByTestId("coach-mute")).toBeDisabled();
    expect(screen.getByTestId("coach-warning-hangup")).toHaveTextContent("Hang Up");
    expect(onHangup).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("coach-reconnect-audio"));
    expect(onReconnectAudio).toHaveBeenCalledTimes(1);
    expect(onHangup).not.toHaveBeenCalled();
  });

  it("keeps recovery and hangup visible while reconnecting without hiding live guidance", async () => {
    const user = userEvent.setup();
    const onReconnectAudio = vi.fn();
    const onHangup = vi.fn();
    render(<Harness {...baseProps({
      callStatus: "audio_reconnecting",
      onReconnectAudio,
      onHangup,
    })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    expect(screen.getByTestId("coach-audio-reconnect-warning")).toHaveTextContent("Call live · reconnecting browser audio…");
    expect(screen.getByTestId("coach-reconnect-audio")).toBeVisible();
    expect(screen.getByTestId("coach-reconnect-audio")).toBeDisabled();
    expect(screen.getByTestId("coach-mute")).toBeDisabled();
    expect(screen.getByLabelText("Live transcript")).toBeVisible();
    expect(screen.getByTestId("current-section-script")).toBeVisible();

    await user.click(screen.getByTestId("coach-warning-hangup"));
    expect(onHangup).toHaveBeenCalledTimes(1);
    expect(onReconnectAudio).not.toHaveBeenCalled();
  });

  it("moves only when the rep uses Next, Back, or deliberate phase selection", async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    await user.click(screen.getByTestId("coach-next"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Set the qualification frame");
    expect(screen.getByTestId("coach-back")).toBeEnabled();

    await user.click(screen.getByTestId("coach-back"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call");

    await user.click(screen.getByTestId("phase-rail-reveal"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the seller situation");
    expect(screen.getByTestId("phase-rail-reveal")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("coach-current-phase")).toHaveTextContent("Phase · Reveal");
  });

  it("keeps section, preview, and rail inert when legacy phase and cursor events arrive", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));
    const preview = screen.getByTestId("next-section-preview").textContent;

    broadcast({ type: "phase", phaseId: "close", ts: "phase-1" });
    broadcast({
      type: "cursor",
      phaseId: "introduction",
      branchTag: "Frame the call",
      variantKey: "default",
      lineIndex: 3,
      lineText: "legacy cursor text",
      ts: "cursor-1",
    });

    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call");
    expect(screen.getByTestId("next-section-preview").textContent).toBe(preview);
    expect(screen.getByTestId("phase-rail-introduction")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("phase-rail-close")).not.toHaveAttribute("aria-current");
  });

  it("renders both speakers and preserves final versus interim transcript state", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toBeVisible());

    broadcast({ type: "transcript", speaker: "seller", text: "The roof", isFinal: true, ts: "seller-final-1" });
    broadcast({ type: "transcript", speaker: "seller", text: "needs work.", isFinal: true, ts: "seller-final-2" });
    broadcast({ type: "transcript", speaker: "rep", text: "Tell me more about", isFinal: false, ts: "rep-interim" });

    const lines = screen.getAllByTestId("transcript-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Seller");
    expect(lines[0]).toHaveTextContent("The roof needs work.");
    expect(lines[0]).toHaveAttribute("data-final", "true");
    expect(lines[1]).toHaveTextContent("Rep");
    expect(lines[1]).toHaveTextContent("Tell me more about");
    expect(lines[1]).toHaveAttribute("data-final", "false");
  });

  it("keeps finalized seller speech eligible and AI-visible through a same-speaker interim", async () => {
    const user = userEvent.setup();
    const recommendationRequest = stubRecommendationRequest(["What makes selling important now?"]);
    render(<Harness {...baseProps({ recommendationRequest })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toBeVisible());

    broadcast({ type: "transcript", speaker: "seller", text: "I need", isFinal: true, ts: "seller-final-1" });
    broadcast({ type: "transcript", speaker: "seller", text: "to sell", isFinal: false, ts: "seller-interim-2" });

    expect(screen.getByTestId("follow-up-questions")).toBeEnabled();
    let lines = screen.getAllByTestId("transcript-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("I need");
    expect(lines[0]).toHaveAttribute("data-final", "true");
    expect(lines[1]).toHaveTextContent("to sell");
    expect(lines[1]).toHaveAttribute("data-final", "false");

    await user.click(screen.getByTestId("follow-up-questions"));
    await waitFor(() => expect(recommendationRequest).toHaveBeenCalledTimes(1));
    expect(recommendationRequest.mock.calls[0][0].transcript).toEqual([
      expect.objectContaining({ speaker: "seller", text: "I need", isFinal: true }),
    ]);

    broadcast({ type: "transcript", speaker: "seller", text: "to sell", isFinal: true, ts: "seller-final-2" });
    lines = screen.getAllByTestId("transcript-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("I need to sell");
    expect(lines[0]).toHaveAttribute("data-final", "true");
  });

  it("enables follow-up questions only after a finalized homeowner turn and sends one grounded request per click", async () => {
    const user = userEvent.setup();
    const recommendationRequest = stubRecommendationRequest([
      "Which repair is weighing on you the most?",
      "How has that affected your moving timeline?",
      "What happens if the property stays as-is?",
    ]);
    render(<Harness {...baseProps({ recommendationRequest })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    broadcast({
      type: "transcript",
      speaker: "rep",
      text: "Tell me more about the condition.",
      isFinal: true,
      ts: "rep-final",
    });
    expect(screen.getByTestId("follow-up-questions")).toBeDisabled();

    broadcast({
      type: "transcript",
      speaker: "seller",
      text: "The roof and furnace repairs are becoming too expensive.",
      isFinal: true,
      ts: "seller-final",
    });
    expect(screen.getByTestId("follow-up-questions")).toBeEnabled();

    // A finalized seller turn only unlocks the action. It must not invoke the
    // recommendation contract until the rep deliberately clicks the button.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });
    expect(recommendationRequest).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("follow-up-questions"));

    await waitFor(() => expect(recommendationRequest).toHaveBeenCalledTimes(1));
    expect(recommendationRequest.mock.calls[0][0]).toMatchObject({
      callId: "call-1",
      activeSectionId: "introduction.opener",
      mode: "follow_up",
      transcript: [
        expect.objectContaining({ speaker: "rep", isFinal: true }),
        expect.objectContaining({ speaker: "seller", isFinal: true }),
      ],
    });
    expect(screen.getByTestId("follow-up-question-options").children).toHaveLength(3);
    expect(screen.getByText("Which repair is weighing on you the most?")).toBeVisible();
    expect(screen.getByText("How has that affected your moving timeline?")).toBeVisible();
    expect(screen.getByText("What happens if the property stays as-is?")).toBeVisible();
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call");
  });

  it("classifies through the same authenticated boundary as follow-up questions, renders the approved three-beat playbook by id, and leaves the call untouched", async () => {
    const user = userEvent.setup();
    const recommendationRequest = stubRecommendationRequest([], { objectionId: "talk_to_spouse", evidenceQuote: "talk to my spouse" });
    const onHangup = vi.fn();
    render(<Harness {...baseProps({ recommendationRequest, onHangup })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    expect(screen.getByTestId("objection-help")).toBeDisabled();
    broadcast({
      type: "transcript",
      speaker: "seller",
      text: "I need to talk to my spouse before deciding.",
      isFinal: true,
      ts: "seller-objection",
    });
    expect(screen.getByTestId("objection-help")).toBeEnabled();

    await user.click(screen.getByTestId("objection-help"));
    await waitFor(() => expect(recommendationRequest).toHaveBeenCalledTimes(1));
    expect(recommendationRequest.mock.calls[0][0]).toMatchObject({
      callId: "call-1",
      activeSectionId: "introduction.opener",
      mode: "objection_help",
      transcript: [expect.objectContaining({ speaker: "seller", isFinal: true })],
    });

    await waitFor(() => expect(screen.getByTestId("objection-help-label")).toHaveTextContent("Talk To Spouse"));
    expect(screen.getByTestId("objection-help-match")).toHaveTextContent("talk to my spouse");
    expect(screen.getByTestId("objection-help-acknowledge")).toHaveTextContent("Totally");
    expect(screen.getByTestId("objection-help-disarm")).toHaveTextContent("Jane");
    expect(screen.getByTestId("objection-help-overcome")).toHaveTextContent("what questions");
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call");
    expect(onHangup).not.toHaveBeenCalled();

    // A second click asks again (the result is advisory, not cached
    // forever) — it sends a second request and keeps the result visible.
    await user.click(screen.getByTestId("objection-help"));
    await waitFor(() => expect(recommendationRequest).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("objection-help-result")).toBeVisible();
  });

  it("reports no clear objection rather than guessing from rep or interim speech, and never lets the model write guidance", async () => {
    const user = userEvent.setup();
    // The catalog id the classifier returns is deliberately unrelated to
    // "realtor" — proving the truthful no-match rendering here is driven
    // by the server response (null), not by client-side keyword matching
    // that no longer exists in this file.
    const recommendationRequest = stubRecommendationRequest([], { objectionId: null, evidenceQuote: null });
    render(<Harness {...baseProps({ recommendationRequest })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    broadcast({ type: "transcript", speaker: "rep", text: "Are you a realtor?", isFinal: true, ts: "rep-line" });
    broadcast({ type: "transcript", speaker: "seller", text: "I might want a realtor.", isFinal: false, ts: "seller-interim" });
    broadcast({ type: "transcript", speaker: "seller", text: "The house has a new roof and fresh paint.", isFinal: true, ts: "seller-final" });
    await user.click(screen.getByTestId("objection-help"));

    await waitFor(() => expect(recommendationRequest).toHaveBeenCalledTimes(1));
    expect(recommendationRequest.mock.calls[0][0].mode).toBe("objection_help");
    await waitFor(() => expect(screen.getByTestId("objection-help-no-match")).toHaveTextContent("No clear objection"));
    expect(screen.queryByTestId("objection-help-result")).not.toBeInTheDocument();
  });

  it("shows a busy state while classifying and a retryable error message on provider failure", async () => {
    const user = userEvent.setup();
    let resolveRequest!: (value: CoachRecommendationResult) => void;
    const recommendationRequest = vi.fn((input: CoachRecommendationRequest): Promise<CoachRecommendationResult> =>
      new Promise((resolve) => { resolveRequest = resolve; }));
    render(<Harness {...baseProps({ recommendationRequest })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));
    broadcast({ type: "transcript", speaker: "seller", text: "I need to talk to my spouse before deciding.", isFinal: true, ts: "seller-objection" });

    await user.click(screen.getByTestId("objection-help"));
    expect(screen.getByTestId("objection-help")).toBeDisabled();
    expect(screen.getByTestId("objection-help")).toHaveTextContent("Finding the closest objection");
    // The two requests share one in-flight slot — Follow-up Questions must
    // be disabled too while Objection Help is still out.
    expect(screen.getByTestId("follow-up-questions")).toBeDisabled();

    resolveRequest({
      ok: false,
      requestId: recommendationRequest.mock.calls[0][0].requestId,
      callId: "call-1",
      activeSectionId: "introduction.opener",
      mode: "objection_help",
      code: "provider_error",
    });

    await waitFor(() => expect(screen.getByTestId("objection-help-error")).toHaveTextContent("temporarily unavailable"));
    expect(screen.getByTestId("objection-help")).toBeEnabled();
  });

  it("mutually disables Follow-up Questions and Objection Help while the other is in flight (both directions)", async () => {
    const user = userEvent.setup();
    let resolveObjection!: (value: CoachRecommendationResult) => void;
    let resolveFollowUp!: (value: CoachRecommendationResult) => void;
    const recommendationRequest = vi.fn((input: CoachRecommendationRequest): Promise<CoachRecommendationResult> =>
      new Promise((resolve) => {
        if (input.mode === "objection_help") resolveObjection = resolve;
        else resolveFollowUp = resolve;
      }));
    render(<Harness {...baseProps({ recommendationRequest })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));
    broadcast({ type: "transcript", speaker: "seller", text: "I need to talk to my spouse before deciding.", isFinal: true, ts: "seller-objection" });

    // Direction 1: Objection Help in flight -> Follow-up Questions disabled.
    await user.click(screen.getByTestId("objection-help"));
    expect(screen.getByTestId("objection-help")).toBeDisabled();
    expect(screen.getByTestId("follow-up-questions")).toBeDisabled();

    resolveObjection({
      ok: true,
      requestId: recommendationRequest.mock.calls[0][0].requestId,
      callId: "call-1",
      activeSectionId: "introduction.opener",
      mode: "objection_help",
      objectionId: null,
      evidenceQuote: null,
    });
    await waitFor(() => expect(screen.getByTestId("objection-help")).toBeEnabled());
    await waitFor(() => expect(screen.getByTestId("follow-up-questions")).toBeEnabled());

    // Direction 2: Follow-up Questions in flight -> Objection Help disabled.
    await user.click(screen.getByTestId("follow-up-questions"));
    expect(screen.getByTestId("follow-up-questions")).toBeDisabled();
    expect(screen.getByTestId("objection-help")).toBeDisabled();

    resolveFollowUp({
      ok: true,
      requestId: recommendationRequest.mock.calls[1][0].requestId,
      callId: "call-1",
      activeSectionId: "introduction.opener",
      mode: "follow_up",
      followUpQuestions: ["A?", "B?", "C?"],
    });
    await waitFor(() => expect(screen.getByTestId("follow-up-questions")).toBeEnabled());
    expect(screen.getByTestId("objection-help")).toBeEnabled();
  });

  it("parses legacy guidance events without rendering them or covering the script", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());

    broadcast({ type: "coach_note", text: "Legacy nudge", phaseId: "introduction", ts: "n1" });
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "o1" });
    broadcast({ type: "counter", probeCount: 6, ts: "c1" });
    broadcast({ type: "gate", gateId: "no_concerns", cleared: false, ts: "g1" });
    broadcast({ type: "timer", timerId: "hold", startedAt: "2026-08-27T20:00:00.000Z", durationS: 300, ts: "t1" });

    expect(screen.getByTestId("current-script-card")).toBeVisible();
    expect(screen.queryByTestId("coach-guidance-stack")).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("objection-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("probe-counter")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gate-no_concerns")).not.toBeInTheDocument();
  });

  it("keeps the exact manually selected section and transcript across collapse and reopen", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    await user.click(screen.getByTestId("coach-next"));
    await user.click(screen.getByTestId("coach-next"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Explain how BMH works");

    broadcast({
      type: "transcript",
      speaker: "seller",
      text: "We need to move before winter.",
      isFinal: true,
      ts: "transcript-1",
    });
    expect(screen.getByTestId("coach-transcript")).toHaveTextContent("We need to move before winter.");

    rerender(<CollapsibleHarness {...baseProps()} collapsed />);
    expect(screen.queryByTestId("coach-live-view")).not.toBeInTheDocument();
    rerender(<CollapsibleHarness {...baseProps()} collapsed={false} />);

    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Explain how BMH works");
    expect(screen.getByTestId("coach-transcript")).toHaveTextContent("We need to move before winter.");
    expect(channels).toHaveLength(1);
    expect(loadCoachCallContext).toHaveBeenCalledTimes(1);
  });

  it("keeps the active script visible during context failure and listener degradation", async () => {
    loadCoachCallContext.mockReset().mockRejectedValue(new Error("network"));
    render(<Harness {...baseProps()} />);

    await waitFor(() => expect(screen.getByTestId("coach-context-error")).toBeVisible());
    expect(screen.getByTestId("current-script-card")).toBeVisible();
    act(() => latestChannel()._subscribeCallback?.("CHANNEL_ERROR"));
    expect(screen.getByTestId("coach-degraded-note")).toHaveTextContent("your place is saved");
    expect(screen.getAllByTestId("token-placeholder").length).toBeGreaterThan(0);
  });

  it("keeps conditional variants inside the visible section", async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("variant-Opener-fsbo")).toBeVisible());

    expect(screen.getByTestId("variant-Opener-fsbo")).toHaveAccessibleName("Use FSBO spoken fork for Opener");
    await user.click(screen.getByTestId("variant-Opener-fsbo"));

    expect(screen.getByTestId("variant-Opener-fsbo")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("current-section-script")).toHaveTextContent("For Sale by Owner");
    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call");
  }, 10_000);

  it("shows exactly one rep-selected Offer or Close spoken path and preserves it across collapse", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toBeVisible());

    await user.click(screen.getByTestId("phase-rail-offer"));
    const offerPaths = [
      ["Good news", "CONGRATS"],
      ["Bad news", "right around where I was thinking"],
      ["Bad news — below mortgage", "not able to get you approved"],
      ["Price too low", "our offer was lower"],
    ] as const;
    for (const [tag, spokenText] of offerPaths) {
      const choice = screen.getByRole("tab", {
        name: `Use ${tag} spoken path for Present the appropriate offer outcome`,
      });
      await user.click(choice);
      expect(choice).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("current-section-title")).toHaveTextContent("Present the appropriate offer outcome");
      expect(screen.getAllByTestId("script-branch")).toHaveLength(1);
      expect(screen.getByTestId("current-section-script")).toHaveTextContent(spokenText);
    }

    await user.click(screen.getByTestId("phase-rail-close"));
    const closePaths = [
      ["If far apart — program pivot", "There is one program I can check"],
      ["They accept", "Congratulations"],
    ] as const;
    for (const [tag, spokenText] of closePaths) {
      const choice = screen.getByRole("tab", { name: `Use ${tag} spoken path for Choose the closing path` });
      await user.click(choice);
      expect(choice).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("current-section-title")).toHaveTextContent("Choose the closing path");
      expect(screen.getAllByTestId("script-branch")).toHaveLength(1);
      expect(screen.getByTestId("current-section-script")).toHaveTextContent(spokenText);
    }

    rerender(<CollapsibleHarness {...baseProps()} collapsed />);
    expect(screen.queryByTestId("coach-live-view")).not.toBeInTheDocument();
    rerender(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    expect(screen.getByRole("tab", { name: "Use They accept spoken path for Choose the closing path" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("current-section-script")).toHaveTextContent("Congratulations");
  }, 15_000);

  it("lets the rep fill motivation and cold-caller placeholders when context cannot", async () => {
    loadCoachCallContext.mockResolvedValueOnce({
      ...sampleContext,
      motivation: null,
      coldCallerName: null,
    });
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toHaveTextContent("Open the call"));

    await user.click(screen.getAllByTestId("entry-chip-cold_caller_name")[0]);
    await user.type(screen.getByTestId("entry-input-cold_caller_name"), "Morgan");
    await user.tab();
    await user.click(screen.getAllByTestId("entry-chip-motivation")[0]);
    await user.type(screen.getByTestId("entry-input-motivation"), "move closer to family");
    await user.tab();

    expect(screen.getByTestId("current-section-script")).toHaveTextContent("assistants Morgan");
    expect(screen.getByTestId("current-section-script")).toHaveTextContent("help with move closer to family");
    await user.click(screen.getByTestId("coach-next"));
    await user.click(screen.getByTestId("coach-back"));
    expect(screen.getAllByTestId("entry-chip-motivation")[0]).toHaveTextContent("move closer to family");
  });

  it("disables Next at the final manual section and removes the preview", async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toBeVisible());

    await user.click(screen.getByTestId("phase-rail-close"));
    await user.click(screen.getByTestId("coach-next"));
    await user.click(screen.getByTestId("coach-next"));

    expect(screen.getByTestId("current-section-title")).toHaveTextContent("Complete e-signing and wrap the call");
    expect(screen.getByTestId("coach-next")).toBeDisabled();
    expect(screen.queryByTestId("next-section-preview")).not.toBeInTheDocument();
  });

  it("preserves inline deal-entry editing without sending keypad tones", async () => {
    const user = userEvent.setup();
    const onDigit = vi.fn();
    render(<Harness {...baseProps({ onDigit })} />);
    await waitFor(() => expect(screen.getByTestId("current-section-title")).toBeVisible());

    await user.click(screen.getByTestId("phase-rail-offer"));
    await user.click(screen.getAllByTestId("entry-chip-offer_price")[0]);
    const input = screen.getByTestId("entry-input-offer_price");
    await user.type(input, "$210,000");
    await user.tab();

    expect(screen.getAllByTestId("entry-chip-offer_price")[0]).toHaveTextContent("$210,000");
    expect(onDigit).not.toHaveBeenCalled();
  });

  it("preserves mute, hold, hangup, collapse, and keypad controls", async () => {
    const user = userEvent.setup();
    const onMute = vi.fn();
    const onHold = vi.fn();
    const onHangup = vi.fn();
    const onCollapse = vi.fn();
    const onDigit = vi.fn();
    render(<Harness {...baseProps({ onMute, onHold, onHangup, onCollapse, onDigit })} />);
    await waitFor(() => expect(screen.getByTestId("coach-call-controls")).toBeVisible());

    await user.click(screen.getByTestId("coach-mute"));
    await user.click(screen.getByTestId("coach-hold"));
    await user.click(screen.getByTestId("coach-keypad-toggle"));
    await user.click(screen.getByLabelText("Keypad 5"));
    await user.click(screen.getByTestId("coach-hangup"));
    await user.click(screen.getByTestId("coach-collapse"));

    expect(onMute).toHaveBeenCalledOnce();
    expect(onHold).toHaveBeenCalledOnce();
    expect(onDigit).toHaveBeenCalledWith("5");
    expect(onHangup).toHaveBeenCalledOnce();
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  it("shows connecting and ringing status without enabling call-only controls", async () => {
    const { rerender } = render(<Harness {...baseProps({ callStatus: "connecting" })} />);
    await waitFor(() => expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Connecting"));
    expect(screen.getByTestId("coach-keypad-toggle")).toBeDisabled();
    expect(screen.getByTestId("coach-hold")).toBeDisabled();

    rerender(<Harness {...baseProps({ callStatus: "ringing" })} />);
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Ringing");
  });

  it("collapses on Escape and returns focus to the stable header dialer", async () => {
    const user = userEvent.setup();
    render(<DialogLifecycleHarness />);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Live call coach" })).toBeVisible());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Live call coach" })).not.toBeInTheDocument());
    expect(screen.getByTestId("header-dialer-button")).toHaveFocus();
  });
});

describe("selectSpokenLine", () => {
  it("skips internal notes and returns the first spoken line", () => {
    const spoken = { type: "say" as const, segments: [], id: "say-1" };
    expect(selectSpokenLine({ selected: { lines: [{ type: "note", segments: [], id: "note-1" }, spoken] } } as never)).toBe(spoken);
  });

  it("returns null for an all-note branch", () => {
    expect(selectSpokenLine({ selected: { lines: [{ type: "note", segments: [], id: "note-1" }] } } as never)).toBeNull();
  });
});
