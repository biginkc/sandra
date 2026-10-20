import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NineQuestionResult } from "@/lib/sms-classification/nine-questions";

/**
 * Mocked-harness coverage (no database) for the nine-question deferral and the
 * repeat-no rule, so CI exercises them; the DB-backed proof is in
 * nine-questions.dispatch.integration.test.ts.
 */
const h = vi.hoisted(() => ({
  classify: vi.fn(),
  pause: vi.fn(),
  closedUntil: null as Date | null,
}));

vi.mock("./nine-questions-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nine-questions-engine")>()),
  runNineClassification: h.classify,
  enrollNineDrip: vi.fn(async () => ({ status: "enrolled", sequenceId: "seq", enrollmentId: "enr" })),
}));
vi.mock("@/lib/sequences/enrollment", () => ({
  pausePropertyEnrollments: h.pause,
  pauseContactEnrollments: vi.fn(),
  enrollLead: vi.fn(),
}));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/events")>()),
  recordLeadEvent: vi.fn(),
}));
const open = (at?: Date) => !h.closedUntil || (at ?? new Date()).getTime() >= h.closedUntil.getTime();
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: (_s: unknown, at?: Date) => (open(at) ? { ok: true } : { ok: false, reason: "outside_window" }),
}));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: (_p: unknown, at?: Date) =>
    open(at) ? { ok: true, state: "MO", localTime: "12:00", florida: false } : { ok: false, reason: "outside_window", state: "MO", localTime: "22:00" },
}));

import { NINE_DEFER_MAX, runNineQuestionsStep } from "./dispatch";

type Tables = Record<string, unknown[]>;

/** Chainable fake: every query resolves to the table's rows; rpc calls are recorded. */
function fakeSupabase(tables: Tables, rpcResult: Record<string, unknown> = {}) {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const chain = (table: string) => {
    const rows = tables[table] ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "ilike", "gte", "lte", "order", "limit", "update", "insert", "upsert", "delete"]) {
      c[m] = () => c;
    }
    c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    c.single = async () => ({ data: rows[0] ?? null, error: null });
    c.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
    return c;
  };
  const client = {
    from: (t: string) => chain(t),
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { data: rpcResult[name] ?? null, error: null };
    },
  };
  return { client: client as never, rpcCalls };
}

const NOT_INTERESTED: NineQuestionResult = {
  answer: "not_interested",
  probabilities: { not_interested: 0.85 } as NineQuestionResult["probabilities"],
  chosen: { id: "not_interested", probability: 0.85 },
  cutoff: 0.6,
  latencyMs: 1,
  model: "jev-test",
  usage: null,
};

function args(over: Record<string, unknown> = {}) {
  return {
    input: { propertyId: "p1", contactId: "c1", conversationId: "conv1", inboundMessageId: "in1", inboundBody: "No" },
    property: { id: "p1", org_id: "org1", state: "MO", ai_responder_disabled: false, homeowner_contact_id: "c1", last_ai_escalation_reason: null, needs_human_attention: false, outreach_dispo: null },
    claim: { claimId: null },
    replyIneligibleReason: "outside_business_hours",
    ...over,
  } as never;
}

beforeEach(() => {
  h.classify.mockReset();
  h.classify.mockResolvedValue({ kind: "ok", result: NOT_INTERESTED, classificationRunId: "run1", evaluationRevision: 7, ourLastText: null });
  h.pause.mockReset();
  h.pause.mockResolvedValue({ paused: 1, enrollmentIds: ["e1"] });
  h.closedUntil = new Date(Date.now() + 2 * 3600_000);
});

