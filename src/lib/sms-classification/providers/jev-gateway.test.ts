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
    expect(result).toMatchObject({ outcome: "new_lead", outcomeConfidence: 0.76, schemaVersion: "3" });
    expect(result.probabilities.outcome.new_lead).toBe(0.9);
  });

  it("pins the Jarrad-approved nurture routing questions character for character (2026-10-07)", async () => {
    const f = stubFetch([{ status: 200, body: { answers: { outcome: { choice: "nurture" } } } }]);
    await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" });
    const body = JSON.parse(String(vi.mocked(f).mock.calls[0][1]?.body));
    expect(body.questions.ready_timeframe).toEqual({
      type: "choice",
      instructions: "If the seller indicates when they might be ready to sell, which timeframe does the latest inbound message support?",
      criteria: {
        within_30_days: "Ready or open to selling within about a month.",
        one_to_six_months: "Indicates roughly one to six months.",
        six_to_twelve_months: "Indicates roughly six to twelve months.",
        over_a_year: "Indicates more than a year away.",
        not_stated: "No timeframe given.",
        uncertain: "A timeframe is mentioned but cannot be determined.",
      },
    });
    expect(body.questions.listing_status).toEqual({
      type: "choice",
      instructions: "Does the seller say the property is currently listed for sale or being shown?",
      criteria: {
        listed: "The seller says it is listed with an agent or has showings.",
        not_listed_or_not_stated: "The seller does not say it is listed.",
        uncertain: "Cannot tell from the message.",
      },
    });
  });

  it("parses ready_timeframe and listing_status, and treats invalid or missing choices as null", async () => {
    const f = stubFetch([{ status: 200, body: { answers: {
      outcome: { choice: "nurture" },
      ready_timeframe: { choice: "six_to_twelve_months", probabilities: { six_to_twelve_months: 0.8 } },
      listing_status: { choice: "bogus" },
    } } }]);
    const result = await classifyWithJev(baseInput(), { fetch: f, apiKey: "k" });
    expect(result.readyTimeframe).toBe("six_to_twelve_months");
    expect(result.listingStatus).toBeNull();
    expect(result.probabilities.ready_timeframe).toEqual({ six_to_twelve_months: 0.8 });
    const g = stubFetch([{ status: 200, body: { answers: { outcome: { choice: "nurture" } } } }]);
    const none = await classifyWithJev(baseInput(), { fetch: g, apiKey: "k" });
    expect(none.readyTimeframe).toBeNull();
    expect(none.listingStatus).toBeNull();
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
