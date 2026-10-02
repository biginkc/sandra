import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  completeSoftphoneCall: vi.fn(),
  prepareLeadCall: vi.fn(),
  prepareManualCall: vi.fn(),
  resumeFailed: vi.fn(),
  transports: [] as Array<{ hangup: ReturnType<typeof vi.fn> }>,
  loadCallerIds: vi.fn(),
  mintStartIntent: vi.fn(),
  jitterTransport: vi.fn(),
  directTransport: vi.fn(),
  start: vi.fn(),
  loadCoachCallScript: vi.fn(),
}));

vi.mock("@/lib/dialer/actions", () => ({
  completeSoftphoneCall: m.completeSoftphoneCall,
  loadDialerRecents: async () => ({ ok: true, data: [] }),
  prepareLeadCall: m.prepareLeadCall,
  prepareManualCall: m.prepareManualCall,
  resumeFailedSoftphoneCall: m.resumeFailed,
  searchDialerLeads: async () => ({ ok: true, data: [] }),
}));
vi.mock("@/lib/dialer/jitter-actions", () => ({
  loadJitterSoftphoneCallerIds: m.loadCallerIds,
  mintJitterStartIntent: m.mintStartIntent,
}));
vi.mock("@/lib/dialer/dtmf-tone", () => ({ playDtmfTone: vi.fn() }));
vi.mock("@/lib/dialer/transport-selection", () => ({
  createSoftphoneCallTransport: m.jitterTransport,
  isJitterTransportEnabled: () => true,
  isSoftphoneTransportEnabled: () => true,
}));
vi.mock("@/lib/dialer/telnyx-direct-transport", () => ({
  TelnyxDirectCallTransport: class {
    constructor() {
      return m.directTransport();
    }
  },
}));
vi.mock("@/lib/coach/coach-context-actions", () => ({ loadCoachCallContext: vi.fn(async () => { throw new Error("context unavailable in transport fixture"); }) }));
vi.mock("@/lib/coach/coach-script-actions", () => ({ loadCoachCallScript: m.loadCoachCallScript }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    realtime: { setAuth: vi.fn() },
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));

import { SoftphoneLeadButton } from "./softphone-lead-button";
import { SoftphoneHeaderButton, SoftphoneProvider } from "./softphone-provider";

const lead = {
  id: "property-1",
  contactId: "contact-1",
  firstName: "Softphone",
  name: "Softphone Lead",
  address: "1 Main St",
  state: "MO",
  phones: ["+18165550123"],
  dncLocked: false,
  contactDnc: false,
  callable: true,
};

