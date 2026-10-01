import { describe, expect, it } from "vitest";

import { resolveCallingConfig } from "./config";

const FULL = {
  DIRECT_CALL_PILOT_USER_IDS: "pilot-1, Pilot-2",
  TELNYX_DIRECT_API_KEY: "k",
  TELNYX_DIRECT_CONNECTION_ID: "c",
  TELNYX_DIRECT_APP_ID: "a",
  TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY: "p",
  DIRECT_CALL_CALLER_ID_E164: "+15550002222",
  DIRECT_CALL_CONTAINMENT_VERIFIED: "true",
};

describe("resolveCallingConfig", () => {
  it("enables telnyx_direct only for pilot users with full env", () => {
    expect(resolveCallingConfig("pilot-1", FULL)).toEqual({ transport: "telnyx_direct" });
    expect(resolveCallingConfig("pilot-2", FULL)).toEqual({ transport: "telnyx_direct" });
  });
  it("is default for non-pilot, anonymous, or empty allowlist", () => {
    expect(resolveCallingConfig("someone", FULL)).toEqual({ transport: "default" });
    expect(resolveCallingConfig(null, FULL)).toEqual({ transport: "default" });
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_PILOT_USER_IDS: "" })).toEqual({ transport: "default" });
  });
  it("is default when any env var is missing or the caller ID is not E.164", () => {
    for (const key of Object.keys(FULL).filter((k) => k !== "DIRECT_CALL_PILOT_USER_IDS")) {
      expect(resolveCallingConfig("pilot-1", { ...FULL, [key]: undefined })).toEqual({ transport: "default" });
    }
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CALLER_ID_E164: "5550002222" })).toEqual({ transport: "default" });
  });
  it("fails closed unless containment is verified", () => {
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CONTAINMENT_VERIFIED: undefined })).toEqual({ transport: "default" });
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CONTAINMENT_VERIFIED: "false" })).toEqual({ transport: "default" });
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CONTAINMENT_VERIFIED: "TRUE" })).toEqual({ transport: "default" });
  });
});
