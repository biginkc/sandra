import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { classifyForDispatch } from "./dispatch-bridge";

function stubSupabase(opts: {
  messages?: unknown[];
  upsertResult?: { data: { id: string } | null; error: { message: string } | null };
  insertResult?: { error: { message: string } | null };
}) {
  const messagesBuilder = {
    select: () => messagesBuilder,
    eq: () => messagesBuilder,
    order: () => messagesBuilder,
    limit: () => messagesBuilder,
    neq: () => messagesBuilder,
    then: (resolve: (r: { data: unknown[] }) => void) =>
      resolve({ data: opts.messages ?? [] }),
  };
  const runsBuilder = {
    upsert: () => ({
      select: () => ({
        maybeSingle: async () =>
          opts.upsertResult ?? { data: { id: "run-1" }, error: null },
      }),
    }),
    insert: async () => opts.insertResult ?? { error: null },
  };
  return {
    from: (table: string) => (table === "messages" ? messagesBuilder : runsBuilder),
  } as any;
}

function stubFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

const baseInput = {
  orgId: "org-1",
  propertyId: "prop-1",
  contactId: "contact-1",
  conversationId: "conv-1",
  inboundMessageId: "msg-1",
};

describe("classifyForDispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns use_legacy immediately when provider is legacy, without calling fetch", async () => {
    const fetchFn = vi.fn();
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "legacy", classifierMode: "shadow" },
      { fetch: fetchFn as unknown as typeof fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns use_legacy in shadow mode even when Jev succeeds, but persists the run", async () => {
    const fetch = stubFetch({ answers: { outcome: { choice: "not_interested" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: "run-1" });
  });

  it("returns jev_route in automatic mode for a routable outcome", async () => {
    const fetch = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result.kind).toBe("jev_route");
    if (result.kind === "jev_route") {
      expect(result.route.kind).toBe("close_dnc");
      // dnc is never eligible for auto-accept regardless of mode.
      expect(result.eligibleForAutoAccept).toBe(false);
    }
  });

  it("marks non-dnc automatic decisions eligible for auto-accept", async () => {
    const fetch = stubFetch({ answers: { outcome: { choice: "opted_out" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    if (result.kind === "jev_route") expect(result.eligibleForAutoAccept).toBe(true);
    else throw new Error("expected jev_route");
  });

  it("returns jev_nurture even in automatic mode (no AiAction exists for nurture)", async () => {
    const fetch = stubFetch({ answers: { outcome: { choice: "nurture" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "jev_nurture", classificationRunId: "run-1" });
  });

  it("returns jev_no_action for bad_number/unclear", async () => {
    const fetch = stubFetch({ answers: { outcome: { choice: "unclear" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "jev_no_action", classificationRunId: "run-1" });
  });

  it("falls back to use_legacy when Jev's HTTP call fails, without throwing", async () => {
    const fetch = stubFetch({}, false);
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
  });

  it("falls back to use_legacy when the audit write fails, even if Jev succeeded", async () => {
    const fetch = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const supabase = stubSupabase({
      upsertResult: { data: null, error: { message: "db down" } },
    });
    const result = await classifyForDispatch(
      supabase,
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
  });

  it("returns use_legacy without calling Jev when conversationId/inboundMessageId are missing", async () => {
    // persistRun requires both ids (matches setResponderDispo's own
    // "missing thread identity" guard) — a run without them can't be
    // linked to a review row, so there's nothing to auto-accept anyway.
    const fetch = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      { ...baseInput, conversationId: null, inboundMessageId: null },
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
  });
});
