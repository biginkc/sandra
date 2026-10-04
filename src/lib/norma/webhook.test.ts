import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { dispatchNormaCall } from "./dispatch";
import { fakeClient, KEY, PHONE, REQUEST_ID, requestRow } from "./test-helpers";
import { handleBlandCallWebhook, MAX_WEBHOOK_BODY_BYTES, verifyBlandSignature } from "./webhook";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const SECRET = "whsec_test";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");
const call = (overrides: Record<string, unknown> = {}) => ({
  call_id: "call-1", to: PHONE, completed: true, status: "completed", answered_by: "human",
  metadata: { request_id: REQUEST_ID, idempotency_key: KEY },
  variables: { call_outcome: "not_interested" }, summary: "sum", ...overrides,
});
function req(body: string, signature: string | null, extra: Record<string, string> = {}) {
  return new Request("https://sandra.test/api/webhooks/bland/call", {
    method: "POST", body, headers: { ...(signature ? { "x-webhook-signature": signature } : {}), ...extra },
  });
}

function setup(rpcResult: unknown = { result: "applied", status: "completed", outcome: "not_interested" }) {
  const complete = vi.fn().mockReturnValue(rpcResult);
  const { client, calls } = fakeClient({ norma_call_requests: [requestRow({ status: "dispatched" })] }, { fn_norma_complete_call: complete });
  return { client, calls, complete };
}
const post = (client: ReturnType<typeof setup>["client"], payload: unknown, signature?: string | null) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return handleBlandCallWebhook(req(body, signature === undefined ? sign(body) : signature), { client, secret: SECRET });
};

describe("bland signature", () => {
  const body = '{"a":1}';
  it("accepts a valid signature (and an sha256= prefix)", () => {
    expect(verifyBlandSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyBlandSignature(SECRET, body, `sha256=${sign(body)}`)).toBe(true);
  });
  it("rejects invalid, missing, malformed, wrong-secret and tampered bodies", () => {
    expect(verifyBlandSignature(SECRET, body, sign(body, "other"))).toBe(false);
    expect(verifyBlandSignature(SECRET, body, null)).toBe(false);
    expect(verifyBlandSignature(SECRET, body, "")).toBe(false);
    expect(verifyBlandSignature(SECRET, body, "zz")).toBe(false);
    expect(verifyBlandSignature(SECRET, '{"a":2}', sign(body))).toBe(false);
    expect(verifyBlandSignature("", body, sign(body, ""))).toBe(false);
  });
});

