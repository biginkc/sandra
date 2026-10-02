import { describe, expect, it, vi } from "vitest";

import type { BlandClient, BlandSendResult } from "./bland";
import type { NormaBlandConfig } from "./config";
import { dispatchNormaCall } from "./dispatch";
import { fakeClient, PHONE, REQUEST_ID, requestRow } from "./test-helpers";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const blandConfig: NormaBlandConfig = {
  apiKey: "k", baseUrl: "https://bland.test", pathwayId: "pw", pathwayVersion: 17,
  fromNumber: "+12135550100", webhookUrl: "https://sandra.test/h", timeoutMs: 1000,
};
const openGate = { dispatchEnabled: true, sellerRelease: false, allowedNumbers: [PHONE] };

function setup(opts: { send?: BlandSendResult; gate?: typeof openGate; row?: Record<string, unknown>; claim?: boolean; eligible?: boolean; bind?: string; blandConfig?: NormaBlandConfig | null } = {}) {
  const sendCall = vi.fn().mockResolvedValue(opts.send ?? { kind: "accepted", callId: "call-1" });
  const bland: BlandClient = { sendCall, getCall: vi.fn() };
  const rpcs = {
    fn_norma_claim_dispatch: vi.fn().mockReturnValue(opts.claim ?? true),
    fn_norma_eligibility: vi.fn().mockReturnValue([opts.eligible === false ? { eligible: false, block_reason: "dnc_locked" } : { eligible: true }]),
    fn_norma_bind_call_id: vi.fn().mockReturnValue(opts.bind ?? "bound"),
    fn_norma_mark_dispatch_rejected: vi.fn().mockReturnValue("dispatch_rejected"),
    fn_norma_mark_dispatch_unknown: vi.fn().mockReturnValue("dispatch_unknown"),
  };
  const { client, calls } = fakeClient(
    {
      norma_call_requests: [requestRow(opts.row)],
      properties: [{ id: "p1", address: "1 Main", city: "KC", state: "MO", zip: "64111" }],
      contacts: [{ id: "c1", first_name: "Sam" }],
    },
    rpcs,
  );
  const run = () =>
    dispatchNormaCall(REQUEST_ID, {
      client, bland,
      blandConfig: opts.blandConfig === undefined ? blandConfig : opts.blandConfig,
      gate: opts.gate ?? openGate,
    });
  return { run, sendCall, rpcs, calls };
}

describe("dispatchNormaCall", () => {
  it("gate off: never dials, never claims, closes the request as rejected", async () => {
    const t = setup({ gate: { dispatchEnabled: false, sellerRelease: true, allowedNumbers: [PHONE] } });
    await expect(t.run()).resolves.toEqual({ status: "rejected", reason: "dispatch_disabled" });
    expect(t.sendCall).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_claim_dispatch).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_reason: "gate:dispatch_disabled" });
  });

  it("on but not allowlisted: never dials, closes as rejected", async () => {
    const t = setup({ gate: { dispatchEnabled: true, sellerRelease: false, allowedNumbers: ["+18165550000"] } });
    await expect(t.run()).resolves.toEqual({ status: "rejected", reason: "number_not_allowed" });
    expect(t.sendCall).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_claim_dispatch).not.toHaveBeenCalled();
  });

  it("seller release dials a non-allowlisted number", async () => {
    const t = setup({ gate: { dispatchEnabled: true, sellerRelease: true, allowedNumbers: [] } });
    await expect(t.run()).resolves.toEqual({ status: "dispatched", callId: "call-1" });
    expect(t.sendCall).toHaveBeenCalledTimes(1);
  });

  it("missing Bland config never dials", async () => {
    const t = setup({ blandConfig: null });
    await expect(t.run()).resolves.toEqual({ status: "rejected", reason: "bland_not_configured" });
    expect(t.sendCall).not.toHaveBeenCalled();
  });

  it("happy path: claim, eligibility, send with correlation, bind", async () => {
    const t = setup();
    await expect(t.run()).resolves.toEqual({ status: "dispatched", callId: "call-1" });
    expect(t.sendCall).toHaveBeenCalledWith({
      phoneNumber: PHONE, requestId: REQUEST_ID, idempotencyKey: "22222222-2222-4222-8222-222222222222",
      variables: { seller_first_name: "Sam", property_address: "1 Main, KC, MO, 64111", rep_context: "ctx" },
    });
    expect(t.rpcs.fn_norma_bind_call_id).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_call_id: "call-1" });
  });

  it("loses the claim race: no dial", async () => {
    const t = setup({ claim: false });
    await expect(t.run()).resolves.toEqual({ status: "not_claimed" });
    expect(t.sendCall).not.toHaveBeenCalled();
  });

  it("a request that is not 'requested' is left alone", async () => {
    const t = setup({ row: { status: "dispatched" } });
    await expect(t.run()).resolves.toEqual({ status: "not_claimed" });
    expect(t.rpcs.fn_norma_claim_dispatch).not.toHaveBeenCalled();
  });

  it("dial-time ineligibility rejects without dialling", async () => {
    const t = setup({ eligible: false });
    await expect(t.run()).resolves.toEqual({ status: "rejected", reason: "ineligible:dnc_locked" });
    expect(t.sendCall).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalled();
  });

  it("explicit Bland rejection: dispatch_rejected, not unknown", async () => {
    const t = setup({ send: { kind: "rejected", httpStatus: 402, message: "balance" } });
    await expect(t.run()).resolves.toEqual({ status: "rejected", reason: "bland_402" });
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalled();
    expect(t.rpcs.fn_norma_mark_dispatch_unknown).not.toHaveBeenCalled();
  });

  it("timeout / 5xx: dispatch_unknown, never redialled", async () => {
    const t = setup({ send: { kind: "unknown", reason: "timeout" } });
    await expect(t.run()).resolves.toEqual({ status: "unknown", reason: "timeout" });
    expect(t.rpcs.fn_norma_mark_dispatch_unknown).toHaveBeenCalledTimes(1);
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
    expect(t.sendCall).toHaveBeenCalledTimes(1);
  });

  it("an accepted call whose id cannot be bound becomes dispatch_unknown", async () => {
    const t = setup({ bind: "call_id_conflict" });
    await expect(t.run()).resolves.toEqual({ status: "unknown", reason: "bind_failed" });
    expect(t.rpcs.fn_norma_mark_dispatch_unknown).toHaveBeenCalled();
  });
});
