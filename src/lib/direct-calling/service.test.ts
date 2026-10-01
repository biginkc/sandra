import { describe, expect, it, vi } from "vitest";

import { createDirectCallService, type DirectCallServiceDeps } from "./service";
import { FakeStore } from "./test-support";
import { TelnyxApiError } from "./telnyx";

const ENV = {
  DIRECT_CALL_PILOT_USER_IDS: "user-1",
  TELNYX_DIRECT_API_KEY: "SECRET-KEY-123",
  TELNYX_DIRECT_CONNECTION_ID: "conn",
  TELNYX_DIRECT_APP_ID: "app",
  TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY: "pub",
  DIRECT_CALL_CALLER_ID_E164: "+15550002222",
};
const REQ = "44444444-4444-4444-8444-444444444444";
const REQ2 = "55555555-5555-4555-8555-555555555555";

function setup(overrides: Partial<DirectCallServiceDeps> = {}) {
  const store = new FakeStore();
  const telnyx = {
    dial: vi.fn(async (_s: unknown, _p: Record<string, unknown>) => ({ callControlId: "BROWSER-LEG" })),
    hangup: vi.fn(async (_s: unknown, _leg: string, _cmd: string) => undefined),
    sendDtmf: vi.fn(async (_s: unknown, _leg: string, _d: string) => undefined),
    createCredential: vi.fn(async () => ({ id: "cred-1", sipUsername: "gencred123" })),
    createToken: vi.fn(async () => "jwt-token"),
  };
  const prepareLeadCall = vi.fn(async (propertyId: string) => ({ ok: true as const, data: { propertyId, contactId: "contact-1", phoneE164: "+15550009999" } }));
  const prepareManualCall = vi.fn(async () => ({ ok: true as const, data: { propertyId: null, contactId: null, phoneE164: "+15550008888" } }));
  const resumeFailedSoftphoneCall = vi.fn(async () => undefined);
  const report = vi.fn();
  const service = createDirectCallService({
    store, env: ENV, now: () => new Date("2026-10-01T12:00:00.000Z"),
    prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall, telnyx, report, ...overrides,
  });
  return { store, telnyx, prepareLeadCall, prepareManualCall, resumeFailedSoftphoneCall, report, service };
}

