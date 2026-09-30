import { createHash } from "node:crypto";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closrOutbound123Bundle,
  closrOutbound123Ref,
} from "@biginkc/coach/fixtures";
import type { CoachCallContext } from "@/lib/coach/types";
import {
  useCoachSession,
  type PreparedCoachTarget,
} from "@/lib/coach/use-coach-session";

import {
  CoachLiveView,
  selectSpokenLine,
  type CoachLiveViewProps,
} from "./coach-live-view";
import { ObjectionPromptProvider } from "./objection-prompt-context";

type BroadcastHandler = (message: { payload: unknown }) => void;
type SubscribeCallback = (status: string) => void;

type MockChannel = {
  on: (type: string, filter: unknown, handler: BroadcastHandler) => MockChannel;
  subscribe: (callback: SubscribeCallback) => MockChannel;
  _broadcastHandler: BroadcastHandler | null;
  _subscribeCallback: SubscribeCallback | null;
};

const { loadCoachCallContext, loadCoachCallScript } = vi.hoisted(() => ({
  loadCoachCallContext: vi.fn(),
  loadCoachCallScript: vi.fn(),
}));
vi.mock("@/lib/coach/coach-context-actions", () => ({ loadCoachCallContext }));
vi.mock("@/lib/coach/coach-script-actions", () => ({ loadCoachCallScript }));

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

function Harness({
  callId = "call-1",
  preparedTarget,
  ...props
}: HarnessProps) {
  const session = useCoachSession(
    callId,
    "unauthorized-abcdef",
    "+18165559876",
    "+18165551234",
    true,
    preparedTarget,
  );
  return <CoachLiveView session={session} {...props} />;
}

function CollapsibleHarness({
  collapsed,
  ...props
}: HarnessProps & { collapsed: boolean }) {
  const session = useCoachSession(
    "call-1",
    "lead-1",
    "+18165559876",
    "+18165551234",
  );
  if (collapsed) return null;
  return <CoachLiveView session={session} {...props} />;
}