describe("bland webhook route core", () => {
  it("rejects bad signatures with zero CRM effect and before parsing", async () => {
    const { client, calls, complete } = setup();
    expect((await post(client, call(), "0".repeat(64))).status).toBe(401);
    expect((await post(client, call(), null)).status).toBe(401);
    // Unsigned garbage is a 401, not a 400: the body is never parsed.
    expect((await post(client, "not json", "0".repeat(64))).status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("a tampered body fails", async () => {
    const { client, complete } = setup();
    const body = JSON.stringify(call());
    const res = await handleBlandCallWebhook(req(body.replace("call-1", "call-2"), sign(body)), { client, secret: SECRET });
    expect(res.status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });

  it("is not configured without a secret, and rejects an oversized body", async () => {
    const { client } = setup();
    const noSecret = await handleBlandCallWebhook(req("{}", sign("{}")), { client, secret: undefined });
    expect(noSecret.status).toBe(500);
    const big = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    expect((await post(client, big)).status).toBe(413);
  });

  it("signed but malformed JSON is a 400 with no effect", async () => {
    const { client, complete } = setup();
    expect((await post(client, "not json")).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("applies the mapped outcome through the completion RPC", async () => {
    const { client, complete } = setup();
    const res = await post(client, call());
    expect(res).toEqual({ status: 200, body: { status: "applied" } });
    expect(complete).toHaveBeenCalledWith({
      p_request_id: REQUEST_ID, p_call_id: "call-1", p_outcome: "not_interested",
      p_payload: expect.objectContaining({ summary: "sum" }),
    });
  });

  it("idempotent replay: a repeated webhook is acknowledged and the RPC reports replayed", async () => {
    const { client, complete } = setup();
    complete.mockReturnValueOnce({ result: "applied", status: "completed", outcome: "not_interested" });
    complete.mockReturnValueOnce({ result: "replayed", status: "completed", outcome: "not_interested" });
    expect((await post(client, call())).body).toEqual({ status: "applied" });
    expect((await post(client, call())).body).toEqual({ status: "replayed" });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("mismatched request, key, number or missing correlation: acknowledged, zero effect", async () => {
    const { client, complete } = setup();
    for (const payload of [
      call({ metadata: { request_id: "99999999-9999-4999-8999-999999999999", idempotency_key: KEY } }),
      call({ metadata: { request_id: REQUEST_ID, idempotency_key: "33333333-3333-4333-8333-333333333333" } }),
      call({ to: "+18165550000" }),
      call({ to: undefined }),
      call({ metadata: {} }),
      call({ call_id: undefined }),
    ]) {
      const res = await post(client, payload);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ignored");
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("a different call id than the bound one is ignored and reported, never applied", async () => {
    const { client } = setup({ result: "call_id_mismatch", status: "dispatched" });
    expect((await post(client, call())).body).toEqual({ status: "ignored", reason: "call_id_mismatch" });
  });

  it("passes the attempt echoed in the call metadata (default 1) and acknowledges a stale-attempt result as ignored", async () => {
    const { client, complete } = setup();
    await post(client, call());
    expect(complete.mock.calls[0]![0].p_payload).toMatchObject({ attempt: 1 });
    await post(client, call({ metadata: { request_id: REQUEST_ID, idempotency_key: KEY, attempt: 2 } }));
    expect(complete.mock.calls[1]![0].p_payload).toMatchObject({ attempt: 2 });
    await post(client, call({ metadata: { request_id: REQUEST_ID, idempotency_key: KEY, attempt: "x" } }));
    expect(complete.mock.calls[2]![0].p_payload).toMatchObject({ attempt: 0 });
    const stale = setup({ result: "stale_attempt", status: "dispatching" });
    expect(await post(stale.client, call())).toEqual({ status: 200, body: { status: "ignored", reason: "stale_attempt" } });
  });

  it("attempt-2 voicemail without a pathway outcome completes as confirmed no_answer", async () => {
    const { client, complete } = setup({ result: "applied", status: "completed", outcome: "no_answer" });
    expect(await post(client, call({
      answered_by: "voicemail",
      variables: { call_outcome: "" },
      metadata: { request_id: REQUEST_ID, idempotency_key: KEY, attempt: 2 },
    }))).toEqual({ status: 200, body: { status: "applied" } });
    expect(complete).toHaveBeenCalledWith({
      p_request_id: REQUEST_ID, p_call_id: "call-1", p_outcome: "no_answer",
      p_payload: expect.objectContaining({ attempt: 2 }),
    });
  });

  it("unmappable payloads complete as unknown (parked for a human)", async () => {
    const { client, complete } = setup({ result: "applied", status: "needs_review", outcome: "unknown" });
    await post(client, call({ variables: {} }));
    expect(complete.mock.calls[0]![0]).toMatchObject({ p_outcome: "unknown" });
  });

  it("an infrastructure failure returns 500 so Bland retries", async () => {
    const { client, complete } = setup();
    complete.mockImplementation(() => {
      throw new Error("db down");
    });
    expect((await post(client, call())).status).toBe(500);
  });

  it("early webhook before bind: the late bind sees already_completed and the dispatch stays dispatched", async () => {
    const state = { status: "dispatching" as string };
    const complete = vi.fn().mockImplementation(() => {
      state.status = "completed";
      return { result: "applied", status: "completed", outcome: "not_interested" };
    });
    const unknown = vi.fn();
    const { client, calls } = fakeClient(
      { norma_call_requests: [requestRow()] },
      {
        fn_norma_claim_dispatch: () => true,
        fn_norma_eligibility: () => [{ eligible: true }],
        fn_norma_bind_call_id: () => (state.status === "completed" ? "already_completed" : "bound"),
        fn_norma_mark_dispatch_unknown: unknown,
        fn_norma_complete_call: complete,
      },
    );
    const bland = {
      // The webhook lands while the send-call response is still in flight.
      sendCall: async () => {
        const body = JSON.stringify(call());
        await handleBlandCallWebhook(req(body, sign(body)), { client, secret: SECRET });
        return { kind: "accepted" as const, callId: "call-1" };
      },
      getCall: vi.fn(),
    };
    const result = await dispatchNormaCall(REQUEST_ID, {
      client, bland,
      blandConfig: { apiKey: "k", baseUrl: "x", pathwayId: "p", pathwayVersion: 1, voice: "v", fromNumber: "+12135550100", webhookUrl: "https://x.test", timeoutMs: 1000, waitForGreeting: true, backgroundTrack: "office" },
      gate: { dispatchEnabled: true, sellerRelease: false, allowedNumbers: [PHONE] },
    });
    expect(result).toEqual({ status: "dispatched", callId: "call-1" });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(unknown).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toContain("fn_norma_bind_call_id");
  });
});

describe("callback time conversion in the webhook", () => {
  const callbackCall = (follow: string, extra: Record<string, unknown> = {}) =>
    call({ variables: { call_outcome: "callback_requested - asked", follow_up_preference: follow }, ...extra });
  function setupWithProperty(state = "MO") {
    const complete = vi.fn().mockReturnValue({ result: "applied", status: "completed", outcome: "callback_requested" });
    const { client } = fakeClient(
      { norma_call_requests: [requestRow({ status: "dispatched" })], properties: [{ id: "p1", state }] },
      { fn_norma_complete_call: complete },
    );
    return { client, complete };
  }

  it("passes a converted time to the completion RPC", async () => {
    const { client, complete } = setupWithProperty();
    const future = new Date(Date.now() + 3 * 24 * 3_600_000);
    const body = JSON.stringify(callbackCall("tomorrow morning", { started_at: new Date(Date.now() - 90_000).toISOString(), corrected_duration: 60 }));
    const result = await handleBlandCallWebhook(req(body, sign(body)), { client, secret: SECRET });
    expect(result.status).toBe(200);
    const payload = complete.mock.calls[0]![0].p_payload;
    expect(payload.callback_raw).toBe("tomorrow morning");
    expect(payload.callback_timezone).toBe("America/Chicago");
    expect(Date.parse(payload.callback_requested_for)).toBeGreaterThan(Date.now());
    expect(Date.parse(payload.callback_requested_for)).toBeLessThan(future.getTime());
  });

  it("still completes with the raw words when the AI step throws or the text is unusable", async () => {
    const { client, complete } = setupWithProperty();
    const body = JSON.stringify(callbackCall("a week from Monday"));
    const provider = vi.fn().mockRejectedValue(new Error("model down"));
    const result = await handleBlandCallWebhook(req(body, sign(body)), { client, secret: SECRET, callbackTimeProvider: provider });
    expect(result).toMatchObject({ status: 200, body: { status: "applied" } });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0].p_payload).toMatchObject({ callback_requested_for: null, callback_raw: "a week from Monday" });
  });

  it("a replay of an already-completed request skips the conversion and the AI step", async () => {
    const complete = vi.fn().mockReturnValue({ result: "replayed", status: "completed", outcome: "callback_requested" });
    const { client } = fakeClient(
      { norma_call_requests: [requestRow({ status: "completed" })], properties: [{ id: "p1", state: "MO" }] },
      { fn_norma_complete_call: complete },
    );
    const body = JSON.stringify(callbackCall("a week from Monday"));
    const provider = vi.fn().mockResolvedValue({ local_date: "2027-01-01", local_time: "09:00", confidence: 0.9 });
    const result = await handleBlandCallWebhook(req(body, sign(body)), { client, secret: SECRET, callbackTimeProvider: provider });
    expect(result).toMatchObject({ status: 200, body: { status: "replayed" } });
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not convert anything for a non-callback outcome", async () => {
    const { client, complete } = setupWithProperty();
    const body = JSON.stringify(call({ variables: { call_outcome: "not_interested", follow_up_preference: "tomorrow" } }));
    await handleBlandCallWebhook(req(body, sign(body)), { client, secret: SECRET });
    expect(complete.mock.calls[0]![0].p_payload.callback_requested_for).toBeUndefined();
  });
});

