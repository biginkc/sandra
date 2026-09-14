import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mariaCtiConfig } from "./cti-config";
const viewer = { orgId: "00000000-0000-0000-0000-000000000bbb", userId: "maria-actor" };
beforeEach(() => {
  for (const [key, value] of Object.entries({ DIALPAD_CTI_ENABLED: "true", DIALPAD_CTI_CLIENT_ID: "issued-client", DIALPAD_VOICE_ORG_ID: viewer.orgId, DIALPAD_VOICE_SANDRA_USER_ID: viewer.userId, DIALPAD_VOICE_USER_ID: "4904023124647936", DIALPAD_VOICE_API_KEY: "must-not-cross-browser-boundary" })) vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());
describe("Maria CTI server gate", () => {
  it("returns only public client configuration to the matching rep", () => {
    expect(mariaCtiConfig(viewer)).toEqual({ clientId: "issued-client", expectedUserId: "4904023124647936" });
  });
  it("stays absent while disabled or unprovisioned", () => {
    vi.stubEnv("DIALPAD_CTI_ENABLED", "false"); expect(mariaCtiConfig(viewer)).toBeNull();
    vi.stubEnv("DIALPAD_CTI_ENABLED", "true"); vi.stubEnv("DIALPAD_CTI_CLIENT_ID", ""); expect(mariaCtiConfig(viewer)).toBeNull();
  });
  it("rejects unauthenticated, different rep, and different organization", () => {
    expect(mariaCtiConfig(null)).toBeNull();
    expect(mariaCtiConfig({ ...viewer, userId: "other" })).toBeNull();
    expect(mariaCtiConfig({ ...viewer, orgId: "other" })).toBeNull();
  });
  it("refuses another provider identity or path injection", () => {
    vi.stubEnv("DIALPAD_VOICE_USER_ID", "other"); expect(mariaCtiConfig(viewer)).toBeNull();
    vi.stubEnv("DIALPAD_VOICE_USER_ID", "4904023124647936"); vi.stubEnv("DIALPAD_CTI_CLIENT_ID", "../login?key=secret"); expect(mariaCtiConfig(viewer)).toBeNull();
  });
});
