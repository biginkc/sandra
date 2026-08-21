import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeSoftphoneCall, loadDialerRecents, prepareLeadCall, createTransport, transportEnabled } = vi.hoisted(() => ({
  completeSoftphoneCall: vi.fn(),
  loadDialerRecents: vi.fn(async () => ({ ok: true, data: [] })),
  prepareLeadCall: vi.fn(),
  createTransport: vi.fn(),
  transportEnabled: vi.fn(),
}));

vi.mock("@/lib/dialer/actions", () => ({
  completeSoftphoneCall,
  loadDialerRecents,
  prepareLeadCall,
  prepareManualCall: vi.fn(),
  resumeFailedSoftphoneCall: vi.fn(),
  searchDialerLeads: vi.fn(),
}));

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
        hangup: vi.fn(async () => {
          listener?.("ended");
          return { durationSeconds: 1, outcome: "connected_human" as const };
        }),
      };
    });
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
