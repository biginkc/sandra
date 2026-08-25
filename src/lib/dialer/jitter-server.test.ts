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
  requestCancelByKey: vi.fn(),
  requestAudioHealth: vi.fn(),
  requestCallerIds: vi.fn(),
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
  ...(await importOriginal<typeof import("./jitter-contract")>()),
  requestJitterStartCall: mocks.requestStart,
  requestJitterToken: mocks.requestToken,
  requestJitterConnect: mocks.requestConnect,
  requestJitterCancel: mocks.requestCancel,
  requestJitterCancelByIdempotencyKey: mocks.requestCancelByKey,
  requestJitterAudioHealth: mocks.requestAudioHealth,
  requestJitterCallerIds: mocks.requestCallerIds,
}));

import {
  cancelAuthenticatedJitterCall,
  connectAuthenticatedJitterCall,
  getAuthenticatedJitterToken,
  reportAuthenticatedJitterAudioHealth,
  startAuthenticatedJitterCall,
  mintStartIntent,
  cancelJitterCallByStartIntent,
  getAuthenticatedJitterCallerIds,
} from "./jitter-server";

const SANDRA_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const CALL_ID = "00000000-0000-4000-8000-000000000011";
const OLD_CAPABILITY_KEY = `v1:${"o".repeat(48)}`;
const NEW_CAPABILITY_KEY = `v1:${"n".repeat(48)}`;

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

const cancelData = {
  call_id: CALL_ID,
  session_id: "session-1",
  status: "ended" as const,
  teardown: {
    released_batch_claims: 1,
    revoked_bindings: 1,
    revoked_device_leases: 1,
    ended_shifts: 1,
    released_worker_leases: 1,
  },
};

let START_INTENT = "";
let START_CALL_TOKEN = "";

function callTarget(overrides: Record<string, unknown> = {}) {
  return {
    phoneE164: "+18165550123",
    callerIdE164: "+18165550100",
    callToken: START_CALL_TOKEN,
    intentCapability: START_INTENT,
    ...overrides,
  };
}

