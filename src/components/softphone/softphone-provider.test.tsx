import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeSoftphoneCall, loadDialerRecents, prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall, searchDialerLeads, createTransport, transportEnabled, playDtmfTone } = vi.hoisted(() => ({
  completeSoftphoneCall: vi.fn(),
  loadDialerRecents: vi.fn(async () => ({ ok: true, data: [] })),
  prepareLeadCall: vi.fn(),
  prepareManualCall: vi.fn(),
  resumeFailedSoftphoneCall: vi.fn(),
  createTransport: vi.fn(),
  transportEnabled: vi.fn(),
  searchDialerLeads: vi.fn(async () => ({ ok: true, data: [] })),
  playDtmfTone: vi.fn(),
}));

vi.mock("@/lib/dialer/actions", () => ({
  completeSoftphoneCall,
  loadDialerRecents,
  prepareLeadCall,
  prepareManualCall,
  resumeFailedSoftphoneCall,
  searchDialerLeads,
}));

vi.mock("@/lib/dialer/dtmf-tone", () => ({ playDtmfTone }));

vi.mock("@/lib/dialer/transport-selection", () => ({
  createSoftphoneCallTransport: createTransport,
  isSoftphoneTransportEnabled: transportEnabled,
}));

import { SoftphoneLeadButton } from "./softphone-lead-button";
import { SoftphoneHeaderButton, SoftphoneProvider } from "./softphone-provider";

