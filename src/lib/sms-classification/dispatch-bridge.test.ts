import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { classifyForDispatch } from "./dispatch-bridge";

function stubSupabase(opts: {
  messages?: unknown[];
  insertResult?: { data: { id: string } | null; error: { message: string } | null };
  existingRunLookup?: { data: { id: string } | null; error: { message: string } | null };
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
  const runsSelectBuilder = {
    eq: () => runsSelectBuilder,
    maybeSingle: async () =>
      opts.existingRunLookup ?? { data: { id: "run-1" }, error: null },
  };
  const runsBuilder = {
    insert: () => ({
      select: () => ({
        maybeSingle: async () =>
          opts.insertResult ?? { data: { id: "run-1" }, error: null },
      }),
    }),
    select: () => runsSelectBuilder,
  };
  return {
    from: (table: string) => (table === "messages" ? messagesBuilder : runsBuilder),
  } as any;
}

function stubFetch(body: unknown, ok = true): { fn: typeof fetch; calls: () => any[] } {
  const calls: any[] = [];
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const baseInput = {
  orgId: "org-1",
  propertyId: "prop-1",
  contactId: "contact-1",
  conversationId: "conv-1",
  inboundMessageId: "msg-1",
  inboundBody: "please stop texting me",
};

describe("classifyForDispatch", () => {
  it.each(["shadow", "automatic"] as const)("handles new_lead in %s mode without auto-accept", async (mode) => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "new_lead", confidence: 1 }, escalation_reason: { choice: "call_request" } } });
    const result = await classifyForDispatch(stubSupabase({}), baseInput,
      { classifierProvider: "jev", classifierMode: mode }, { fetch: fn, typesafeApiKey: "k" });
    if (mode === "shadow") expect(result).toEqual({ kind: "use_legacy", classificationRunId: "run-1" });
    else expect(result).toMatchObject({ kind: "jev_route", eligibleForAutoAccept: false, route: { kind: "escalate", reason: "model:call_request" } });
  });

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

  it("includes the current inbound body in the request sent to Jev, not just prior history", async () => {
    // Astra PR review finding (2026-09-20): the bridge originally sent
    // only buildTwoWayThreadState's prior-history rows, never the
    // message actually being classified.
    const { fn, calls } = stubFetch({ answers: { outcome: { choice: "not_interested" } } });
    await classifyForDispatch(
      stubSupabase({ messages: [] }),
      baseInput,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    const sentBody = JSON.parse(String(calls()[0].body));
    const threadBodies = sentBody.state.thread.map((m: { body: string }) => m.body);
    expect(threadBodies).toContain(baseInput.inboundBody);
    expect(sentBody.state.thread.at(-1)).toMatchObject({
      direction: "inbound",
      body: baseInput.inboundBody,
    });
  });

  it("returns use_legacy in shadow mode even when Jev succeeds, but persists the run", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "not_interested" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: "run-1" });
  });

  it("returns use_legacy in shadow mode even for a nurture outcome (not jev_nurture)", async () => {
    // Fable-flagged gap (2026-09-20 PR review): shadow must never act on
    // ANY Jev result, not just route-shaped ones. The mode gate in
    // dispatch-bridge.ts runs before resolvePolicyOutcome is even called,
    // so nurture/no_action are never reachable in shadow mode — this
    // guards against a future reordering silently reintroducing that bug.
    const { fn } = stubFetch({ answers: { outcome: { choice: "nurture" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: "run-1" });
  });

  it("returns use_legacy in shadow mode even for a no_action outcome (not jev_no_action)", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "unclear" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "shadow" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: "run-1" });
  });

  it("returns jev_route in automatic mode for a routable outcome", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result.kind).toBe("jev_route");
    if (result.kind === "jev_route") {
      expect(result.route.kind).toBe("close_dnc");
      // dnc is never eligible for auto-accept regardless of mode.
      expect(result.eligibleForAutoAccept).toBe(false);
    }
  });

  it("marks non-dnc automatic decisions eligible for auto-accept", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "opted_out" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    if (result.kind === "jev_route") expect(result.eligibleForAutoAccept).toBe(true);
    else throw new Error("expected jev_route");
  });

  it("returns jev_nurture even in automatic mode (no AiAction exists for nurture)", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "nurture" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "jev_nurture", classificationRunId: "run-1" });
  });

  it("returns jev_no_action for bad_number/unclear", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "unclear" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "jev_no_action", classificationRunId: "run-1" });
  });

  it("falls back to use_legacy when Jev's HTTP call fails, without throwing", async () => {
    const { fn } = stubFetch({}, false);
    const result = await classifyForDispatch(
      stubSupabase({}),
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
  });

  it("falls back to use_legacy when the audit insert fails for a non-duplicate reason", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const supabase = stubSupabase({
      insertResult: { data: null, error: { message: "db down" } },
    });
    const result = await classifyForDispatch(
      supabase,
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
  });

  it("recovers the existing row id on a duplicate-key insert instead of failing", async () => {
    // Astra PR review finding (2026-09-20): the original .upsert() call
    // required UPDATE privilege the service_role doesn't have. Fixed to
    // a plain INSERT + fallback lookup on a real duplicate key.
    const { fn } = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const supabase = stubSupabase({
      insertResult: {
        data: null,
        error: { message: "duplicate key value violates unique constraint" },
      },
      existingRunLookup: { data: { id: "existing-run-42" }, error: null },
    });
    const result = await classifyForDispatch(
      supabase,
      baseInput,
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result.kind).toBe("jev_route");
    if (result.kind === "jev_route") {
      expect(result.classificationRunId).toBe("existing-run-42");
    }
  });

  it("returns use_legacy without calling Jev when conversationId/inboundMessageId are missing", async () => {
    const { fn } = stubFetch({ answers: { outcome: { choice: "dnc" } } });
    const result = await classifyForDispatch(
      stubSupabase({}),
      { ...baseInput, conversationId: null, inboundMessageId: null },
      { classifierProvider: "jev", classifierMode: "automatic" },
      { fetch: fn, typesafeApiKey: "k" },
    );
    expect(result).toEqual({ kind: "use_legacy", classificationRunId: null });
  });
});