describe("nine-question deferral (mocked)", () => {
  it("outside business hours: a retry until the window opens, carrying the decision", async () => {
    const { client } = fakeSupabase({ messages: [] });
    const out = (await runNineQuestionsStep(client, args())) as { outcome: string; reason: string; delaySeconds: number; nineDeferral: { count: number; revision: number; classificationRunId: string } };
    expect(out.outcome).toBe("retry");
    expect(out.reason).toBe("nine_reply_deferred");
    expect(out.delaySeconds).toBeGreaterThanOrEqual(2 * 3600);
    expect(out.nineDeferral).toMatchObject({ count: 1, revision: 7, classificationRunId: "run1" });
  });

  it("no reply delay configured: never deferred (the template is dropped and held)", async () => {
    const { client } = fakeSupabase({ messages: [] });
    const a = args({ input: { propertyId: "p1", contactId: "c1", conversationId: "conv1", inboundMessageId: "in1", inboundBody: "No", replyDelayBypassed: true, replyDelayBypassReason: "delay_not_configured" } });
    expect(await runNineQuestionsStep(client, a)).toEqual({ outcome: "escalated", reason: "nine_reply_not_sent:reply_ineligible" });
  });

  it("a deferred run reuses the decision (no Jev call); a moved revision holds", async () => {
    const deferral = { count: 1, revision: 7, result: NOT_INTERESTED, classificationRunId: "run1" };
    const input = { propertyId: "p1", contactId: "c1", conversationId: "conv1", inboundMessageId: "in1", inboundBody: "No", nineDeferral: deferral };
    const moved = fakeSupabase({ messages: [], properties: [{ decision_context_revision: 8 }] });
    expect(await runNineQuestionsStep(moved.client, args({ input }))).toEqual({ outcome: "escalated", reason: "nine_deferred_context_changed" });
    const same = fakeSupabase({ messages: [], properties: [{ decision_context_revision: 7 }] });
    const out = (await runNineQuestionsStep(same.client, args({ input }))) as { outcome: string; nineDeferral: { count: number } };
    expect(out.outcome).toBe("retry");
    expect(out.nineDeferral.count).toBe(2);
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("at NINE_DEFER_MAX deferrals: held for a person", async () => {
    const deferral = { count: NINE_DEFER_MAX, revision: 7, result: NOT_INTERESTED, classificationRunId: "run1" };
    const input = { propertyId: "p1", contactId: "c1", conversationId: "conv1", inboundMessageId: "in1", inboundBody: "No", nineDeferral: deferral };
    const { client } = fakeSupabase({ messages: [], properties: [{ decision_context_revision: 7 }] });
    expect(await runNineQuestionsStep(client, args({ input }))).toEqual({ outcome: "escalated", reason: "nine_reply_not_sent:reply_ineligible" });
  });
});

describe("repeat-no rule (mocked)", () => {
  const sentBefore = [{ id: "m1", status: "delivered", external_id: "x" }];

  it("already got the not-interested reply: nothing sent, marked not interested, drip stopped", async () => {
    const { client, rpcCalls } = fakeSupabase(
      { messages: sentBefore, jev_outcome_thresholds: [{ outcome: "not_interested", min_confidence: 0.9, version: 1, automation_enabled: true }] },
      { fn_apply_ai_disposition_with_review: { status: "applied" } },
    );
    const out = await runNineQuestionsStep(client, args());
    expect(out).toEqual({ outcome: "auto_closed", reason: "nine_questions:not_interested_again" });
    const dispo = rpcCalls.find((c) => c.name === "fn_apply_ai_disposition_with_review");
    expect(dispo?.args).toMatchObject({ p_disposition: "not_interested", p_expected_revision: 7 });
    expect(h.pause).toHaveBeenCalledWith(client, { propertyId: "p1", reason: "status_terminal", permanent: true });
  });

  it("not_interested switch off: held for a person, nothing changed", async () => {
    const { client, rpcCalls } = fakeSupabase({ messages: sentBefore, jev_outcome_thresholds: [{ outcome: "not_interested", min_confidence: 0.9, version: 1, automation_enabled: false }] });
    expect(await runNineQuestionsStep(client, args())).toEqual({ outcome: "escalated", reason: "nine_automation_disabled:not_interested" });
    expect(rpcCalls.some((c) => c.name === "fn_apply_ai_disposition_with_review")).toBe(false);
    expect(h.pause).not.toHaveBeenCalled();
  });

  it("price wording still wins: hot hold, no disposition", async () => {
    const { client, rpcCalls } = fakeSupabase({ messages: sentBefore, jev_outcome_thresholds: [{ outcome: "not_interested", min_confidence: 0.9, version: 1, automation_enabled: true }] });
    const a = args({ input: { propertyId: "p1", contactId: "c1", conversationId: "conv1", inboundMessageId: "in1", inboundBody: "no, unless how much would you pay" } });
    expect(await runNineQuestionsStep(client, a)).toEqual({ outcome: "escalated", reason: "keyword:price_offer" });
    expect(rpcCalls.some((c) => c.name === "fn_apply_ai_disposition_with_review")).toBe(false);
  });
});