describe("SoftphoneProvider transport gate", () => {
  beforeEach(() => {
    completeSoftphoneCall.mockReset();
    prepareLeadCall.mockReset();
    prepareManualCall.mockReset();
    searchDialerLeads.mockResolvedValue({ ok: true, data: [] });
    playDtmfTone.mockReset();
    resumeFailedSoftphoneCall.mockReset();
    loadDialerRecents.mockResolvedValue({ ok: true, data: [] });
    transportEnabled.mockImplementation(() => process.env.NEXT_PUBLIC_SOFTPHONE_TRANSPORT === "simulated");
    createTransport.mockImplementation(() => {
      let listener: ((state: "connecting" | "ringing" | "live" | "ended" | "failed") => void) | null = null;
      return {
        onStateChange: vi.fn((cb) => { listener = cb; }),
        start: vi.fn(async () => {
          listener?.("connecting");
          listener?.("live");
          return { id: "simulated-session" };
        }),
        mute: vi.fn(),
        hold: vi.fn(),
        sendDigit: vi.fn(() => true),
        hangup: vi.fn(async () => {
          listener?.("ended");
          return { durationSeconds: 1, outcome: "connected_human" as const };
        }),
      };
    });
  });

  it("shows the selected lead while preparation is pending without flashing the idle keypad", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    prepareLeadCall.mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    render(<SoftphoneProvider><SoftphoneLeadButton lead={{ id: "property-1", contactId: "contact-1", firstName: "Softphone", name: "Softphone Lead", address: "1 Main St", state: "MO", phones: ["+18165550123"], dncLocked: false, contactDnc: false, callable: true }} /></SoftphoneProvider>);

    await user.click(screen.getByTestId("call-lead-button"));

    expect(screen.getByTestId("call-preparing")).toHaveTextContent("Softphone Lead");
    expect(screen.queryByTestId("dialer-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("phone-keypad")).not.toBeInTheDocument();
  });

  it("accepts clicked and keyboard digits once, tones only those presses, and keeps paste silent", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    const user = userEvent.setup();
    render(<SoftphoneProvider><SoftphoneHeaderButton /></SoftphoneProvider>);
    await user.click(screen.getByTestId("header-dialer-button"));
    const input = screen.getByTestId("dialer-input");

    await user.click(screen.getByLabelText("Keypad 3"));
    await user.type(input, "10");
    await user.paste("7540662");

    expect(input).toHaveValue("(310) 754-0662");
    expect(playDtmfTone.mock.calls.map(([digit]) => digit)).toEqual(["3", "1", "0"]);
    expect(screen.getByTestId("dialer-call-manual")).toHaveTextContent("Call (310) 754-0662");
  });

  it("keeps live keypad hidden until requested and sends digits only while live and not held", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    prepareLeadCall.mockResolvedValue({ ok: true, data: { propertyId: "property-1", contactId: "contact-1", phoneE164: "+18165550123", maskedPhone: "(816) 555-0123", name: "Softphone Lead", address: "1 Main St", state: "MO", startedAt: "2026-08-21T15:00:00.000Z" } });
    const sendDigit = vi.fn(() => true);
    createTransport.mockImplementation(() => {
      let listener: ((state: "connecting" | "live" | "ended") => void) | null = null;
      return { onStateChange: vi.fn((cb) => { listener = cb; }), start: vi.fn(async () => { listener?.("connecting"); listener?.("live"); return { id: "call-1" }; }), mute: vi.fn(), hold: vi.fn(), sendDigit, hangup: vi.fn(async () => ({ durationSeconds: 1, outcome: "connected_human" as const })) };
    });
    const user = userEvent.setup();
    render(<SoftphoneProvider><SoftphoneLeadButton lead={{ id: "property-1", contactId: "contact-1", firstName: "Softphone", name: "Softphone Lead", address: "1 Main St", state: "MO", phones: ["+18165550123"], dncLocked: false, contactDnc: false, callable: true }} /></SoftphoneProvider>);
    await user.click(screen.getByTestId("call-lead-button"));
    await screen.findByTestId("call-live-pill");
    expect(screen.queryByTestId("phone-keypad")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("call-keypad"));
    await user.click(screen.getByLabelText("Keypad #"));
    expect(sendDigit).toHaveBeenCalledWith("#");
    expect(playDtmfTone).toHaveBeenCalledWith("#");
    await user.click(screen.getByTestId("call-hold"));
    expect(screen.queryByTestId("phone-keypad")).not.toBeInTheDocument();
    expect(screen.getByTestId("call-keypad")).toBeDisabled();
  });

  it.each([
    ["operator_busy", "You already have an active Jitter call."],
    ["not_callable", "This number is no longer callable."],
  ] as const)("returns to idle without wrap-up for %s", async (rejectionState, message) => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    prepareLeadCall.mockResolvedValue({
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
    createTransport.mockImplementation(() => {
      let listener: ((state: typeof rejectionState) => void) | null = null;
      return {
        onStateChange: vi.fn((cb) => { listener = cb; }),
        start: vi.fn(async () => {
          listener?.(rejectionState);
          throw new Error(rejectionState);
        }),
        mute: vi.fn(),
        hold: vi.fn(),
        hangup: vi.fn(),
      };
    });
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByTestId("dispo-notes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("call-live-pill")).not.toBeInTheDocument();
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledWith("property-1");
  });

  it("still clears a refused start when sequence resume loses its response", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    resumeFailedSoftphoneCall.mockRejectedValueOnce(new Error("response lost"));
    prepareLeadCall.mockResolvedValue({
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
    createTransport.mockImplementation(() => {
      let listener: ((state: "operator_busy") => void) | null = null;
      return {
        onStateChange: vi.fn((cb) => { listener = cb; }),
        start: vi.fn(async () => {
          listener?.("operator_busy");
          throw new Error("operator_busy");
        }),
        mute: vi.fn(),
        hold: vi.fn(),
        hangup: vi.fn(),
      };
    });
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have an active Jitter call.");
    expect(screen.queryByTestId("dispo-notes")).not.toBeInTheDocument();
  });

  it("still reaches failed wrap-up when sequence resume loses its response", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    resumeFailedSoftphoneCall.mockRejectedValueOnce(new Error("response lost"));
    prepareLeadCall.mockResolvedValue({
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
    createTransport.mockImplementation(() => {
      let listener: ((state: "connecting" | "failed") => void) | null = null;
      return {
        onStateChange: vi.fn((cb) => { listener = cb; }),
        start: vi.fn(async () => {
          listener?.("connecting");
          listener?.("failed");
          throw new Error("Microphone access is required to place calls.");
        }),
        mute: vi.fn(),
        hold: vi.fn(),
        hangup: vi.fn(async () => ({ durationSeconds: 0, outcome: "failed" as const })),
      };
    });
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    expect(await screen.findByTestId("dispo-notes")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone access is required to place calls.");
  });

  it("shows a blocking warning when Jitter teardown is still unconfirmed", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    prepareLeadCall.mockResolvedValue({
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
    createTransport.mockImplementation(() => {
      let listener: ((state: "connecting" | "live" | "ended" | "teardown_unconfirmed" | "teardown_confirmed") => void) | null = null;
      let hangupAttempts = 0;
      return {
        onStateChange: vi.fn((cb) => { listener = cb; }),
        start: vi.fn(async () => {
          listener?.("connecting");
          listener?.("live");
          return { id: "jitter-call" };
        }),
        mute: vi.fn(),
        hold: vi.fn(),
        hangup: vi.fn(async () => {
          hangupAttempts += 1;
          listener?.(hangupAttempts === 1 ? "teardown_unconfirmed" : "teardown_confirmed");
          return { durationSeconds: 2, outcome: "failed" as const };
        }),
      };
    });
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );

    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(screen.getByTestId("call-live-pill")).toHaveTextContent("Live"));
    await user.click(screen.getByTestId("call-hangup"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Jitter could not confirm that the call ended. Do not start another call yet",
    );
    await user.type(screen.getByTestId("dispo-notes"), "Left voicemail");
    expect(screen.getByTestId("dispo-not-interested")).toBeDisabled();
    await user.click(screen.getByTestId("retry-jitter-teardown"));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByTestId("dispo-not-interested")).toBeEnabled();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders call buttons disabled with the production-safe message when the gate is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "");
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneHeaderButton />
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );

    const leadCall = screen.getByTestId("call-lead-button");
    expect(leadCall).toBeDisabled();
    expect(leadCall).toHaveAttribute("title", "Calling not yet enabled");

    await user.click(screen.getByTestId("header-dialer-button"));
    expect(screen.getByText("Calling not yet enabled")).toBeVisible();
    await user.type(screen.getByTestId("dialer-input"), "8165550123");

    const manualCall = screen.getByTestId("dialer-call-manual");
    expect(manualCall).toBeDisabled();
    expect(manualCall).toHaveAttribute("title", "Calling not yet enabled");
  });

  it("keeps one wrap token and re-enables retry after a lost completion response", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    prepareLeadCall.mockResolvedValue({
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
    completeSoftphoneCall
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ok: true, data: { activityId: "activity-1", callbackTaskId: "task-1" } });
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );

    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(screen.getByTestId("call-live-pill")).toHaveTextContent("Live"));
    await user.click(screen.getByTestId("call-hangup"));
    await user.type(screen.getByTestId("dispo-notes"), "Call back tomorrow");

    const disposition = screen.getByTestId("dispo-not-interested");
    await user.click(disposition);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not confirm the call was saved. Try again.");
    expect(disposition).toBeEnabled();

    await user.click(disposition);
    await waitFor(() => expect(completeSoftphoneCall).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("softphone-popover")).not.toBeInTheDocument());

    const firstToken = completeSoftphoneCall.mock.calls[0][0].wrapToken;
    const retryToken = completeSoftphoneCall.mock.calls[1][0].wrapToken;
    expect(firstToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(retryToken).toBe(firstToken);
    expect(createTransport.mock.results[0].value.start).toHaveBeenCalledWith(
      expect.objectContaining({ callToken: firstToken }),
    );
  });

  it("keeps a connecting call reachable and uses the transport's remote-end result", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    const listener: { current: ((state: "connecting" | "ringing" | "live" | "ended" | "failed") => void) | null } = { current: null };
    let resolveStart!: (value: { id: string }) => void;
    const hangup = vi.fn(async () => ({ durationSeconds: 7, outcome: "connected_human" as const }));
    createTransport.mockReturnValue({
      onStateChange: vi.fn((cb) => { listener.current = cb; }),
      start: vi.fn(() => new Promise<{ id: string }>((resolve) => { resolveStart = resolve; })),
      mute: vi.fn(),
      hold: vi.fn(),
      hangup,
    });
    prepareLeadCall.mockResolvedValue({
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
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneLeadButton
          lead={{
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
          }}
        />
      </SoftphoneProvider>,
    );
    await user.click(screen.getByTestId("call-lead-button"));
    await waitFor(() => expect(createTransport).toHaveBeenCalledTimes(1));
    act(() => listener.current?.("connecting"));
    expect(await screen.findByTestId("call-live-pill")).toHaveTextContent("Connecting");
    await user.click(screen.getByLabelText("Close dialer"));
    expect(screen.getByTestId("softphone-popover")).toBeVisible();
    await user.click(screen.getByTestId("call-lead-button"));
    expect(createTransport).toHaveBeenCalledTimes(1);
    act(() => {
      listener.current?.("live");
      listener.current?.("ended");
    });
    await waitFor(() => expect(hangup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Call ended · 00:07")).toBeVisible();
    resolveStart({ id: "session-1" });
  });
});
