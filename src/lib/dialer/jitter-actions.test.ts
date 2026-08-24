import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCallerIds } = vi.hoisted(() => ({
  getCallerIds: vi.fn(),
}));

vi.mock("./jitter-server", () => ({
  cancelAuthenticatedJitterCall: vi.fn(),
  connectAuthenticatedJitterCall: vi.fn(),
  getAuthenticatedJitterCallerIds: getCallerIds,
  getAuthenticatedJitterToken: vi.fn(),
  reportAuthenticatedJitterAudioHealth: vi.fn(),
  sendAuthenticatedJitterDigit: vi.fn(),
  startAuthenticatedJitterCall: vi.fn(),
}));

import { loadJitterSoftphoneCallerIds } from "./jitter-actions";

describe("loadJitterSoftphoneCallerIds", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    getCallerIds.mockReset();
  });

  it("provides a bounded fake company number for the simulated transport", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "simulated");
    vi.stubEnv("NODE_ENV", "test");

    await expect(loadJitterSoftphoneCallerIds()).resolves.toEqual({
      ok: true,
      data: {
        caller_ids: [
          { phone_e164: "+18165550100", label: "Simulated company number" },
        ],
      },
    });
    expect(getCallerIds).not.toHaveBeenCalled();
  });

  it("keeps real inventory fail-closed outside the simulated transport", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOFTPHONE_TRANSPORT", "jitter");
    getCallerIds.mockResolvedValue({
      ok: true,
      data: { caller_ids: [{ phone_e164: "+18165550199", label: "Main" }] },
    });

    await expect(loadJitterSoftphoneCallerIds()).resolves.toEqual({
      ok: true,
      data: { caller_ids: [{ phone_e164: "+18165550199", label: "Main" }] },
    });
    expect(getCallerIds).toHaveBeenCalledOnce();
  });
});
