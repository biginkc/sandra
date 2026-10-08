import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportErrorMock, recordStepMock, threadMock } = vi.hoisted(() => ({
  reportErrorMock: vi.fn(),
  recordStepMock: vi.fn(async () => undefined),
  threadMock: vi.fn(async () => [{ direction: "outbound", body: "Hi, still interested?", sentAt: "2026-10-07T10:00:00Z" }]),
}));

vi.mock("@/lib/errors/report", () => ({ reportError: reportErrorMock }));
vi.mock("@/lib/pipeline-runs", () => ({ recordStep: recordStepMock }));
vi.mock("../context", () => ({ buildTwoWayThreadState: threadMock }));

import { requestLunaSuggestion, type LunaSuggestInput } from "./suggest";

const ENV = { LUNA_SUGGESTIONS_ENABLED: "1", OPENAI_API_KEY: "sk-test", LUNA_MODEL: "gpt-6-luna" };

function fakeSupabase(opts: { source?: { created_at: string } | null; insertError?: { code?: string; message: string } | null } = {}) {
  const inserts: unknown[] = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: opts.source === undefined ? { created_at: "2026-10-07T11:00:00Z" } : opts.source, error: null }),
    insert: async (row: unknown) => {
      inserts.push(row);
      return { error: opts.insertError ?? null };
    },
  };
  return { client: { from: vi.fn(() => builder) } as never, inserts };
}

const input: LunaSuggestInput = {
  orgId: "org-1",
  propertyId: "prop-1",
  contactId: "contact-1",
  conversationId: "conv-1",
  inboundMessageId: "msg-1",
  inboundBody: "maybe later, not sure",
  jevOutcome: "nurture",
  runContext: { runId: "run-1", orgId: "org-1", seq: 0 },
};

const okResult = { status: "ok", outcome: "new_lead", confidence: 0.91, escalationReason: "hot_lead", model: "gpt-6-luna", usage: null, latencyMs: 400 } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requestLunaSuggestion", () => {
  it("makes no call and writes nothing when the flag is off", async () => {
    const { client, inserts } = fakeSupabase();
    const classify = vi.fn();
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: { OPENAI_API_KEY: "k" }, classify });
    expect(r).toEqual({ status: "skipped", reason: "disabled" });
    expect(classify).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(recordStepMock).not.toHaveBeenCalled();
  });

  it("makes no call when the key is missing", async () => {
    const { client } = fakeSupabase();
    const classify = vi.fn();
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: { LUNA_SUGGESTIONS_ENABLED: "1" }, classify });
    expect(r.status).toBe("skipped");
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    ["Jev opted_out", { jevOutcome: "opted_out" as const }, "jev_opted_out"],
    ["Jev dnc", { jevOutcome: "dnc" as const }, "jev_dnc"],
    ["a STOP signal", { inboundBody: "STOP" }, "stop_signal"],
    ["a do-not-contact phrase", { inboundBody: "don't text me again" }, "stop_signal"],
    ["an escalation keyword", { inboundBody: "talk to my attorney" }, "escalation_keyword"],
  ])("makes no call for %s and records why", async (_n, patch, reason) => {
    const { client, inserts } = fakeSupabase();
    const classify = vi.fn();
    const r = await requestLunaSuggestion(client, { ...input, ...patch }, { fetch: vi.fn() as never, env: ENV, classify });
    expect(r).toEqual({ status: "skipped", reason });
    expect(classify).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
    expect(recordStepMock).toHaveBeenCalledWith(client, input.runContext, expect.objectContaining({ kind: "action", name: "luna_suggest", result: "skipped", detail: expect.objectContaining({ reason }) }));
  });

  it("stores the suggestion and records a luna_suggest step with no message text", async () => {
    const { client, inserts } = fakeSupabase();
    const classify = vi.fn(async () => okResult);
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: ENV, classify });
    expect(r).toEqual({ status: "stored", outcome: "new_lead", confidence: 0.91 });
    expect(inserts).toEqual([{ org_id: "org-1", property_id: "prop-1", inbound_message_id: "msg-1", outcome: "new_lead", confidence: 0.91, model: "gpt-6-luna" }]);
    expect(classify).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-test", model: "gpt-6-luna", timeoutMs: 15_000 }),
      [{ direction: "outbound", body: "Hi, still interested?", sentAt: "2026-10-07T10:00:00Z" }, { direction: "inbound", body: "maybe later, not sure" }],
      expect.anything(),
    );
    const step = recordStepMock.mock.calls.at(-1) as unknown as [unknown, unknown, { name: string; result: string; detail: Record<string, unknown> }];
    expect(step[2]).toMatchObject({ name: "luna_suggest", result: "pass", detail: { outcome: "new_lead", confidence: 0.91, jevOutcome: "nurture" } });
    expect(JSON.stringify(step[2])).not.toContain("maybe later");
  });

  it("stores a Luna opted_out / dnc pick too (the card routes it to a human)", async () => {
    const { client, inserts } = fakeSupabase();
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: ENV, classify: vi.fn(async () => ({ ...okResult, outcome: "opted_out" as const })) });
    expect(r.status).toBe("stored");
    expect(inserts).toHaveLength(1);
  });

  it("records an error step and stores nothing when Luna fails", async () => {
    const { client, inserts } = fakeSupabase();
    const r = await requestLunaSuggestion(client, input, {
      fetch: vi.fn() as never,
      env: ENV,
      classify: vi.fn(async () => ({ status: "error" as const, error: "HTTP 500", model: "gpt-6-luna", latencyMs: 9 })),
    });
    expect(r).toEqual({ status: "error", reason: "HTTP 500" });
    expect(inserts).toEqual([]);
    expect(recordStepMock).toHaveBeenCalledWith(client, input.runContext, expect.objectContaining({ result: "error" }));
  });

  it("treats a duplicate insert (dispatch retry) as already suggested", async () => {
    const { client } = fakeSupabase({ insertError: { code: "23505", message: "dup" } });
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: ENV, classify: vi.fn(async () => okResult) });
    expect(r).toEqual({ status: "duplicate" });
  });

  it("skips when the source message cannot be verified", async () => {
    const { client } = fakeSupabase({ source: null });
    const classify = vi.fn();
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: ENV, classify });
    expect(r).toEqual({ status: "skipped", reason: "source_message_not_found" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("never throws, even when storing fails", async () => {
    const { client } = fakeSupabase({ insertError: { message: "db down" } });
    const r = await requestLunaSuggestion(client, input, { fetch: vi.fn() as never, env: ENV, classify: vi.fn(async () => okResult) });
    expect(r).toEqual({ status: "error", reason: "unexpected" });
    expect(reportErrorMock).toHaveBeenCalled();
  });
});
