import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  completeSoftphoneCall: vi.fn(),
  prepareLeadCall: vi.fn(),
  loadCallerIds: vi.fn(),
  mintStartIntent: vi.fn(),
  jitterTransport: vi.fn(),
  directTransport: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@/lib/dialer/actions", () => ({
  completeSoftphoneCall: m.completeSoftphoneCall,
  loadDialerRecents: async () => ({ ok: true, data: [] }),
  prepareLeadCall: m.prepareLeadCall,
  prepareManualCall: vi.fn(),
  resumeFailedSoftphoneCall: vi.fn(),
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
vi.mock("@/lib/coach/coach-context-actions", () => ({ loadCoachCallContext: vi.fn() }));
vi.mock("@/lib/coach/coach-script-actions", () => ({ loadCoachCallScript: vi.fn() }));
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

function fakeTransport(handle: string) {
  let listener: ((state: string) => void) | null = null;
  return {
    onStateChange: vi.fn((cb) => {
      listener = cb;
    }),
    start: m.start.mockImplementation(async () => {
      listener?.("connecting");
      listener?.("live");
      return { id: handle };
    }),
    callHandle: () => ({ id: handle }),
    mute: vi.fn(async () => true),
    hold: vi.fn(async () => true),
    reconnectAudio: vi.fn(async () => false),
    sendDigit: vi.fn(async () => true),
    hangup: vi.fn(async () => {
      listener?.("ended");
      return { durationSeconds: 1, outcome: "connected_human" as const };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  m.directTransport.mockImplementation(() => fakeTransport("direct-call-id"));
  m.completeSoftphoneCall.mockResolvedValue({
    ok: true,
    data: { activityId: "a", callbackTaskId: null },
  });
});

afterEach(() => vi.unstubAllEnvs());

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
  it("never touches a Jitter action, uses the direct transport, and wraps up capability-less", async () => {
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
    expect(m.completeSoftphoneCall.mock.calls[0][0].callCapability).toBeUndefined();
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