describe("authenticated Jitter softphone server boundary", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("JITTER_SOFTPHONE_SERVICE_TOKEN", "test-service-token");
    vi.stubEnv("SOFTPHONE_CAPABILITY_KEY", OLD_CAPABILITY_KEY);
    vi.stubEnv("SOFTPHONE_CAPABILITY_KEY_PREVIOUS", "");
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "Operator@Example.Test" } },
      error: null,
    });
    mocks.getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: SANDRA_ORG_ID, role: "member" },
    ]);
    mocks.prepareLeadCall.mockResolvedValue({ ok: true, data: preparedTarget });
    mocks.prepareManualCall.mockResolvedValue({
      ok: true,
      data: { ...preparedTarget, propertyId: null, contactId: null },
    });
    mocks.requestStart.mockResolvedValue({
      ok: true,
      data: {
        call_id: CALL_ID,
        session_id: "session-1",
        batch_id: "batch-1",
        run_id: "run-1",
      },
    });
    mocks.requestToken.mockResolvedValue({
      ok: true,
      data: {
        rtc_token: "token",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:05:00.000Z",
      },
    });
    mocks.requestConnect.mockResolvedValue({
      ok: true,
      data: { dialing: true },
    });
    mocks.requestCancel.mockResolvedValue({ ok: true, data: cancelData });
    mocks.requestCancelByKey.mockResolvedValue({ ok: true, data: cancelData });
    mocks.requestAudioHealth.mockResolvedValue({
      ok: true,
      data: { accepted: true, status: "healthy" },
    });
    mocks.requestCallerIds.mockResolvedValue({
      ok: true,
      data: { caller_ids: [{ phone_e164: "+18165550100", label: "Main" }] },
    });
    const minted = await mintStartIntent();
    if (!minted.ok) throw new Error("expected start intent mint");
    START_INTENT = minted.data.intentCapability;
    START_CALL_TOKEN = minted.data.callToken;
    vi.clearAllMocks();
  });

  it("authorizes active Sandra access and sends the selected caller ID", async () => {
    const result = await startAuthenticatedJitterCall(
      callTarget({
        propertyId: "property-1",
        contactId: "contact-1",
        callerIdE164: "+18165550100",
      }),
    );
    expect(result).toMatchObject({ ok: true, data: { batchId: "batch-1" } });
    if (!result.ok) throw new Error("expected successful start");
    expect(result.data.callId).toMatch(/^v1\./);

    expect(mocks.prepareLeadCall).toHaveBeenCalledWith("property-1");
    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareLeadCall.mock.invocationCallOrder[0],
    );
    expect(mocks.getCallerMemberships.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.prepareLeadCall.mock.invocationCallOrder[0],
    );
    expect(mocks.requestStart).toHaveBeenCalledWith(
      {
        operator_id: "user-1",
        phone_e164: "+18165550123",
        timezone: "America/Chicago",
        caller_id_e164: "+18165550100",
      },
      START_CALL_TOKEN,
    );
  });

  it("mints the idempotency key server-side and returns a caller-bound intent", async () => {
    const first = await mintStartIntent();
    const second = await mintStartIntent();
    expect(first).toMatchObject({ ok: true, data: { intentCapability: expect.stringMatching(/^v1\./) } });
    expect(second).toMatchObject({ ok: true, data: { intentCapability: expect.stringMatching(/^v1\./) } });
    if (!first.ok || !second.ok) throw new Error("expected minted intents");
    expect(first.data.callToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.data.callToken).not.toBe(second.data.callToken);
  });

  it("cancels by intent, rejects cross-operator use, and refuses capability type confusion", async () => {
    const started = await startAuthenticatedJitterCall(
      callTarget({ propertyId: "property-1", contactId: "contact-1" }),
    );
    if (!started.ok) throw new Error("expected successful start");

    await expect(
      cancelJitterCallByStartIntent(START_INTENT, "abandoned"),
    ).resolves.toMatchObject({ ok: true });
    expect(mocks.requestCancelByKey).toHaveBeenCalledWith(
      START_CALL_TOKEN,
      "abandoned",
    );

    await expect(
      cancelAuthenticatedJitterCall(START_INTENT, "abandoned"),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      cancelJitterCallByStartIntent(started.data.callId, "abandoned"),
    ).resolves.toMatchObject({ ok: false, status: 400 });

    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-2" } },
      error: null,
    });
    mocks.getCallerMemberships.mockResolvedValue([
      { user_id: "user-2", org_id: SANDRA_ORG_ID, role: "member" },
    ]);
    await expect(
      cancelJitterCallByStartIntent(START_INTENT, "abandoned"),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    expect(mocks.requestCancelByKey).toHaveBeenCalledTimes(1);
  });

  it("authenticates caller-ID inventory reads before contacting Jitter", async () => {
    await expect(getAuthenticatedJitterCallerIds()).resolves.toEqual({
      ok: true,
      data: { caller_ids: [{ phone_e164: "+18165550100", label: "Main" }] },
    });
    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requestCallerIds.mock.invocationCallOrder[0],
    );
  });

  it("requires an E.164 caller ID before eligibility or provisioning", async () => {
    await expect(startAuthenticatedJitterCall(callTarget({ callerIdE164: undefined }))).resolves.toMatchObject({
      ok: false,
      status: 400,
      errorCode: "invalid_request",
    });
    expect(mocks.prepareManualCall).not.toHaveBeenCalled();
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("fails locally with a distinct 422 not_callable result before Jitter provisioning", async () => {
    mocks.prepareLeadCall.mockResolvedValue({
      ok: false,
      error: "Calling is unavailable during quiet hours.",
    });
    await expect(
      startAuthenticatedJitterCall(
        callTarget({
          propertyId: "property-1",
          contactId: "contact-1",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      error: "Calling is unavailable during quiet hours.",
      errorCode: "not_callable",
      reason: "Calling is unavailable during quiet hours.",
    });
    expect(mocks.getUser).toHaveBeenCalledTimes(1);
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("refuses the fabricated Missouri timezone for an unlinked manual number", async () => {
    await expect(
      startAuthenticatedJitterCall(callTarget()),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      errorCode: "not_callable",
      reason: "timezone_unverified",
    });
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("refuses to guess a timezone when a linked lead has no supported state", async () => {
    mocks.prepareManualCall.mockResolvedValue({
      ok: true,
      data: { ...preparedTarget, state: null },
    });
    await expect(
      startAuthenticatedJitterCall(callTarget()),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      errorCode: "not_callable",
      reason: "timezone_unavailable",
    });
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("rejects a browser-swapped target after the eligibility read", async () => {
    await expect(
      startAuthenticatedJitterCall(
        callTarget({
          phoneE164: "+18165559999",
          propertyId: "property-1",
          contactId: "contact-1",
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 422,
      errorCode: "not_callable",
      reason: "target_changed",
    });
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("authenticates every follow-up and opens only the caller-bound call capability", async () => {
    const started = await startAuthenticatedJitterCall(
      callTarget({ propertyId: "property-1", contactId: "contact-1" }),
    );
    if (!started.ok) throw new Error("expected successful start");
    const capability = started.data.callId;
    vi.clearAllMocks();
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-1" } },
      error: null,
    });
    mocks.getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: SANDRA_ORG_ID, role: "member" },
    ]);
    mocks.requestToken.mockResolvedValue({
      ok: true,
      data: {
        rtc_token: "token",
        sip_identity: "operator-1",
        expires_at: "2026-08-21T20:05:00.000Z",
      },
    });
    mocks.requestConnect.mockResolvedValue({
      ok: true,
      data: { dialing: true },
    });
    mocks.requestCancel.mockResolvedValue({ ok: true, data: cancelData });
    mocks.requestAudioHealth.mockResolvedValue({
      ok: true,
      data: { accepted: true, status: "healthy" },
    });
    await getAuthenticatedJitterToken(capability);
    await connectAuthenticatedJitterCall(capability, "registered");
    await connectAuthenticatedJitterCall(capability, "accepted");
    await reportAuthenticatedJitterAudioHealth(capability, {
      controller_id: "00000000-0000-4000-8000-000000000021",
      peer_connection_generation: 1,
      sample_sequence: 1,
      packets_received: 12,
      bytes_received: 2048,
    });
    await cancelAuthenticatedJitterCall(capability, "failed");
    expect(mocks.getUser).toHaveBeenCalledTimes(5);
    expect(mocks.requestToken).toHaveBeenCalledWith(CALL_ID);
    expect(mocks.requestConnect).toHaveBeenNthCalledWith(
      1,
      CALL_ID,
      "registered",
    );
    expect(mocks.requestConnect).toHaveBeenNthCalledWith(
      2,
      CALL_ID,
      "accepted",
    );
    expect(mocks.requestAudioHealth).toHaveBeenCalledWith(
      CALL_ID,
      expect.objectContaining({ bytes_received: 2048 }),
    );
    expect(mocks.requestCancel).toHaveBeenCalledWith(CALL_ID, "failed");
  });

  it("denies users without current Sandra membership before eligibility or provider work", async () => {
    mocks.getCallerMemberships.mockResolvedValue([]);
    await expect(
      startAuthenticatedJitterCall(callTarget()),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      errorCode: "forbidden",
    });
    expect(mocks.prepareManualCall).not.toHaveBeenCalled();
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("denies a caller whose active membership belongs to a different organization", async () => {
    mocks.getCallerMemberships.mockResolvedValue([
      { user_id: "user-1", org_id: "other-org", role: "member" },
    ]);
    await expect(
      startAuthenticatedJitterCall(callTarget()),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      errorCode: "forbidden",
    });
    expect(mocks.prepareManualCall).not.toHaveBeenCalled();
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("rejects malformed direct Server Action payloads without throwing", async () => {
    await expect(startAuthenticatedJitterCall(null)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(
      startAuthenticatedJitterCall({ phoneE164: "+18165550123" }),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(getAuthenticatedJitterToken(42)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(
      connectAuthenticatedJitterCall("call", "wrong"),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      cancelAuthenticatedJitterCall({}, "invalid"),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a valid capability when a different Sandra user presents it", async () => {
    const started = await startAuthenticatedJitterCall(
      callTarget({ propertyId: "property-1", contactId: "contact-1" }),
    );
    if (!started.ok) throw new Error("expected successful start");
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-2" } },
      error: null,
    });
    mocks.getCallerMemberships.mockResolvedValue([
      { user_id: "user-2", org_id: SANDRA_ORG_ID, role: "member" },
    ]);
    await expect(
      getAuthenticatedJitterToken(started.data.callId),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      errorCode: "invalid_request",
    });
    expect(mocks.requestToken).not.toHaveBeenCalled();
  });

  it("rejects a start intent minted for a different Sandra user before preparation", async () => {
    mocks.getUser.mockResolvedValue({
      data: { user: { id: "user-2" } },
      error: null,
    });
    mocks.getCallerMemberships.mockResolvedValue([
      { user_id: "user-2", org_id: SANDRA_ORG_ID, role: "member" },
    ]);

    await expect(
      startAuthenticatedJitterCall(
        callTarget({ propertyId: "property-1", contactId: "contact-1" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      status: 400,
      errorCode: "invalid_request",
    });
    expect(mocks.prepareLeadCall).not.toHaveBeenCalled();
    expect(mocks.requestStart).not.toHaveBeenCalled();
  });

  it("accepts an in-flight capability minted under the bounded previous key after rotation", async () => {
    const started = await startAuthenticatedJitterCall(
      callTarget({
        propertyId: "property-1",
        contactId: "contact-1",
      }),
    );
    if (!started.ok) throw new Error("expected successful start");

    vi.stubEnv("SOFTPHONE_CAPABILITY_KEY", NEW_CAPABILITY_KEY);
    vi.stubEnv("SOFTPHONE_CAPABILITY_KEY_PREVIOUS", OLD_CAPABILITY_KEY);
    await expect(
      cancelAuthenticatedJitterCall(started.data.callId, "abandoned"),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(mocks.requestCancel).toHaveBeenCalledWith(CALL_ID, "abandoned");
  });

  it.each([
    ["missing", ""],
    ["unversioned", "x".repeat(48)],
    ["too short", `v1:${"x".repeat(31)}`],
    ["too long", `v1:${"x".repeat(513)}`],
  ])(
    "does not provision when the dedicated capability key is %s",
    async (_label, key) => {
      vi.stubEnv("SOFTPHONE_CAPABILITY_KEY", key);
      await expect(
        startAuthenticatedJitterCall(
          callTarget({
            propertyId: "property-1",
            contactId: "contact-1",
          }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        status: 503,
        errorCode: "jitter_not_configured",
      });
      expect(mocks.requestStart).not.toHaveBeenCalled();
      expect(mocks.prepareLeadCall).not.toHaveBeenCalled();
    },
  );
});