function DialogLifecycleHarness() {
  const [open, setOpen] = useState(true);
  const session = useCoachSession(
    "call-1",
    "lead-1",
    "+18165559876",
    "+18165551234",
  );
  return (
    <>
      <button type="button" data-testid="header-dialer-button">
        Dialer
      </button>
      <button type="button" onClick={() => setOpen(true)}>
        Open live coach
      </button>
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
    seconds: 83,
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

function latestChannel(): MockChannel {
  const channel = channels.at(-1);
  if (!channel) throw new Error("No coach channel");
  return channel;
}

function broadcast(payload: Record<string, unknown>) {
  act(() => {
    latestChannel()._broadcastHandler?.({
      payload: {
        scriptVersion: closrOutbound123Bundle.script.version,
        matcherVersion: "3",
        ...payload,
      },
    });
  });
}

describe("<CoachLiveView /> manual navigation", () => {
  const promptPayload = {
    type: "objection_prompt", objectionId: "price", label: "Price concern", sellerTurn: 1,
    classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z",
  };

  it("hides a valid prompt when display is disabled and leaves legacy objections hidden", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    broadcast(promptPayload);
    broadcast({ type: "objection", objectionId: "price", ts: "legacy" });
    expect(screen.queryByTestId("coach-objection-prompt")).toBeNull();
  });

  it("shows the exact label only when enabled", async () => {
    render(<ObjectionPromptProvider enabled><Harness {...baseProps()} /></ObjectionPromptProvider>);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    broadcast(promptPayload);
    expect(screen.getByTestId("coach-objection-prompt-label")).toHaveTextContent("Price concern");
    expect(screen.getByTestId("coach-objection-prompt")).not.toHaveTextContent("jev-1.13.0");
    expect(screen.getByTestId("coach-objection-prompt")).not.toHaveTextContent("price");
    broadcast({ type: "objection", objectionId: "legacy", ts: "legacy" });
    expect(screen.getAllByTestId("coach-objection-prompt")).toHaveLength(1);
    expect(screen.queryByTestId("coach-recommendations")).toBeNull();
    expect(screen.queryByTestId("follow-up-questions")).toBeNull();
  });

  it("mounts the v2 tray inside the script panel above navigation", async () => {
    vi.stubEnv("NEXT_PUBLIC_COACH_SCRIPT_V2", "1");
    render(<ObjectionPromptProvider enabled><Harness {...baseProps()} /></ObjectionPromptProvider>);
    await screen.findByTestId("current-script-card");
    broadcast(promptPayload);
    const panel = screen.getByTestId("coach-script-panel");
    const tray = await screen.findByTestId("coach-card-tray");
    expect(tray.parentElement).toBe(panel);
    expect(panel).toContainElement(screen.getByTestId("section-navigation"));
    expect(screen.queryByTestId("coach-recommendations")).toBeNull();
  });

  it("shows the owner's approved replies on the objection card, line for line, and nothing for a type without one", async () => {
    const raw = readFileSync("src/lib/coach/live-coach-objection-replies.json");
    expect(createHash("sha256").update(raw).digest("hex")).toBe("efeeb6da09f75f4e4a544e9999d8883351ea7d6fce56080d9286ecb85afd0ab1");
    const file = JSON.parse(raw.toString("utf8")) as { source: { sha256: string }; sets: Record<string, { replies: { catalogId: string; text: string }[] }> };
    expect(file.source.sha256).toBe("fe25b222796afd33e8171527789791307a58ae1f85b814320b0f1ed9dc6ecd77");
    const invisible = /[\s\u200b\u200c\u200d\ufeff]/g;
    const visibleLines = (text: string) => text.split("\n").filter((line) => line.replace(invisible, "") !== "");
    const base = { type: "objection_prompt", sellerTurn: 1, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64) };
    render(<ObjectionPromptProvider enabled><Harness {...baseProps()} /></ObjectionPromptProvider>);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    broadcast({ ...base, objectionId: "price_pushback", label: "Offered-price pushback", ts: "2026-09-29T12:00:00Z" });
    const blocks = () => screen.getAllByTestId("coach-objection-reply").map((block) => [...block.querySelectorAll("p")].map((line) => line.textContent));
    // Both merged catalog entries, in catalog order, every visible line exactly as written.
    expect(file.sets.price_pushback.replies.map((reply) => reply.catalogId)).toEqual(["offer_too_low", "counteroffer"]);
    expect(blocks()).toEqual(file.sets.price_pushback.replies.map((reply) => visibleLines(reply.text)));
    expect(blocks().flat().join("\n")).toBe(file.sets.price_pushback.replies.flatMap((reply) => visibleLines(reply.text)).join("\n"));
    // Owner-approved cleaning (2026-09-30): no playbook header, source tag or recorded seller name on any card.
    for (const set of Object.values(file.sets)) for (const reply of set.replies) expect(reply.text).not.toMatch(/CLOSR|Boiler|Kyle|Julia|Ivan|Stone|Jayline/);
    // Owner-approved relocation reply (2026-09-30), exactly as approved.
    broadcast({ ...base, objectionId: "relocation", label: "Housing delay", sellerTurn: 3, ts: "2026-09-29T12:00:10Z" });
    expect(screen.getByTestId("coach-objection-prompt-label")).toHaveTextContent("Housing delay");
    expect(blocks()).toEqual([["A lot of sellers I work with are in that spot. We can close and let you stay in the house a little while after, so you have the money in hand before you move. Would that help?"]]);
    broadcast({ ...base, objectionId: "assignment_fee", label: "Assignment fee", sellerTurn: 5, ts: "2026-09-29T12:00:20Z" });
    expect(screen.getByTestId("coach-objection-prompt-label")).toHaveTextContent("Assignment fee");
    expect(screen.queryByTestId("coach-objection-replies")).toBeNull();
    expect(file.sets.assignment_fee).toBeUndefined();
  });

  it("shows the matching sub-type lines, all at once, and replaces them on a later statement", async () => {
    const approved = JSON.parse(readFileSync("src/lib/coach/live-coach-replies.approved.json", "utf8")) as { sets: Record<string, { replies: { text: string }[] }> };
    const lines = () => [...screen.getByTestId("coach-motivation-replies").querySelectorAll("li")].map((item) => item.textContent);
    const base = { type: "motivation_prompt", label: "Motivation", classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64) };
    render(<ObjectionPromptProvider enabled><Harness {...baseProps()} /></ObjectionPromptProvider>);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    broadcast({ ...base, subType: "tired_landlord", sellerTurn: 1, ts: "2026-09-29T12:00:00Z" });
    expect(lines()).toEqual(approved.sets["motivation.tired_landlord"].replies.map((reply) => reply.text));
    expect(lines()).toHaveLength(6);
    broadcast({ ...base, subType: "inherited", sellerTurn: 3, ts: "2026-09-29T12:00:10Z" });
    expect(lines()).toEqual(approved.sets["motivation.inherited"].replies.map((reply) => reply.text));
    broadcast({ ...base, subType: "not_an_approved_set", sellerTurn: 5, ts: "2026-09-29T12:00:20Z" });
    expect(lines()).toEqual(approved.sets.motivation.replies.map((reply) => reply.text));
    expect(screen.getAllByTestId("coach-motivation-prompt")).toHaveLength(1);
  });

  it("shows a separate motivation card beside the objection card, only when enabled", async () => {
    const motivationPayload = { type: "motivation_prompt", label: "Motivation", sellerTurn: 1, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z" };
    const { unmount } = render(<Harness {...baseProps()} />);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    broadcast(motivationPayload);
    expect(screen.queryByTestId("coach-motivation-prompt")).toBeNull();
    unmount();
    render(<ObjectionPromptProvider enabled><Harness {...baseProps()} /></ObjectionPromptProvider>);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    broadcast(promptPayload);
    broadcast(motivationPayload);
    expect(screen.getByTestId("coach-objection-prompt-label")).toHaveTextContent("Price concern");
    const approved = JSON.parse(readFileSync("src/lib/coach/live-coach-replies.approved.json", "utf8")) as { sets: { motivation: { replies: { text: string }[] } } };
    expect([...screen.getByTestId("coach-motivation-replies").querySelectorAll("li")].map((item) => item.textContent)).toEqual(approved.sets.motivation.replies.map((reply) => reply.text));
    expect(screen.getByTestId("coach-motivation-prompt-label")).toHaveTextContent("Motivation");
    expect(screen.getByTestId("coach-objection-prompt").querySelector("ul")).toBeNull();
    expect(screen.getByTestId("coach-card-tray")).toContainElement(screen.getByTestId("coach-objection-prompt"));
    expect(screen.getByTestId("coach-card-tray")).toContainElement(screen.getByTestId("coach-motivation-prompt"));
  });

  it("keeps prompts past thirty seconds, replaces each kind, and dismisses independently", async () => {
    render(<ObjectionPromptProvider enabled><Harness {...baseProps()} /></ObjectionPromptProvider>);
    await waitFor(() => expect(screen.getByTestId("current-script-card")).toBeVisible());
    vi.useFakeTimers();
    try {
      broadcast(promptPayload);
      expect(screen.getByTestId("coach-objection-prompt")).toBeVisible();
      broadcast({ type: "motivation_prompt", label: "Motivation", sellerTurn: 1, classifierModel: "jev-1.13.0", questionsSha256: "a".repeat(64), ts: "2026-09-29T12:00:00Z" });
      act(() => vi.advanceTimersByTime(31_000));
      expect(screen.getByTestId("coach-objection-prompt")).toBeVisible();
      expect(screen.getByTestId("coach-motivation-prompt")).toBeVisible();
      broadcast({ ...promptPayload, label: "Timing concern", sellerTurn: 2, ts: "2026-09-29T12:00:01Z" });
      expect(screen.getByTestId("coach-objection-prompt-label")).toHaveTextContent("Timing concern");
      expect(screen.getAllByTestId("coach-objection-prompt")).toHaveLength(1);
      fireEvent.click(screen.getByTestId("coach-objection-prompt-dismiss"));
      expect(screen.queryByTestId("coach-objection-prompt")).toBeNull();
      expect(screen.getByTestId("coach-motivation-prompt")).toBeVisible();
      fireEvent.click(screen.getByTestId("coach-motivation-prompt-dismiss"));
      expect(screen.queryByTestId("coach-motivation-prompt")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    channels = [];
    loadCoachCallContext.mockReset().mockResolvedValue(sampleContext);
    loadCoachCallScript
      .mockReset()
      .mockResolvedValue({
        status: "bound",
        binding: { ref: closrOutbound123Ref, bundle: closrOutbound123Bundle },
      });
  });

  it("shows the full first section, boundary state, transcript, and next-section preview", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    expect(screen.getByTestId("coach-back")).toBeDisabled();
    expect(screen.getByTestId("coach-next")).toBeEnabled();
    expect(screen.getByTestId("next-section-preview")).toHaveTextContent(
      "Set the qualification frame",
    );
    expect(screen.getByTestId("current-section-script")).toHaveTextContent(
      "Alex Rep",
    );
    expect(screen.getByTestId("current-section-script")).toHaveTextContent(
      "spoke to one of my assistants Taylor",
    );
    expect(
      screen.queryByTestId("entry-chip-motivation"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("entry-chip-cold_caller_name"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Live transcript")).not.toHaveAttribute(
      "hidden",
    );
    expect(screen.queryByTestId("coach-recommendations")).toBeNull();
  });

  it("keeps the S4 panel when the V2 flag is unset", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );
    expect(
      screen.queryByTestId("coach-script-v2-panel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("coach-script-ref-label"),
    ).not.toBeInTheDocument();
  });

  it("does not warn while strict wire events wait for the script binding", async () => {
    vi.stubEnv("NEXT_PUBLIC_COACH_WIRE_DIGEST_STRICT", "1");
    loadCoachCallScript.mockReturnValue(new Promise(() => {}));
    render(<Harness {...baseProps()} />);

    await waitFor(() => expect(channels).toHaveLength(1));
    broadcast({
      type: "counter",
      probeCount: 7,
      scriptDigest: closrOutbound123Ref.digest,
      ts: "binding-pending",
    });

    expect(
      screen.queryByTestId("coach-binding-missed-events"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-reconnect-gap")).not.toBeInTheDocument();
  });

  it("renders the package navigator in the two-column view and retains typed navigator state", async () => {
    vi.stubEnv("NEXT_PUBLIC_COACH_SCRIPT_V2", "1");
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      motivation: null,
    });
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toBeVisible(),
    );
    expect(screen.getByTestId("coach-script-ref-label")).toHaveTextContent(
      "closr-outbound@1 · locked for this call",
    );
    expect(screen.getByTestId("coach-script-ref")).not.toHaveTextContent(
      "locked for this call",
    );
    expect(screen.getByTestId("coach-powered-by-closer-lab")).toHaveTextContent(
      "Powered by",
    );
    expect(screen.getByAltText("Closer Lab")).toHaveAttribute(
      "src",
      "/brand/closer-lab-logo.svg",
    );
    expect(
      screen.queryByTestId("coach-phase-scroller"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId("coach-next"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Set the qualification frame",
    );
    await user.click(screen.getByTestId("coach-back"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Open the call",
    );
    const motivation = await screen.findByTestId("coach-token-motivation");
    fireEvent.change(motivation, { target: { value: "Downsize" } });
    expect(motivation).toHaveValue("Downsize");
  });

  it("keeps file-number identity placeholder-only while loading, then shows the authorized context value", async () => {
    let resolveContext!: (context: CoachCallContext) => void;
    loadCoachCallContext.mockReturnValue(
      new Promise((resolve) => {
        resolveContext = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <Harness
        {...baseProps()}
        preparedTarget={{
          repName: "Jarrad Henry",
          sellerName: "Prepared Homeowner",
          propertyAddress: "55 Oak Ave",
          sellerPhoneE164: "+18165559876",
          maskedSellerPhone: "+1 (816) 555-9876",
        }}
      />,
    );

    expect(screen.queryByTestId("coach-file-number")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("coach-next")).toBeEnabled());

    for (let step = 0; step < 5; step += 1)
      await user.click(screen.getByTestId("coach-next"));
    const script = screen.getByTestId("current-section-script");
    expect(script).not.toHaveTextContent("JH-abcdef");
    expect(script).toHaveTextContent("—");

    act(() =>
      resolveContext({
        ...sampleContext,
        repName: "Jarrad Henry",
        authenticatedRepName: "Jarrad Henry",
        leadId: "abcd1234-ef56-7890-abcd-ef1234c1c524",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("coach-file-number")).toHaveTextContent(
        "File number: JH-c1c524",
      ),
    );
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
    await waitFor(() =>
      expect(fileNumber).toHaveTextContent("File number: JH-c1c524"),
    );
    for (let step = 0; step < 25; step += 1) {
      expect(fileNumber).toBeVisible();
      expect(fileNumber).toHaveTextContent("File number: JH-c1c524");
      await user.click(screen.getByTestId("coach-next"));
    }
    expect(fileNumber).toBeVisible();
    expect(fileNumber).toHaveTextContent("File number: JH-c1c524");
  });

  it("never exposes requested/prepared file-number identity after a property authorization failure", async () => {
    loadCoachCallContext.mockRejectedValue(
      new Error("permission denied for property"),
    );
    const user = userEvent.setup();
    render(
      <Harness
        {...baseProps()}
        preparedTarget={{
          repName: "Jarrad Henry",
          sellerName: "Prepared Homeowner",
          propertyAddress: "55 Oak Ave",
          sellerPhoneE164: "+18165559876",
          maskedSellerPhone: "+1 (816) 555-9876",
        }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("coach-context-error")).toBeVisible(),
    );
    expect(screen.queryByTestId("coach-file-number")).not.toBeInTheDocument();
    for (let step = 0; step < 5; step += 1)
      await user.click(screen.getByTestId("coach-next"));
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
    render(
      <Harness
        {...baseProps()}
        preparedTarget={{
          repName: "Jarrad Henry",
          sellerName: "Prepared Homeowner",
          propertyAddress: "55 Oak Ave",
          sellerPhoneE164: "+18165559876",
          maskedSellerPhone: "+1 (816) 555-9876",
        }}
      />,
    );

    await waitFor(() => expect(loadCoachCallContext).toHaveBeenCalled());
    expect(screen.queryByTestId("coach-file-number")).not.toBeInTheDocument();
    for (let step = 0; step < 5; step += 1)
      await user.click(screen.getByTestId("coach-next"));
    const script = screen.getByTestId("current-section-script");
    expect(script).not.toHaveTextContent("JH-c1c524");
    expect(script).toHaveTextContent("—");
  });

  it("keeps the coach visible and exposes manual audio recovery without ending the call", async () => {
    const user = userEvent.setup();
    const onReconnectAudio = vi.fn();
    const onHangup = vi.fn();
    render(
      <Harness
        {...baseProps({
          callStatus: "audio_reconnect_required",
          onReconnectAudio,
          onHangup,
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    expect(
      screen.getByTestId("coach-audio-reconnect-warning"),
    ).toHaveTextContent("Call live · audio interrupted");
    expect(screen.getByLabelText("Live transcript")).toBeVisible();
    expect(screen.getByTestId("current-section-script")).toBeVisible();
    expect(screen.getByTestId("coach-hangup")).toBeEnabled();
    expect(screen.getByTestId("coach-mute")).toBeDisabled();
    expect(screen.getByTestId("coach-warning-hangup")).toHaveTextContent(
      "Hang Up",
    );
    expect(onHangup).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("coach-reconnect-audio"));
    expect(onReconnectAudio).toHaveBeenCalledTimes(1);
    expect(onHangup).not.toHaveBeenCalled();
  });

  it("uses neutral tokens while the retained-call status check is pending", async () => {
    render(<Harness {...baseProps({ checkingCallStatus: true })} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    const warning = screen.getByTestId("coach-audio-reconnect-warning");
    expect(warning).toHaveTextContent("Checking call status…");
    expect(warning.className).not.toMatch(/amber|red/);
  });

  it("keeps recovery and hangup visible while reconnecting without hiding live guidance", async () => {
    const user = userEvent.setup();
    const onReconnectAudio = vi.fn();
    const onHangup = vi.fn();
    render(
      <Harness
        {...baseProps({
          callStatus: "audio_reconnecting",
          onReconnectAudio,
          onHangup,
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    expect(
      screen.getByTestId("coach-audio-reconnect-warning"),
    ).toHaveTextContent("Call live · reconnecting browser audio…");
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
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    await user.click(screen.getByTestId("coach-next"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Set the qualification frame",
    );
    expect(screen.getByTestId("coach-back")).toBeEnabled();

    await user.click(screen.getByTestId("coach-back"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Open the call",
    );

    await user.click(screen.getByTestId("phase-rail-reveal"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Open the seller situation",
    );
    expect(screen.getByTestId("phase-rail-reveal")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByTestId("coach-current-phase")).toHaveTextContent(
      "Phase · Reveal",
    );
  });

  it("keeps section, preview, and rail inert when legacy phase and cursor events arrive", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );
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

    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Open the call",
    );
    expect(screen.getByTestId("next-section-preview").textContent).toBe(
      preview,
    );
    expect(screen.getByTestId("phase-rail-introduction")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByTestId("phase-rail-close")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("renders both speakers and preserves final versus interim transcript state", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toBeVisible(),
    );

    broadcast({
      type: "transcript",
      speaker: "seller",
      text: "The roof",
      isFinal: true,
      ts: "seller-final-1",
    });
    broadcast({
      type: "transcript",
      speaker: "seller",
      text: "needs work.",
      isFinal: true,
      ts: "seller-final-2",
    });
    broadcast({
      type: "transcript",
      speaker: "rep",
      text: "Tell me more about",
      isFinal: false,
      ts: "rep-interim",
    });

    const lines = screen.getAllByTestId("transcript-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Seller");
    expect(lines[0]).toHaveTextContent("The roof needs work.");
    expect(lines[0]).toHaveAttribute("data-final", "true");
    expect(lines[1]).toHaveTextContent("Rep");
    expect(lines[1]).toHaveTextContent("Tell me more about");
    expect(lines[1]).toHaveAttribute("data-final", "false");
  });

  it("parses legacy guidance events without rendering them or covering the script", async () => {
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-script-card")).toBeVisible(),
    );

    broadcast({
      type: "coach_note",
      text: "Legacy nudge",
      phaseId: "introduction",
      ts: "n1",
    });
    broadcast({ type: "objection", objectionId: "price_too_low", ts: "o1" });
    broadcast({ type: "counter", probeCount: 6, ts: "c1" });
    broadcast({
      type: "gate",
      gateId: "no_concerns",
      cleared: false,
      ts: "g1",
    });
    broadcast({
      type: "timer",
      timerId: "hold",
      startedAt: "2026-08-27T20:00:00.000Z",
      durationS: 300,
      ts: "t1",
    });

    expect(screen.getByTestId("current-script-card")).toBeVisible();
    expect(
      screen.queryByTestId("coach-guidance-stack"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("coach-nudge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("objection-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("probe-counter")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hold-timer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gate-no_concerns")).not.toBeInTheDocument();
  });

  it("keeps the exact manually selected section and transcript across collapse and reopen", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CollapsibleHarness {...baseProps()} collapsed={false} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    await user.click(screen.getByTestId("coach-next"));
    await user.click(screen.getByTestId("coach-next"));
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Explain how BMH works",
    );

    broadcast({
      type: "transcript",
      speaker: "seller",
      text: "We need to move before winter.",
      isFinal: true,
      ts: "transcript-1",
    });
    expect(screen.getByTestId("coach-transcript")).toHaveTextContent(
      "We need to move before winter.",
    );

    rerender(<CollapsibleHarness {...baseProps()} collapsed />);
    expect(screen.queryByTestId("coach-live-view")).not.toBeInTheDocument();
    rerender(<CollapsibleHarness {...baseProps()} collapsed={false} />);

    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Explain how BMH works",
    );
    expect(screen.getByTestId("coach-transcript")).toHaveTextContent(
      "We need to move before winter.",
    );
    expect(channels).toHaveLength(1);
    expect(loadCoachCallContext).toHaveBeenCalledTimes(1);
  });

  it("keeps the active script visible during context failure and listener degradation", async () => {
    loadCoachCallContext.mockReset().mockRejectedValue(new Error("network"));
    render(<Harness {...baseProps()} />);

    await waitFor(() =>
      expect(screen.getByTestId("coach-context-error")).toBeVisible(),
    );
    expect(screen.getByTestId("current-script-card")).toBeVisible();
    act(() => latestChannel()._subscribeCallback?.("CHANNEL_ERROR"));
    expect(screen.getByTestId("coach-degraded-note")).toHaveTextContent(
      "your place is saved",
    );
    expect(screen.getAllByTestId("token-placeholder").length).toBeGreaterThan(
      0,
    );
  });

  it("shows only one opener with four individual choices when lead source is unknown", async () => {
    loadCoachCallContext.mockResolvedValue({
      ...sampleContext,
      leadSource: null,
    });
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-script-card")).toBeVisible(),
    );
    const opener = screen.getByTestId("current-section-script");
    expect(opener).toHaveTextContent(
      "It looks like you spoke to one of my assistants",
    );
    expect(opener).not.toHaveTextContent("was listed For Sale by Owner.");
    expect(opener).not.toHaveTextContent(
      "I see you just responded to our teams text",
    );
    expect(opener).not.toHaveTextContent(
      "I’m holding a copy of your tax records here",
    );
    expect(opener).not.toHaveTextContent("The reason for my call today");
    expect(
      screen.queryByTestId("variant-Opener-default"),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("tablist", { name: "Opener variant" })
        .querySelectorAll("button"),
    ).toHaveLength(4);
  });

  it("keeps conditional variants inside the visible section", async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("variant-Opener-fsbo")).toBeVisible(),
    );

    expect(screen.getByTestId("variant-Opener-fsbo")).toHaveAccessibleName(
      "Use FSBO spoken fork for Opener",
    );
    await user.click(screen.getByTestId("variant-Opener-fsbo"));

    expect(screen.getByTestId("variant-Opener-fsbo")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("current-section-script")).toHaveTextContent(
      "For Sale by Owner",
    );
    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Open the call",
    );
  }, 10_000);

  it("shows exactly one rep-selected Offer or Close spoken path and preserves it across collapse", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CollapsibleHarness {...baseProps()} collapsed={false} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toBeVisible(),
    );

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
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Present the appropriate offer outcome",
      );
      expect(screen.getAllByTestId("script-branch")).toHaveLength(1);
      expect(screen.getByTestId("current-section-script")).toHaveTextContent(
        spokenText,
      );
    }

    await user.click(screen.getByTestId("phase-rail-close"));
    const closePaths = [
      ["If far apart — program pivot", "There is one program I can check"],
      ["They accept", "Congratulations"],
    ] as const;
    for (const [tag, spokenText] of closePaths) {
      const choice = screen.getByRole("tab", {
        name: `Use ${tag} spoken path for Choose the closing path`,
      });
      await user.click(choice);
      expect(choice).toHaveAttribute("aria-selected", "true");
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Choose the closing path",
      );
      expect(screen.getAllByTestId("script-branch")).toHaveLength(1);
      expect(screen.getByTestId("current-section-script")).toHaveTextContent(
        spokenText,
      );
    }

    rerender(<CollapsibleHarness {...baseProps()} collapsed />);
    expect(screen.queryByTestId("coach-live-view")).not.toBeInTheDocument();
    rerender(<CollapsibleHarness {...baseProps()} collapsed={false} />);
    expect(
      screen.getByRole("tab", {
        name: "Use They accept spoken path for Choose the closing path",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("current-section-script")).toHaveTextContent(
      "Congratulations",
    );
  }, 15_000);

  it("lets the rep fill motivation and cold-caller placeholders when context cannot", async () => {
    loadCoachCallContext.mockResolvedValueOnce({
      ...sampleContext,
      motivation: null,
      coldCallerName: null,
    });
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toHaveTextContent(
        "Open the call",
      ),
    );

    await user.click(screen.getAllByTestId("entry-chip-cold_caller_name")[0]);
    await user.type(
      screen.getByTestId("entry-input-cold_caller_name"),
      "Morgan",
    );
    await user.tab();
    await user.click(screen.getAllByTestId("entry-chip-motivation")[0]);
    await user.type(
      screen.getByTestId("entry-input-motivation"),
      "move closer to family",
    );
    await user.tab();

    expect(screen.getByTestId("current-section-script")).toHaveTextContent(
      "assistants Morgan",
    );
    expect(screen.getByTestId("current-section-script")).toHaveTextContent(
      "help with move closer to family",
    );
    await user.click(screen.getByTestId("coach-next"));
    await user.click(screen.getByTestId("coach-back"));
    expect(screen.getAllByTestId("entry-chip-motivation")[0]).toHaveTextContent(
      "move closer to family",
    );
  });

  it("disables Next at the final manual section and removes the preview", async () => {
    const user = userEvent.setup();
    render(<Harness {...baseProps()} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toBeVisible(),
    );

    await user.click(screen.getByTestId("phase-rail-close"));
    await user.click(screen.getByTestId("coach-next"));
    await user.click(screen.getByTestId("coach-next"));

    expect(screen.getByTestId("current-section-title")).toHaveTextContent(
      "Complete e-signing and wrap the call",
    );
    expect(screen.getByTestId("coach-next")).toBeDisabled();
    expect(
      screen.queryByTestId("next-section-preview"),
    ).not.toBeInTheDocument();
  });

  it("preserves inline deal-entry editing without sending keypad tones", async () => {
    const user = userEvent.setup();
    const onDigit = vi.fn();
    render(<Harness {...baseProps({ onDigit })} />);
    await waitFor(() =>
      expect(screen.getByTestId("current-section-title")).toBeVisible(),
    );

    await user.click(screen.getByTestId("phase-rail-offer"));
    await user.click(screen.getAllByTestId("entry-chip-offer_price")[0]);
    const input = screen.getByTestId("entry-input-offer_price");
    await user.type(input, "$210,000");
    await user.tab();

    expect(
      screen.getAllByTestId("entry-chip-offer_price")[0],
    ).toHaveTextContent("$210,000");
    expect(onDigit).not.toHaveBeenCalled();
  });

  it("preserves mute, hold, hangup, collapse, and keypad controls", async () => {
    const user = userEvent.setup();
    const onMute = vi.fn();
    const onHold = vi.fn();
    const onHangup = vi.fn();
    const onCollapse = vi.fn();
    const onDigit = vi.fn();
    render(
      <Harness
        {...baseProps({ onMute, onHold, onHangup, onCollapse, onDigit })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("coach-call-controls")).toBeVisible(),
    );

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
    const { rerender } = render(
      <Harness {...baseProps({ callStatus: "connecting" })} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("coach-call-timer")).toHaveTextContent(
        "Connecting",
      ),
    );
    expect(screen.getByTestId("coach-keypad-toggle")).toBeDisabled();
    expect(screen.getByTestId("coach-hold")).toBeDisabled();

    rerender(<Harness {...baseProps({ callStatus: "ringing" })} />);
    expect(screen.getByTestId("coach-call-timer")).toHaveTextContent("Ringing");
  });

  it("collapses on Escape and returns focus to the stable header dialer", async () => {
    const user = userEvent.setup();
    render(<DialogLifecycleHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "Live call coach" }),
      ).toBeVisible(),
    );

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Live call coach" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("header-dialer-button")).toHaveFocus();
  });
});

describe("selectSpokenLine", () => {
  it("skips internal notes and returns the first spoken line", () => {
    const spoken = { type: "say" as const, segments: [], id: "say-1" };
    expect(
      selectSpokenLine({
        selected: {
          lines: [{ type: "note", segments: [], id: "note-1" }, spoken],
        },
      } as never),
    ).toBe(spoken);
  });

  it("returns null for an all-note branch", () => {
    expect(
      selectSpokenLine({
        selected: { lines: [{ type: "note", segments: [], id: "note-1" }] },
      } as never),
    ).toBeNull();
  });
});