describe("direct call service", () => {
  it("refuses everything for non-pilot users", async () => {
    const { service, telnyx } = setup();
    expect(await service.getRtcToken("user-2")).toMatchObject({ ok: false, errorCode: "not_enabled" });
    expect(await service.startCall("user-2", { kind: "manual", phone: "5550008888", clientRequestId: REQ })).toMatchObject({ ok: false, errorCode: "not_enabled" });
    expect(telnyx.createCredential).not.toHaveBeenCalled();
  });

  it("creates a credential once and mints a token", async () => {
    const { service, telnyx } = setup();
    const first = await service.getRtcToken("user-1");
    const second = await service.getRtcToken("user-1");
    expect(first).toEqual({ ok: true, data: { token: "jwt-token", sipUsername: "gencred123" } });
    expect(second.ok).toBe(true);
    expect(telnyx.createCredential).toHaveBeenCalledTimes(1);
  });

  it("starts a lead call with the prepared destination, never a browser-supplied one", async () => {
    const { service, telnyx, store } = setup();
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    expect(result.ok).toBe(true);
    const dial = telnyx.dial.mock.calls[0][1];
    expect(dial).toMatchObject({
      to: "sip:gencred123@sip.telnyx.com",
      from: "+15550002222",
      timeoutSecs: 30,
      timeLimitSecs: 7200,
      clientState: { role: "browser" },
      customHeaders: [{ name: "X-Sandra-Direct-Call-Id", value: expect.any(String) }],
    });
    const row = [...store.calls.values()][0];
    expect(row).toMatchObject({ destination_e164: "+15550009999", caller_id_e164: "+15550002222", status: "browser_connecting", browser_leg_id: "BROWSER-LEG" });
    if (result.ok) expect(result.data).toMatchObject({ directCallId: row.id, browserLegId: "BROWSER-LEG", correlationHeader: { name: "X-Sandra-Direct-Call-Id", value: row.id } });
  });

  it("ignores a PSTN destination smuggled into the input", async () => {
    const { service, store, prepareLeadCall } = setup();
    await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ, phoneE164: "+19998887777", destination: "+19998887777" } as never);
    expect(prepareLeadCall).toHaveBeenCalledWith("prop-1");
    expect([...store.calls.values()][0].destination_e164).toBe("+15550009999");
  });

  it("returns the prepare error unchanged and does nothing else", async () => {
    const prepareLeadCall = vi.fn(async () => ({ ok: false as const, error: "Calling is unavailable during quiet hours." }));
    const { service, telnyx, store, resumeFailedSoftphoneCall } = setup({ prepareLeadCall });
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "p", clientRequestId: REQ });
    expect(result).toEqual({ ok: false, error: "Calling is unavailable during quiet hours." });
    expect(store.calls.size).toBe(0);
    expect(telnyx.dial).not.toHaveBeenCalled();
    expect(resumeFailedSoftphoneCall).not.toHaveBeenCalled();
  });

  it("refuses a second concurrent call before preparing anything", async () => {
    const { service, prepareLeadCall, prepareManualCall } = setup();
    await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    prepareLeadCall.mockClear();
    const second = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ2 });
    expect(second).toMatchObject({ ok: false, errorCode: "call_in_progress" });
    expect(prepareLeadCall).not.toHaveBeenCalled();
    expect(prepareManualCall).not.toHaveBeenCalled();
  });

  it("resumes the lead and fails the row when the browser Dial fails", async () => {
    const { service, telnyx, store, resumeFailedSoftphoneCall, report } = setup();
    telnyx.dial.mockRejectedValueOnce(new TelnyxApiError("Telnyx request timed out.", "unknown", null));
    const result = await service.startCall("user-1", { kind: "lead", propertyId: "prop-1", clientRequestId: REQ });
    expect(result).toMatchObject({ ok: false, errorCode: "start_failed" });
    expect([...store.calls.values()][0]).toMatchObject({ status: "failed", failure_reason: "dial_outcome_unknown" });
    expect(resumeFailedSoftphoneCall).toHaveBeenCalledWith("prop-1");
    expect(telnyx.dial).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalled();
  });

  it("does not leak the API key in returned errors", async () => {
    const { service, telnyx } = setup();
    telnyx.dial.mockRejectedValueOnce(new Error("failed with Authorization: Bearer SECRET-KEY-123"));
    const start = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    telnyx.createToken.mockRejectedValueOnce(new Error("Bearer SECRET-KEY-123"));
    const token = await service.getRtcToken("user-1");
    expect(JSON.stringify([start, token])).not.toMatch(/SECRET-KEY|Bearer|Authorization/);
  });

  it("replays an in-flight request id instead of dialing twice", async () => {
    const { service, telnyx } = setup();
    const a = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    const b = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    expect(b).toEqual(a);
    expect(telnyx.dial).toHaveBeenCalledTimes(1);
  });

  it("only exposes a user's own calls", async () => {
    const { service } = setup();
    const started = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    if (!started.ok) throw new Error("setup failed");
    const id = started.data.directCallId;
    expect(await service.getStatus("user-1", id)).toMatchObject({ ok: true, data: { status: "browser_connecting" } });
    expect(await service.getStatus("user-2", id)).toMatchObject({ ok: false, errorCode: "not_found" });
    expect(await service.control("user-2", id, { action: "hangup" })).toMatchObject({ ok: false });
  });

  it("hangs up both known legs and marks the call ending", async () => {
    const { service, telnyx, store } = setup();
    const started = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    if (!started.ok) throw new Error("setup failed");
    const id = started.data.directCallId;
    store.calls.set(id, { ...store.calls.get(id)!, status: "connected", seller_leg_id: "SELLER-LEG" });
    expect(await service.control("user-1", id, { action: "hangup" })).toEqual({ ok: true, data: { accepted: true } });
    expect(telnyx.hangup.mock.calls.map((c) => c[1]).sort()).toEqual(["BROWSER-LEG", "SELLER-LEG"]);
    expect(store.calls.get(id)?.status).toBe("ending");
  });

  it("sends DTMF to the seller leg only while connected, and validates the digit", async () => {
    const { service, telnyx, store } = setup();
    const started = await service.startCall("user-1", { kind: "manual", phone: "5550008888", clientRequestId: REQ });
    if (!started.ok) throw new Error("setup failed");
    const id = started.data.directCallId;
    expect(await service.control("user-1", id, { action: "dtmf", digit: "5" })).toMatchObject({ ok: false, errorCode: "not_connected" });
    store.calls.set(id, { ...store.calls.get(id)!, status: "connected", seller_leg_id: "SELLER-LEG" });
    expect(await service.control("user-1", id, { action: "dtmf", digit: "5" })).toMatchObject({ ok: true });
    expect(telnyx.sendDtmf).toHaveBeenCalledWith(expect.anything(), "SELLER-LEG", "5");
    expect(await service.control("user-1", id, { action: "dtmf", digit: "55" as never })).toMatchObject({ ok: false, errorCode: "invalid_request" });
  });
});
