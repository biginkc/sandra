import { describe, expect, it, vi } from "vitest";

import { classifyWithJev, JevProviderError } from "./jev-gateway";

function stubFetch(
  responses: Array<{ status: number; body: unknown; ok?: boolean }>,
): typeof fetch {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.ok ?? r.status < 400,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof fetch;
}

function baseInput() {
  return {
    conversationId: "conv-1",
    thread: [{ direction: "inbound" as const, body: "Who is this", sentAt: "2026-01-01T00:00:00Z" }],
    state: { propertyId: "prop-1" },
    includeReplyIntent: false,
  };
}

describe("classifyWithJev", () => {
  it("sends the documented question map with the reviewed new-lead rubric", async () => {
    const f = stubFetch([{ status: 200, body: { answers: { outcome: { choice: "new_lead", confidence: 0.76, probabilities: { new_lead: 0.9 } } } } }]);
    const result = await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" });
    const init = vi.mocked(f).mock.calls[0][1];
    const body = JSON.parse(String(init?.body));
    expect(Array.isArray(body.questions)).toBe(false);
    expect(body.model).toBe("jev-1.13.0");
    expect(body.questions.outcome.type).toBe("choice");
    expect(body.questions.outcome.instructions).toContain("latest inbound");
    expect(body.questions.outcome.criteria.new_lead).toContain("An outbound invitation alone");
    expect(body.questions.outcome.criteria.nurture).toContain("new_lead, not nurture");
    expect(result).toMatchObject({ outcome: "new_lead", outcomeConfidence: 0.76, schemaVersion: "2" });
    expect(result.probabilities.outcome.new_lead).toBe(0.9);
  });

  it.each([undefined, null, -1, 1.01, "0.99", NaN, Infinity])("does not accept invalid confidence %s", async (confidence) => {
    const f = stubFetch([{ status: 200, body: { answers: { outcome: { choice: "new_lead", confidence } } } }]);
    expect((await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" })).outcomeConfidence).toBeNull();
  });

  it("parses a valid outcome-only response", async () => {
    const f = stubFetch([
      {
        status: 200,
        body: {
          model: "jev-1.13.0",
          answers: { outcome: { choice: "not_interested", probabilities: { not_interested: 0.9 } } },
          usage: { input_tokens: 500, output_tokens: 10 },
        },
      },
    ]);
    const result = await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" });
    expect(result.outcome).toBe("not_interested");
    expect(result.provider).toBe("jev");
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 10 });
  });

  it("throws invalid_response when outcome is missing", async () => {
    const f = stubFetch([{ status: 200, body: { answers: {} } }]);
    await expect(classifyWithJev(baseInput(), { fetch: f, apiKey: "k" })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("retains unknown confidence when provider distributions and confidence are missing", async () => {
    const f = stubFetch([
      { status: 200, body: { answers: { outcome: { choice: "dnc" } } } },
    ]);
    const result = await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" });
    // Tolerate an incomplete provider answer without manufacturing certainty.
    expect(result.outcome).toBe("dnc");
    expect(result.probabilities.outcome).toEqual({});
    expect(result.outcomeConfidence).toBeNull();
  });

  it("treats an invalid enum choice as no answer, not a crash-through value", async () => {
    const f = stubFetch([
      { status: 200, body: { answers: { outcome: { choice: "not_a_real_outcome" } } } },
    ]);
    await expect(classifyWithJev(baseInput(), { fetch: f, apiKey: "k" })).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("does not retry on 401 and classifies as auth", async () => {
    const f = stubFetch([{ status: 401, body: { error: "bad key" }, ok: false }]);
    await expect(classifyWithJev(baseInput(), { fetch: f, apiKey: "k" })).rejects.toMatchObject({
      kind: "auth",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 402 and classifies as billing", async () => {
    const f = stubFetch([{ status: 402, body: { error: "no credits" }, ok: false }]);
    await expect(classifyWithJev(baseInput(), { fetch: f, apiKey: "k" })).rejects.toMatchObject({
      kind: "billing",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 up to maxRetries then throws rate_limited", async () => {
    const f = stubFetch([
      { status: 429, body: {}, ok: false },
      { status: 429, body: {}, ok: false },
      { status: 429, body: {}, ok: false },
    ]);
    await expect(
      classifyWithJev(baseInput(), { fetch: f, apiKey: "k", maxRetries: 2 }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("recovers after a transient 5xx then success", async () => {
    const f = stubFetch([
      { status: 500, body: {}, ok: false },
      {
        status: 200,
        body: { answers: { outcome: { choice: "wrong_number" } } },
      },
    ]);
    const result = await classifyWithJev(baseInput(), { fetch: f, apiKey: "k", maxRetries: 2 });
    expect(result.outcome).toBe("wrong_number");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("aborts and reports timeout when fetch never resolves within deadline", async () => {
    const f = vi.fn(
      (_url: string, opts: RequestInit) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;
    await expect(
      classifyWithJev(baseInput(), { fetch: f, apiKey: "k", timeoutMs: 5, maxRetries: 0 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("omits reply_intent from the decision when includeReplyIntent is false", async () => {
    const f = stubFetch([
      {
        status: 200,
        body: {
          answers: {
            outcome: { choice: "nurture" },
            reply_intent: { choice: "positive" },
          },
        },
      },
    ]);
    const result = await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" });
    expect(result.replyIntentAvailable).toBe(false);
    expect(result.replyIntent).toBeNull();
  });

  it("includes reply_intent when requested", async () => {
    const f = stubFetch([
      {
        status: 200,
        body: {
          answers: {
            outcome: { choice: "nurture" },
            reply_intent: { choice: "positive", probabilities: { positive: 0.8 } },
          },
        },
      },
    ]);
    const result = await classifyWithJev(
      { ...baseInput(), includeReplyIntent: true },
      { fetch: f, apiKey: "k" },
    );
    expect(result.replyIntentAvailable).toBe(true);
    expect(result.replyIntent).toBe("positive");
  });
});

describe("JevProviderError", () => {
  it("carries kind and status for downstream fallback routing", () => {
    const err = new JevProviderError("boom", "server_error", 503);
    expect(err.kind).toBe("server_error");
    expect(err.status).toBe(503);
    expect(err).toBeInstanceOf(Error);
  });
});
