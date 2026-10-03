import { describe, expect, it, vi } from "vitest";

import { NORMA_MAX_DURATION_MINUTES, NORMA_VOICEMAIL_MESSAGE, buildSendCallBody, createBlandClient } from "./bland";
import type { NormaBlandConfig } from "./config";

const config: NormaBlandConfig = {
  apiKey: "test-key",
  baseUrl: "https://bland.test",
  pathwayId: "pw-1",
  pathwayVersion: 17,
  voice: "voice-1",
  fromNumber: "+12135550100",
  webhookUrl: "https://sandra.test/api/webhooks/bland/call",
  timeoutMs: 1000,
  waitForGreeting: true,
  backgroundTrack: "office",
};
const params = { phoneNumber: "+18165550142", requestId: "r1", idempotencyKey: "k1", variables: { a: "b" } };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("bland send-call classification", () => {
  it("builds the exact body: pinned version, voicemail, recording, no retry, metadata, webhook", () => {
    const body = buildSendCallBody(config, params);
    expect(body).toEqual({
      phone_number: "+18165550142",
      pathway_id: "pw-1",
      pathway_version: 17,
      voice: "voice-1",
      from: "+12135550100",
      metadata: { request_id: "r1", idempotency_key: "k1" },
      webhook: "https://sandra.test/api/webhooks/bland/call",
      voicemail: { action: "leave_message", message: NORMA_VOICEMAIL_MESSAGE },
      record: true,
      max_duration: NORMA_MAX_DURATION_MINUTES,
      request_data: { a: "b" },
      wait_for_greeting: true,
      background_track: "office",
    });
    expect(NORMA_VOICEMAIL_MESSAGE).toBe(
      "Hi, this is Norma with The BMH Group following up on your property. Please call us back at 8 1 6, 7 0 5, 3 5 0 1. Thank you.",
    );
    expect(JSON.stringify(body)).not.toMatch(/"(task|prompt|first_sentence|script)"/);
    expect("retry" in body).toBe(false);
    expect(Number.isInteger(body.pathway_version)).toBe(true);
  });

  it("omits pathway_version when unpinned so Bland uses the published production version", () => {
    const body = buildSendCallBody({ ...config, pathwayVersion: null }, params);
    expect(body).not.toHaveProperty("pathway_version");
    expect(body.voicemail).toEqual({ action: "leave_message", message: NORMA_VOICEMAIL_MESSAGE });
    expect(body.record).toBe(true);
    expect(body.max_duration).toBe(10);
  });

  it("passes configured greeting wait and background track through", () => {
    const body = buildSendCallBody({ ...config, waitForGreeting: false, backgroundTrack: "none" }, params);
    expect(body.wait_for_greeting).toBe(false);
    expect(body.background_track).toBe("none");
  });

  it("sends to /v1/calls with a bearer key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { status: "success", call_id: "c1" }));
    await createBlandClient(config, fetchImpl).sendCall(params);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://bland.test/v1/calls");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-key");
  });

  it("accepted: 2xx success with a call id", async () => {
    const c = createBlandClient(config, async () => json(200, { status: "success", call_id: " c1 " }));
    await expect(c.sendCall(params)).resolves.toEqual({ kind: "accepted", callId: "c1" });
  });

  it.each([400, 401, 402, 422, 429])("rejected: explicit %i", async (status) => {
    const c = createBlandClient(config, async () => json(status, { status: "error", message: "nope" }));
    await expect(c.sendCall(params)).resolves.toEqual({ kind: "rejected", httpStatus: status, message: "nope" });
  });

  it.each([500, 502, 503, 408])("unknown: http %i", async (status) => {
    const c = createBlandClient(config, async () => json(status, {}));
    await expect(c.sendCall(params)).resolves.toEqual({ kind: "unknown", reason: `http_${status}` });
  });

  it("unknown: 2xx without a call id, wrong status, or an unparseable body", async () => {
    for (const make of [
      () => json(200, { status: "success" }),
      () => json(200, { status: "error", call_id: "c" }),
      () => new Response("<html>", { status: 200 }),
    ]) {
      const c = createBlandClient(config, async () => make());
      await expect(c.sendCall(params)).resolves.toMatchObject({ kind: "unknown" });
    }
  });

  it("unknown: network error", async () => {
    const c = createBlandClient(config, async () => {
      throw new TypeError("fetch failed");
    });
    await expect(c.sendCall(params)).resolves.toEqual({ kind: "unknown", reason: "network_error" });
  });

  it("unknown: timeout aborts the request", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (_u: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      const pending = createBlandClient({ ...config, timeoutMs: 1000 }, fetchImpl).sendCall(params);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(pending).resolves.toEqual({ kind: "unknown", reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bland get-call", () => {
  it("found / not_found / unknown", async () => {
    const found = createBlandClient(config, async () => json(200, { call_id: "c1", completed: true }));
    await expect(found.getCall("c1")).resolves.toEqual({ kind: "found", call: { call_id: "c1", completed: true } });
    const missing = createBlandClient(config, async () => json(404, {}));
    await expect(missing.getCall("c1")).resolves.toEqual({ kind: "not_found" });
    const err = createBlandClient(config, async () => json(500, {}));
    await expect(err.getCall("c1")).resolves.toEqual({ kind: "unknown", reason: "http_500" });
    const net = createBlandClient(config, async () => {
      throw new Error("x");
    });
    await expect(net.getCall("c1")).resolves.toMatchObject({ kind: "unknown" });
  });

  it("url-encodes the call id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, {}));
    await createBlandClient(config, fetchImpl).getCall("a/b");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://bland.test/v1/calls/a%2Fb");
  });
});
