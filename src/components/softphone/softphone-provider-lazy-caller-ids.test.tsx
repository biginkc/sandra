import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCallerIds: vi.fn(),
  loadDialerRecents: vi.fn(),
}));

vi.mock("@/lib/dialer/actions", () => ({
  completeSoftphoneCall: vi.fn(),
  loadDialerRecents: mocks.loadDialerRecents,
  prepareLeadCall: vi.fn(),
  prepareManualCall: vi.fn(),
  resumeFailedSoftphoneCall: vi.fn(),
  searchDialerLeads: vi.fn(async () => ({ ok: true, data: [] })),
}));

vi.mock("@/lib/dialer/jitter-actions", () => ({
  loadJitterSoftphoneCallerIds: mocks.loadCallerIds,
  mintJitterStartIntent: vi.fn(),
}));

vi.mock("@/lib/dialer/transport-selection", () => ({
  createSoftphoneCallTransport: vi.fn(),
  isJitterTransportEnabled: vi.fn(() => false),
  isSoftphoneTransportEnabled: vi.fn(() => true),
}));

vi.mock("@/lib/coach/flags", () => ({
  isCoachUiEnabled: vi.fn(() => false),
}));

vi.mock("@/lib/coach/use-coach-session", () => ({
  useCoachSession: vi.fn(() => ({})),
}));

vi.mock("@/components/coach/coach-live-view", () => ({
  CoachLiveView: () => null,
}));

import { SoftphoneHeaderButton, SoftphoneProvider } from "./softphone-provider";

describe("SoftphoneProvider caller-ID loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.loadDialerRecents.mockResolvedValue({ ok: true, data: [] });
    mocks.loadCallerIds.mockResolvedValue({
      ok: true,
      data: {
        caller_ids: [{ phone_e164: "+18165550100", label: "Main" }],
      },
    });
  });

  it("waits until the dialer opens before loading company caller IDs", async () => {
    const user = userEvent.setup();
    render(
      <SoftphoneProvider>
        <SoftphoneHeaderButton />
      </SoftphoneProvider>,
    );

    await Promise.resolve();
    expect(mocks.loadCallerIds).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("header-dialer-button"));

    await waitFor(() => expect(mocks.loadCallerIds).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("caller-id-readonly")).toHaveTextContent(
      "Main",
    );

    await user.click(screen.getByLabelText("Close dialer"));
    await user.click(screen.getByTestId("header-dialer-button"));

    expect(mocks.loadCallerIds).toHaveBeenCalledOnce();
  });
});
