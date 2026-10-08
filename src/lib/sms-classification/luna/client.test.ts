import { describe, expect, it, vi } from "vitest";

import { classifyWithLuna, parseLunaJson } from "./client";

const ok = (text: string, usage = { input_tokens: 10, output_tokens: 3 }) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text }] }], usage }),
  }) as unknown as Response;

const good = JSON.stringify({ outcome: "nurture", escalation_reason: "needs_review", confidence: 0.82 });
const thread = [{ direction: "inbound" as const, body: "maybe later" }];
const cfg = { apiKey: "sk-test", model: "gpt-6-luna" };

describe("parseLunaJson", () => {
  it("accepts a schema-valid answer", () => {
    expect(parseLunaJson(good)).toEqual({ outcome: "nurture", confidence: 0.82, escalationReason: "needs_review" });
  });
  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["an unknown outcome", JSON.stringify({ outcome: "maybe", escalation_reason: "needs_review", confidence: 0.5 })],
    ["an unknown reason", JSON.stringify({ outcome: "nurture", escalation_reason: "x", confidence: 0.5 })],
    ["confidence above 1", JSON.stringify({ outcome: "nurture", escalation_reason: "needs_review", confidence: 1.2 })],
    ["confidence as text", JSON.stringify({ outcome: "nurture", escalation_reason: "needs_review", confidence: "high" })],
    ["a missing field", JSON.stringify({ outcome: "nurture", confidence: 0.5 })],
    ["an extra field", JSON.stringify({ outcome: "nurture", escalation_reason: "needs_review", confidence: 0.5, why: "x" })],
  ])("rejects %s", (_n, text) => {
    expect(() => parseLunaJson(text)).toThrow();
  });
});

describe("classifyWithLuna", () => {
  it("posts one Responses API request with strict JSON schema and returns the pick", async () => {
    const fetch = vi.fn(async () => ok(good));
    const r = await classifyWithLuna(cfg, thread, { fetch: fetch as never });
    expect(r).toMatchObject({ status: "ok", outcome: "nurture", confidence: 0.82, model: "gpt-6-luna" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "gpt-6-luna", store: false });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.input).toContain("[inbound] maybe later");
  });

  it("makes a single attempt: an HTTP error is an error result, never retried, body never echoed", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: "secret seller text" }) }) as unknown as Response);
    const r = await classifyWithLuna(cfg, thread, { fetch: fetch as never });
    expect(r).toMatchObject({ status: "error", error: "HTTP 429" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("turns a network failure into an error result", async () => {
    const r = await classifyWithLuna(cfg, thread, { fetch: (async () => { throw new Error("boom"); }) as never });
    expect(r).toMatchObject({ status: "error", error: "network error" });
  });

  it("aborts after the timeout", async () => {
    const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const r = await classifyWithLuna({ ...cfg, timeoutMs: 20 }, thread, { fetch: fetch as never });
    expect(r).toMatchObject({ status: "error", error: "request timed out" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses a 15 second timeout by default", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }));
      const pending = classifyWithLuna(cfg, thread, { fetch: fetch as never });
      await vi.advanceTimersByTimeAsync(14_999);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(await pending).toMatchObject({ status: "error", error: "request timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects off-schema output, refusals and empty output", async () => {
    const bad = await classifyWithLuna(cfg, thread, { fetch: (async () => ok('{"outcome":"nope"}')) as never });
    expect(bad.status).toBe("error");
    const refusal = await classifyWithLuna(cfg, thread, {
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "message", content: [{ type: "refusal" }] }] }) }) as unknown as Response) as never,
    });
    expect(refusal).toMatchObject({ status: "error", error: "model refused" });
    const empty = await classifyWithLuna(cfg, thread, {
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ output: [] }) }) as unknown as Response) as never,
    });
    expect(empty.status).toBe("error");
  });
});
