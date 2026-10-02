import { describe, expect, it } from "vitest";

import type { Membership } from "@/lib/auth/memberships";
import { isDirectCallEligibleMembership, readDirectCallTimeLimitSecs, resolveCallingConfig } from "./config";

const FULL = {
  TELNYX_DIRECT_API_KEY: "k",
  TELNYX_DIRECT_CONNECTION_ID: "c",
  TELNYX_DIRECT_APP_ID: "a",
  TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY: "p",
  DIRECT_CALL_CALLER_ID_E164: "+15550002222",
  DIRECT_CALL_CONTAINMENT_VERIFIED: "true",
};

const ACTIVE_ACQUISITIONS: Membership = {
  user_id: "pilot-1",
  org_id: "00000000-0000-0000-0000-000000000bbb",
  role: "owner",
  acquisitions_enabled: true,
  access_status: "active",
  access_expires_at: null,
  deletion_prepared_at: null,
};

describe("resolveCallingConfig", () => {
  it("enables telnyx_direct only after server-verified eligibility with full env", () => {
    expect(resolveCallingConfig("pilot-1", FULL, true)).toEqual({ transport: "telnyx_direct" });
  });
  it("is default for an unverified, anonymous, or unknown caller", () => {
    expect(resolveCallingConfig("pilot-1", FULL)).toEqual({ transport: "default" });
    expect(resolveCallingConfig("someone", FULL, false)).toEqual({ transport: "default" });
    expect(resolveCallingConfig(null, FULL, true)).toEqual({ transport: "default" });
  });
  it("is default when any env var is missing or the caller ID is not E.164", () => {
    for (const key of Object.keys(FULL)) {
      expect(resolveCallingConfig("pilot-1", { ...FULL, [key]: undefined }, true)).toEqual({ transport: "default" });
    }
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CALLER_ID_E164: "5550002222" }, true)).toEqual({ transport: "default" });
  });
  it("fails closed unless containment is verified", () => {
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CONTAINMENT_VERIFIED: undefined }, true)).toEqual({ transport: "default" });
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CONTAINMENT_VERIFIED: "false" }, true)).toEqual({ transport: "default" });
    expect(resolveCallingConfig("pilot-1", { ...FULL, DIRECT_CALL_CONTAINMENT_VERIFIED: "TRUE" }, true)).toEqual({ transport: "default" });
  });

  it("requires the active Acquisitions designation for Sandra org, including owners", () => {
    expect(isDirectCallEligibleMembership("pilot-1", [ACTIVE_ACQUISITIONS])).toBe(true);
    expect(isDirectCallEligibleMembership("pilot-1", [{ ...ACTIVE_ACQUISITIONS, acquisitions_enabled: false }])).toBe(false);
    expect(isDirectCallEligibleMembership("pilot-1", [{ ...ACTIVE_ACQUISITIONS, access_status: "suspended" }])).toBe(false);
    expect(isDirectCallEligibleMembership("pilot-1", [{ ...ACTIVE_ACQUISITIONS, org_id: "other-org" }])).toBe(false);
    expect(isDirectCallEligibleMembership("pilot-1", [{ ...ACTIVE_ACQUISITIONS, access_status: undefined }])).toBe(false);
  });

  it("accepts only explicit bounded pilot limits and keeps the default at 7200 when absent", () => {
    expect(readDirectCallTimeLimitSecs(FULL)).toBe(7200);
    for (const value of ["30", "60", "120", "180"]) {
      expect(readDirectCallTimeLimitSecs({ ...FULL, DIRECT_CALL_TIME_LIMIT_SECS: value })).toBe(Number(value));
    }
    for (const value of ["0", "29", "181", "7200", "1.5", "abc", "  "]) {
      const env = { ...FULL, DIRECT_CALL_TIME_LIMIT_SECS: value };
      expect(readDirectCallTimeLimitSecs(env)).toBeNull();
      expect(resolveCallingConfig("pilot-1", env, true)).toEqual({ transport: "default" });
    }
  });
});