function fakeTransport(handle: string, extra: Record<string, unknown> = {}, refusal?: string) {
  let listener: ((state: string) => void) | null = null;
  let ended = false;
  const transport = {
    terminalIsAuthoritative: () => ended,
    onStateChange: vi.fn((cb) => {
      listener = cb;
    }),
    start: m.start.mockImplementation(async () => {
      if (refusal) {
        listener?.(refusal);
        return { id: "" };
      }
      listener?.("connecting");
      listener?.("live");
      return { id: handle, ...extra };
    }),
    callHandle: () => ({ id: handle, ...extra }),
    mute: vi.fn(async () => true),
    hold: vi.fn(async () => true),
    reconnectAudio: vi.fn(async () => false),
    sendDigit: vi.fn(async () => true),
    hangup: vi.fn(async () => {
      ended = true;
      listener?.("ended");
      return { durationSeconds: 1, outcome: "connected_human" as const };
    }),
  };
  m.transports.push(transport);
  return transport;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.transports.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  window.localStorage.clear();
  window.sessionStorage.clear();
  m.prepareLeadCall.mockResolvedValue({
    ok: true,
    data: {
      propertyId: "property-1",
      contactId: "contact-1",
      phoneE164: "+18165550123",
      maskedPhone: "(816) 555-0123",
      name: "Softphone Lead",
      address: "1 Main St",
      state: "MO",
      startedAt: "2026-08-21T15:00:00.000Z",
    },
  });
  m.loadCallerIds.mockResolvedValue({
    ok: true,
    data: { caller_ids: [{ phone_e164: "+18165550100", label: "Main" }] },
  });
  m.mintStartIntent.mockResolvedValue({
    ok: true,
    data: { callToken: "server-call-token", intentCapability: "cap" },
  });
  m.jitterTransport.mockImplementation(() => fakeTransport("jitter-handle"));
  m.directTransport.mockImplementation(() => fakeTransport("direct-call-id", { callCapability: "sealed-direct-cap" }));
  m.resumeFailed.mockResolvedValue(undefined);
  m.loadCoachCallScript.mockResolvedValue({ status: "unavailable" });
  m.prepareManualCall.mockResolvedValue({
    ok: true,
    data: {
      propertyId: "property-1",
      contactId: "contact-1",
      phoneE164: "+18165550123",
      maskedPhone: "(816) 555-0123",
      name: "Softphone Lead",
      address: "1 Main St",
      state: "MO",
      startedAt: "2026-08-21T15:00:00.000Z",
    },
  });
  m.completeSoftphoneCall.mockResolvedValue({
    ok: true,
    data: { activityId: "a", callbackTaskId: null },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function placeAndWrap(config?: { transport: "telnyx_direct" | "default" }) {
  const user = userEvent.setup();
  render(
    <SoftphoneProvider callingConfig={config}>
      <SoftphoneHeaderButton />
      <SoftphoneLeadButton lead={lead} />
    </SoftphoneProvider>,
  );
  await user.click(screen.getByTestId("call-lead-button"));
  await waitFor(() =>
    expect(screen.getByTestId("call-live-pill")).toHaveTextContent("Live"),
  );
  await user.click(screen.getByTestId("call-hangup"));
  await user.type(screen.getByTestId("dispo-notes"), "Notes");
  await user.click(screen.getByTestId("dispo-not-interested"));
  await waitFor(() => expect(m.completeSoftphoneCall).toHaveBeenCalled());
}

describe("SoftphoneProvider pilot (telnyx_direct) mode", () => {
  it("uses the server-owned direct call identity for coaching when explicitly enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_COACH_UI_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_DIRECT_COACH_ENABLED", "1");
    const user = userEvent.setup();
    render(<SoftphoneProvider callingConfig={{ transport: "telnyx_direct" }}><SoftphoneLeadButton lead={lead} /></SoftphoneProvider>);
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(m.loadCoachCallScript).toHaveBeenCalledWith("direct-call-id"));
    expect(m.mintStartIntent).not.toHaveBeenCalled();
    expect(m.jitterTransport).not.toHaveBeenCalled();
  });

  it("never touches a Jitter action, uses the direct transport, and wraps up with the server-sealed identity", async () => {
    await placeAndWrap({ transport: "telnyx_direct" });
    expect(m.loadCallerIds).not.toHaveBeenCalled();
    expect(m.mintStartIntent).not.toHaveBeenCalled();
    expect(m.jitterTransport).not.toHaveBeenCalled();
    expect(m.directTransport).toHaveBeenCalledTimes(1);
    expect(m.start).toHaveBeenCalledWith(
      expect.not.objectContaining({
        callerIdE164: expect.anything(),
        intentCapability: expect.anything(),
      }),
    );
    expect(m.completeSoftphoneCall.mock.calls[0][0].callCapability).toBe("sealed-direct-cap");
  });

  it("replaces the caller-ID picker with the Sandra direct line label", async () => {
    const user = userEvent.setup();
    render(
      <SoftphoneProvider callingConfig={{ transport: "telnyx_direct" }}>
        <SoftphoneHeaderButton />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("header-dialer-button"));
    expect(await screen.findByTestId("direct-line-label")).toHaveTextContent(
      "Sandra direct line",
    );
    expect(screen.queryByTestId("caller-id-readonly")).not.toBeInTheDocument();
    expect(m.loadCallerIds).not.toHaveBeenCalled();
  });

  it("does not resume a retained Jitter call", async () => {
    window.sessionStorage.setItem(
      "sandra.softphone.active-call.v1",
      JSON.stringify({
        handle: { id: "old" },
        target: { phoneE164: "+18165550123", name: "X", maskedPhone: "x", address: "", state: null, startedAt: "2026-08-21T15:00:00.000Z", propertyId: null, contactId: null },
        startedAt: "2026-08-21T15:00:00.000Z",
        wrapToken: "w",
      }),
    );
    render(
      <SoftphoneProvider callingConfig={{ transport: "telnyx_direct" }}>
        <SoftphoneHeaderButton />
      </SoftphoneProvider>,
    );
    expect(m.directTransport).not.toHaveBeenCalled();
    expect(m.jitterTransport).not.toHaveBeenCalled();
  });
});

