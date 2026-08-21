import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareLeadCall: vi.fn(),
  prepareManualCall: vi.fn(),
  getUser: vi.fn(),
  getCallerMemberships: vi.fn(),
  requestStart: vi.fn(),
  requestToken: vi.fn(),
  requestConnect: vi.fn(),
  requestCancel: vi.fn(),
}));

vi.mock("@/lib/dialer/actions", () => ({
  prepareLeadCall: mocks.prepareLeadCall,
  prepareManualCall: mocks.prepareManualCall,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/lib/auth/memberships", () => ({
  getCallerMemberships: mocks.getCallerMemberships,
}));

vi.mock("./jitter-contract", async (importOriginal) => ({
  ...await importOriginal<typeof import("./jitter-contract")>(),
  requestJitterStartCall: mocks.requestStart,
  requestJitterToken: mocks.requestToken,
  requestJitterConnect: mocks.requestConnect,
  requestJitterCancel: mocks.requestCancel,
}));

import {
  cancelAuthenticatedJitterCall,
  connectAuthenticatedJitterCall,
  getAuthenticatedJitterToken,
  startAuthenticatedJitterCall,
} from "./jitter-server";

const SANDRA_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

const preparedTarget = {
  propertyId: "property-1",
  contactId: "contact-1",
  phoneE164: "+18165550123",
  maskedPhone: "(816) 555-0123",
  name: "Lead One",
  address: "1 Main St",
  state: "MO",
  startedAt: "2026-08-21T20:00:00.000Z",
};

describe("authenticated Jitter softphone server boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", "test-service-token");
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "Operator@Example.Test" } },
      error: null,
    });
    mocks.getCallerMemberships.mockResolvedValue([{ user_id: "user-1", org_id: SANDRA_ORG_ID, role: "member" }]);
    mocks.prepareLeadCall.mockResolvedValue({ ok: true, data: preparedTarget });
    mocks.prepareManualCall.mockResolvedValue({ ok: true, data: { ...preparedTarget, propertyId: null, contactId: null } });
    mocks.requestStart.mockResolvedValue({ ok: true, data: { sessionRef: "session-1", batchId: "batch-1" } });
    mocks.requestToken.mockResolvedValue({
      ok: true,
      data: { rtcToken: "token", sipIdentity: "operator-1", expiresAt: "2026-08-21T20:05:00.000Z" },
    });
    mocks.requestConnect.mockResolvedValue({ ok: true, data: { dialing: true } });
    mocks.requestCancel.mockResolvedValue({ ok: true, data: { tornDown: true } });
  });

  it("authorizes active Sandra access before eligibility, then calls Jitter", async () => {
    const result = await startAuthenticatedJitterCall({
      phoneE164: "+18165550123",
      propertyId: "property-1",
      contactId: "contact-1",
    });
    expect(result).toMatchObject({ ok: true, data: { batchId: "batch-1" } });
    if (!result.ok) throw new Error("expected successful start");
    expect(result.data.sessionRef).toMatch(/^v1\./);

    expect(mocks.prepareLeadCall).toHaveBeenCalledWith("property-1");
    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepareLeadCall.mock.invocationCallOrder[0]);
    expect(mocks.getCallerMemberships.mock.invocationCallOrder[0]).toBeLessThan(mocks.prepareLeadCall.mock.invocationCallOrder[0]);
    expect(mocks.requestStart).toHaveBeenCalledWith({
      operatorEmail: "operator@example.test",
      phoneE164: "+18165550123",
      propertyRef: "property-1",
      contactRef: "contact-1",
    });
  });

  it("fails locally with the pinned 422 envelope before any Jitter provisioning", async () => {
    mocks.prepareLeadCall.mockResolvedValue({ ok: false, error: "Calling is unavailable during quiet hours." });
    await expect(startAuthenticatedJitterCall({
      phoneE164: "+18165550123",
      propertyId: "property-1",
      contactId: "contact-1",
    })).resolves.toEqual({
      ok: false,
      status: 422,
      error: "Calling is unavailable during quiet hours.",
      errorCode: "not_callable",
      reason: "Calling is unavailable during quiet hours.",
    });
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("rejects a browser-swapped target after the eligibility read", async () => {
    await expect(startAuthenticatedJitterCall({
      phoneE164: "+18165559999",
      propertyId: "property-1",
      contactId: "contact-1",
    })).resolves.toMatchObject({ ok: false, status: 422, errorCode: "not_callable", reason: "target_changed" });
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("authenticates every follow-up and opens only the caller-bound session capability", async () => {
    const started = await startAuthenticatedJitterCall({ phoneE164: "+18165550123" });
    if (!started.ok) throw new Error("expected successful start");
    const capability = started.data.sessionRef;
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "operator@example.test" } }, error: null });
    mocks.getCallerMemberships.mockResolvedValue([{ user_id: "user-1", org_id: SANDRA_ORG_ID, role: "member" }]);
    mocks.requestToken.mockResolvedValue({ ok: true, data: { rtcToken: "token", sipIdentity: "operator-1", expiresAt: "2026-08-21T20:05:00.000Z" } });
    mocks.requestConnect.mockResolvedValue({ ok: true, data: { dialing: true } });
    mocks.requestCancel.mockResolvedValue({ ok: true, data: { tornDown: true } });
    await getAuthenticatedJitterToken(capability);
    await connectAuthenticatedJitterCall(capability);
    await cancelAuthenticatedJitterCall(capability, "failed");
    expect(mocks.getUser).toHaveBeenCalledTimes(3);
    expect(mocks.requestToken).toHaveBeenCalledWith("session-1");
    expect(mocks.requestConnect).toHaveBeenCalledWith("session-1");
    expect(mocks.requestCancel).toHaveBeenCalledWith("session-1", "failed");
  });

  it("denies users without current Sandra membership before eligibility or provider work", async () => {
    mocks.getCallerMemberships.mockResolvedValue([]);
    await expect(startAuthenticatedJitterCall({ phoneE164: "+18165550123" })).resolves.toMatchObject({
      ok: false,
      status: 403,
      errorCode: "forbidden",
    });
    expect(mocks.prepareManualCall).not.toHaveBeenCalled();
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("denies a caller whose active membership belongs to a different organization", async () => {
    mocks.getCallerMemberships.mockResolvedValue([{ user_id: "user-1", org_id: "other-org", role: "member" }]);
    await expect(startAuthenticatedJitterCall({ phoneE164: "+18165550123" })).resolves.toMatchObject({
      ok: false,
      status: 403,
      errorCode: "forbidden",
    });
    expect(mocks.prepareManualCall).not.toHaveBeenCalled();
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("rejects malformed direct Server Action payloads without throwing", async () => {
    await expect(startAuthenticatedJitterCall(null)).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(getAuthenticatedJitterToken(42)).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(cancelAuthenticatedJitterCall({}, "invalid")).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a valid capability when a different Sandra user presents it", async () => {
    const started = await startAuthenticatedJitterCall({ phoneE164: "+18165550123" });
    if (!started.ok) throw new Error("expected successful start");
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-2", email: "other@example.test" } }, error: null });
    mocks.getCallerMemberships.mockResolvedValue([{ user_id: "user-2", org_id: SANDRA_ORG_ID, role: "member" }]);
    await expect(getAuthenticatedJitterToken(started.data.sessionRef)).resolves.toMatchObject({
      ok: false,
      status: 400,
      errorCode: "invalid_request",
    });
    expect(mocks.requestToken).not.toHaveBeenCalled();
  });
});
