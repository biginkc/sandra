import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, getCallerMembershipsOrThrow } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getCallerMembershipsOrThrow: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow }));
vi.mock("@/lib/dialer/actions", () => ({
  prepareLeadCall: vi.fn(),
  prepareManualCall: vi.fn(),
  resumeFailedSoftphoneCall: vi.fn(),
}));
vi.mock("@/lib/dialer/call-capability", () => ({ capabilityKey: vi.fn(() => null) }));
vi.mock("@/lib/dialer/homeowner-training", () => ({ isHomeownerTrainingNumber: vi.fn(() => false) }));
vi.mock("@/lib/dialer/jitter-server", () => ({ sealCallCapability: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("./telnyx", () => ({
  telnyxCreateCredential: vi.fn(),
  telnyxCreateToken: vi.fn(),
  telnyxDial: vi.fn(),
  telnyxGetCallAlive: vi.fn(),
  telnyxHangup: vi.fn(),
  telnyxListActiveCalls: vi.fn(),
  telnyxSendDtmf: vi.fn(),
}));

import { controlDirectCall, getCallingConfigForCurrentUser, getDirectRtcToken, startDirectCall } from "./actions";

const USER_ID = "b480bc44-8ee6-4ab8-a8c9-f88373cf7fe5";
const SANDRA_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const fullEnv = {
  TELNYX_DIRECT_API_KEY: "key",
  TELNYX_DIRECT_CONNECTION_ID: "connection",
  TELNYX_DIRECT_APP_ID: "app",
  TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY: "webhook",
  DIRECT_CALL_CALLER_ID_E164: "+15550002222",
  DIRECT_CALL_CONTAINMENT_VERIFIED: "true",
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(fullEnv)) vi.stubEnv(key, value);
  createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null }) } });
  getCallerMembershipsOrThrow.mockResolvedValue([{
    user_id: USER_ID,
    org_id: SANDRA_ORG_ID,
    role: "owner",
    acquisitions_enabled: true,
    access_status: "active",
    access_expires_at: null,
    deletion_prepared_at: null,
  }]);
});

describe("direct calling server authorization", () => {
  it("enables the verified Acquisitions owner without an individual allowlist", async () => {
    await expect(getCallingConfigForCurrentUser()).resolves.toEqual({ transport: "telnyx_direct" });
    expect(getCallerMembershipsOrThrow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong org", { org_id: "other-org" }],
    ["inactive", { access_status: "suspended" }],
    ["not Acquisitions", { acquisitions_enabled: false }],
  ])("fails closed for %s", async (_label, override) => {
    getCallerMembershipsOrThrow.mockResolvedValueOnce([{
      user_id: USER_ID,
      org_id: SANDRA_ORG_ID,
      role: "owner",
      acquisitions_enabled: true,
      access_status: "active",
      access_expires_at: null,
      deletion_prepared_at: null,
      ...override,
    }]);
    await expect(getCallingConfigForCurrentUser()).resolves.toEqual({ transport: "default" });
  });

  it("applies the same membership denial before token, start, and DTMF actions", async () => {
    getCallerMembershipsOrThrow.mockResolvedValue([{
      user_id: USER_ID,
      org_id: SANDRA_ORG_ID,
      role: "owner",
      acquisitions_enabled: true,
      access_status: "suspended",
      access_expires_at: null,
      deletion_prepared_at: null,
    }]);

    await expect(getCallingConfigForCurrentUser()).resolves.toEqual({ transport: "default" });
    await expect(getDirectRtcToken()).resolves.toMatchObject({ ok: false, errorCode: "forbidden" });
    await expect(startDirectCall({
      kind: "manual",
      phone: "55500002222",
      clientRequestId: "11111111-1111-4111-8111-111111111111",
    })).resolves.toMatchObject({ ok: false, errorCode: "forbidden", reserved: false });
    await expect(controlDirectCall("11111111-1111-4111-8111-111111111111", { action: "dtmf", digit: "1" }))
      .resolves.toMatchObject({ ok: false, errorCode: "forbidden" });
  });

  it("fails closed when membership verification errors or the caller is anonymous", async () => {
    getCallerMembershipsOrThrow.mockRejectedValueOnce(new Error("membership lookup failed"));
    await expect(getCallingConfigForCurrentUser()).resolves.toEqual({ transport: "default" });
    createClient.mockResolvedValueOnce({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) } });
    await expect(getCallingConfigForCurrentUser()).resolves.toEqual({ transport: "default" });
    expect(getCallerMembershipsOrThrow).toHaveBeenCalledTimes(1);
  });
});