describe("SoftphoneProvider default mode", () => {
  it.each([undefined, { transport: "default" as const }])(
    "still uses the Jitter caller-ID inventory, start intent and capability (%j)",
    async (config) => {
      await placeAndWrap(config);
      expect(m.loadCallerIds).toHaveBeenCalled();
      expect(m.mintStartIntent).toHaveBeenCalledTimes(1);
      expect(m.directTransport).not.toHaveBeenCalled();
      expect(m.start).toHaveBeenCalledWith(
        expect.objectContaining({
          callerIdE164: "+18165550100",
          intentCapability: "cap",
        }),
      );
      expect(m.completeSoftphoneCall.mock.calls[0][0].callCapability).toBe(
        "jitter-handle",
      );
    },
  );
});

describe("SoftphoneProvider pilot review blockers", () => {
  const direct = { transport: "telnyx_direct" as const };

  it("sends the lead request kind the UI prepared", async () => {
    await placeAndWrap(direct);
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ directRequest: { kind: "lead", propertyId: "property-1" } }));
  });

  it("keeps a manual dial manual even when it was linked to a property", async () => {
    const user = userEvent.setup();
    render(
      <SoftphoneProvider callingConfig={direct}>
        <SoftphoneHeaderButton />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("header-dialer-button"));
    await user.type(await screen.findByTestId("dialer-input"), "8165550123");
    await user.click(screen.getByTestId("dialer-call-manual"));
    await waitFor(() => expect(m.start).toHaveBeenCalled());
    // Direct mode never prepares in the browser: the server does, after its own busy check.
    expect(m.prepareManualCall).not.toHaveBeenCalled();
    expect(m.start).toHaveBeenCalledWith(
      expect.objectContaining({ directRequest: { kind: "manual", phone: "8165550123" } }),
    );
  });

  it("does not send a direct request to the Jitter transport", async () => {
    await placeAndWrap({ transport: "default" });
    expect(m.start.mock.calls[0][0]).not.toHaveProperty("directRequest");
  });

  it("a refused second attempt in direct mode does not resume the first call's enrollments", async () => {
    m.directTransport.mockImplementation(() => fakeTransport("x", {}, "operator_busy"));
    const user = userEvent.setup();
    render(
      <SoftphoneProvider callingConfig={direct}>
        <SoftphoneHeaderButton />
        <SoftphoneLeadButton lead={lead} />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(m.start).toHaveBeenCalled());
    await screen.findByText("You already have a call in progress.");
    expect(m.resumeFailed).not.toHaveBeenCalled();
  });

  it("still resumes enrollments for a refused attempt on the Jitter path (unchanged)", async () => {
    m.jitterTransport.mockImplementation(() => fakeTransport("x", {}, "operator_busy"));
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneHeaderButton />
        <SoftphoneLeadButton lead={lead} />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(m.resumeFailed).toHaveBeenCalledWith("property-1"));
  });

  async function liveDirect(config: { transport: "telnyx_direct" | "default" }) {
    const user = userEvent.setup();
    render(
      <SoftphoneProvider callingConfig={config}>
        <SoftphoneHeaderButton />
        <SoftphoneLeadButton lead={lead} />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(screen.getByTestId("call-live-pill")).toHaveTextContent("Live"));
  }

  it("D6 on pagehide a live direct call fires no resume beacon (the server owns resume; the transport ends the call itself)", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", { value: beacon, configurable: true });
    await liveDirect(direct);
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith("/api/softphone/resume", expect.anything());
  });

  it("on the default path pagehide still resumes enrollments via the beacon (unchanged)", async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(window.navigator, "sendBeacon", { value: beacon, configurable: true });
    await liveDirect({ transport: "default" });
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledWith("/api/softphone/resume", expect.anything());
  });

  it("#744-2 never prepares before the server allows the call: tab 2 refused as busy pauses nothing and resumes nothing", async () => {
    m.directTransport.mockImplementation(() => fakeTransport("x", {}, "operator_busy"));
    const user = userEvent.setup();
    render(
      <SoftphoneProvider callingConfig={direct}>
        <SoftphoneHeaderButton />
        <SoftphoneLeadButton lead={lead} />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText("You already have a call in progress.");
    expect(m.prepareLeadCall).not.toHaveBeenCalled();
    expect(m.prepareManualCall).not.toHaveBeenCalled();
    expect(m.resumeFailed).not.toHaveBeenCalled();
    // The start request itself carried the lead, so the server prepares (and pauses) only if it allows the call.
    expect(m.start).toHaveBeenCalledWith(expect.objectContaining({ directRequest: { kind: "lead", propertyId: "property-1" } }));
  });

  it("#744-2 the Jitter path still prepares before starting (unchanged)", async () => {
    await placeAndWrap({ transport: "default" });
    expect(m.prepareLeadCall).toHaveBeenCalledWith("property-1");
  });

  it("direct mode shows the server-prepared target once the start returns, and never resumes from the browser when a call fails", async () => {
    const serverTarget = {
      propertyId: "property-1", contactId: "contact-1", phoneE164: "+18165550123", maskedPhone: "(816) 555-0123",
      name: "Server Prepared Name", address: "1 Main St", state: "MO", startedAt: "2026-10-01T12:00:00.000Z",
    };
    m.directTransport.mockImplementation(() => fakeTransport("direct-call-id", { target: serverTarget }));
    const user = userEvent.setup();
    render(
      <SoftphoneProvider callingConfig={direct}>
        <SoftphoneHeaderButton />
        <SoftphoneLeadButton lead={lead} />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByText("Server Prepared Name");
    expect(m.prepareLeadCall).not.toHaveBeenCalled();
  });

  it("pagehide on the default path does not hang the call up", async () => {
    await liveDirect({ transport: "default" });
    window.dispatchEvent(new Event("pagehide"));
    expect(m.transports[0].hangup).not.toHaveBeenCalled();
  });

  it("does not retain the active call for reload recovery in direct mode (it is retained on the default path)", async () => {
    await liveDirect(direct);
    expect(window.sessionStorage.getItem("sandra.softphone.active-call.v1")).toBeNull();
  });

  it("retains the active call on the default path", async () => {
    await liveDirect({ transport: "default" });
    expect(window.sessionStorage.getItem("sandra.softphone.active-call.v1")).not.toBeNull();
  });

  it("hides the live-coach toggle in direct mode even when the coach UI flag is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_COACH_UI_ENABLED", "1");
    const user = userEvent.setup();
    const { unmount } = render(
      <SoftphoneProvider callingConfig={direct}>
        <SoftphoneHeaderButton />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("header-dialer-button"));
    await screen.findByTestId("direct-line-label");
    expect(screen.queryByTestId("dialer-coach-toggle")).not.toBeInTheDocument();
    unmount();
    render(
      <SoftphoneProvider callingConfig={{ transport: "default" }}>
        <SoftphoneHeaderButton />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("header-dialer-button"));
    expect(await screen.findByTestId("dialer-coach-toggle")).toBeInTheDocument();
  });
});
