import { beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_OFF, type RoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";

/**
 * Routing v2 cutover (a): the live dispatch hook, mocked (no database). Stage tests:
 * all off = today's engine (null, no provider call); questions_live on + not eligible = today's
 * engine; eligible = v2 (classify -> immutable evidence -> one atomic transition from the
 * STORED row). The DB-backed transition proofs are the 310000/320000 migration suites.
 */
const h = vi.hoisted(() => ({
  flags: null as unknown as RoutingV2Flags,
  flagsUnreadable: false,
  v2Enrollments: [] as Array<{ id: string }>,
  v2Decisions: [] as Array<{ id: string }>,
  classify: vi.fn(),
  record: vi.fn(),
  evidence: vi.fn(),
  transition: vi.fn(),
  stop: vi.fn(),
  phone: vi.fn(),
  legacy: vi.fn(),
}));
vi.mock("@/lib/sms-classification/dispatch-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-classification/dispatch-bridge")>()),
  classifyForDispatch: h.legacy,
}));
vi.mock("@/lib/sms-classification/routing-v2/model-stop-suppression", () => ({ executeV2Stop: h.stop }));
vi.mock("@/lib/sms-classification/routing-v2/wrong-number-all", () => ({ runRoutingV2PhoneAction: h.phone }));
vi.mock("@/lib/sms-classification/routing-v2/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-classification/routing-v2/flags")>()),
  readRoutingV2Flags: vi.fn(async () => h.flags),
  readRoutingV2FlagsResult: vi.fn(async () => (h.flagsUnreadable ? { ok: false } : { ok: true, flags: h.flags })),
}));
vi.mock("@/lib/sms-classification/routing-v2/classify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-classification/routing-v2/classify")>()),
  classifyV2: h.classify,
}));
vi.mock("@/lib/sms-classification/routing-v2/live-decisions", () => ({ recordLiveV2Decision: h.record }));
vi.mock("@/lib/sms-classification/routing-v2/live-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-classification/routing-v2/live-dispatch")>()),
  readLiveV2Evidence: h.evidence,
}));
vi.mock("@/lib/sms-classification/routing-v2/live-transition", () => ({ applyStoredV2Transition: h.transition }));
vi.mock("@/lib/sms-classification/context", () => ({ buildTwoWayThreadState: vi.fn(async () => []) }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { buildTwoWayThreadState } from "@/lib/sms-classification/context";
import { runRoutingV2LiveStep } from "./dispatch";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ON: RoutingV2Flags = { ...ALL_OFF, questions_live: true, replies: true, drips: true, canaryPropertyIds: new Set([PROPERTY]) };

function fakeSupabase() {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const chain = (table: string) => {
    const rows = table === "properties" ? [{ decision_context_revision: 7 }] : table === "messages" ? [{ created_at: "2026-10-30T12:00:00Z" }] : table === "sequence_enrollments" ? h.v2Enrollments : table === "routing_v2_live_decisions" ? h.v2Decisions : [];
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "ilike", "gte", "lte", "order", "limit", "update", "insert", "upsert", "delete"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    c.single = async () => ({ data: rows[0] ?? null, error: null });
    c.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
    return c;
  };
  const client = {
    from: (t: string) => chain(t),
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "routing_v2_record_live_hold") return { data: { outcome: "held", alerts_queued: 1 }, error: null };
      return { data: null, error: null };
    },
  };
  return { client: client as never, rpcCalls };
}

function args(body = "Who is this?", property = PROPERTY) {
  return {
    input: { propertyId: property, contactId: "c1", conversationId: "conv1", inboundMessageId: "in1", inboundBody: body, inboundFromPhone: "+18165550100" },
    property: { id: property, org_id: "org1", state: "MO", ai_responder_disabled: false, homeowner_contact_id: "c1", last_ai_escalation_reason: null, needs_human_attention: false, outreach_dispo: null },
    claim: { claimId: null },
  } as never;
}

const evidence = (action: unknown, over: Record<string, unknown> = {}) => ({
  status: "decided", org_id: "org1", property_id: PROPERTY, road: (action as { road: string }).road, jev_road: (action as { road: string }).road,
  provenance: { by: "jev", row: "15", step: "asked_who", signal: "asked_who", probability: 0.9 }, haiku_eligibility: null, haiku: null,
  opportunity_alert: false, action, expected_revision: 7, failure_reason: null, ...over,
});
const WHO = { road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }, { kind: "drip", drip: "Asked who is texting", skipFirstStep: true }] };

beforeEach(() => {
  h.flags = ON;
  h.flagsUnreadable = false;
  h.v2Enrollments = [];
  h.v2Decisions = [];
  for (const f of [h.classify, h.record, h.evidence, h.transition, h.stop, h.phone, h.legacy]) f.mockReset();
  h.legacy.mockResolvedValue({ kind: "jev_no_action", askedHowNumberObtained: undefined });
  h.stop.mockResolvedValue({ kind: "human_review", reason: "flag_off" });
  h.phone.mockResolvedValue({ outcome: "flag_off" });
  h.classify.mockResolvedValue({ kind: "decided", action: { road: "ALERT_call_me", steps: [{ kind: "alert", reason: "call_me" }] } });
  h.record.mockResolvedValue("recorded");
  h.evidence.mockResolvedValue(evidence(WHO));
  h.transition.mockResolvedValue({ kind: "applied", transition: { outcome: "applied" } });
});

describe("routing v2 live dispatch hook", () => {
  it("all flags off: today's engine, no provider call, no write", async () => {
    h.flags = ALL_OFF;
    const { client, rpcCalls } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toBeNull();
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it("H1(i): unreadable flags on a lead v2 already routed hold for a person, never the legacy engine (no orphan paused drip)", async () => {
    h.flagsUnreadable = true;
    h.v2Enrollments = [{ id: "e1" }];
    const { client, rpcCalls } = fakeSupabase();
    const out = await runRoutingV2LiveStep(client, args());
    expect(out).not.toBeNull();
    expect(h.classify).not.toHaveBeenCalled();
    expect(JSON.stringify({ out, rpcCalls })).toContain("nine_needs_person");
  });

  it("N-2: unreadable flags on a lead with only a v2 decision / audit row (no enrollment) also hold", async () => {
    h.flagsUnreadable = true;
    h.v2Decisions = [{ id: "d1" }];
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).not.toBeNull();
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("unreadable flags on a lead v2 never touched: today's engine exactly (null)", async () => {
    h.flagsUnreadable = true;
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toBeNull();
  });

  it("questions_live on but the property is not canary-eligible: today's engine", async () => {
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args("Who?", "22222222-2222-4222-8222-222222222222"))).toBeNull();
    expect(h.classify).not.toHaveBeenCalled();
  });

  it("a legacy deferral keeps today's engine", async () => {
    const { client } = fakeSupabase();
    const a = args() as unknown as { input: Record<string, unknown> };
    a.input.nineDeferral = { count: 1 };
    expect(await runRoutingV2LiveStep(client, a as never)).toBeNull();
  });

  it("eligible: classify -> record evidence (at the pre-classify revision) -> one transition", async () => {
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toEqual({ outcome: "auto_closed", reason: "routing_v2:who_reply_drip" });
    expect(h.classify).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledWith(client, expect.objectContaining({ expectedRevision: 7, inboundMessageId: "in1" }), expect.objectContaining({ kind: "decided" }), null);
    expect(h.transition).toHaveBeenCalledExactlyOnceWith(client, { orgId: "org1", propertyId: PROPERTY, contactId: "c1", inboundMessageId: "in1" });
  });

  it("A-6 nit: a thread build that throws before Jev records no Jev ledger row (still a failed decision)", async () => {
    vi.mocked(buildTwoWayThreadState).mockRejectedValueOnce(new Error("thread boom"));
    const { client, rpcCalls } = fakeSupabase();
    await runRoutingV2LiveStep(client, args());
    expect(h.classify).not.toHaveBeenCalled();
    expect(rpcCalls.filter((c) => c.name === "fn_record_model_call")).toEqual([]);
    // Round 17 (A): a failed classification is a safety decision: recorded with its hold reason.
    expect(h.record).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ kind: "failed", reason: "jev_failed", jevAttempts: [] }), "jev_automatic_failed:jev_failed");
  });

  it("a duplicate run acts only on the stored original", async () => {
    h.record.mockResolvedValue("duplicate");
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toMatchObject({ outcome: "auto_closed" });
    expect(h.evidence).toHaveBeenCalledWith(client, "in1");
  });

  it("evidence that cannot be recorded holds (never acts on unrecorded output)", async () => {
    h.record.mockResolvedValue("failed");
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toEqual({ outcome: "escalated", reason: "nine_needs_person" });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it("a failed classification is today's classifier-failure hold", async () => {
    h.evidence.mockResolvedValue({ ...evidence(WHO), status: "failed", action: null, failure_reason: "jev_failed" });
    const { client } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toEqual({ outcome: "escalated", reason: "jev_automatic_failed:jev_failed" });
  });

  it("a Haiku hold queues the stored owner alert and holds with an existing reason", async () => {
    h.evidence.mockResolvedValue(evidence({ road: "haiku_unsure", steps: [{ kind: "hold", reason: "needs_person" }, { kind: "alert", reason: "haiku_unsure" }] }));
    const { client, rpcCalls } = fakeSupabase();
    expect(await runRoutingV2LiveStep(client, args())).toEqual({ outcome: "escalated", reason: "nine_needs_person" });
    const hold = rpcCalls.find((c) => c.name === "routing_v2_record_live_hold");
    expect(hold?.args).toMatchObject({ p_decision: { outbox: [{ kind: "alert", payload: { reason: "haiku_unsure" } }], sequence_key: null } });
    expect(h.transition).not.toHaveBeenCalled();
  });

  it("possible stop holds as a stop request; hostile wording waits for confirmation", async () => {
    h.evidence.mockResolvedValue(evidence({ road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] }));
    expect(await runRoutingV2LiveStep(fakeSupabase().client, args("please stop"))).toEqual({ outcome: "escalated", reason: "nine_asked_stop" });
    expect((await runRoutingV2LiveStep(fakeSupabase().client, args("this is harassment")) as { reason: string }).reason).toMatch(/^hostile_needs_confirm/);
  });

  it.each([
    ["no_sequence", { outcome: "escalated", reason: "nine_needs_person" }],
    ["context_changed", { outcome: "escalated", reason: "nine_needs_person" }],
    ["flag_off", { outcome: "escalated", reason: "nine_needs_person" }],
    ["superseded", { outcome: "skipped", reason: "superseded_by_newer_inbound" }],
  ])("transition refusal %s", async (reason, expected) => {
    h.transition.mockResolvedValue({ kind: "refused", reason, alertsQueued: 0 });
    expect(await runRoutingV2LiveStep(fakeSupabase().client, args())).toEqual(expected);
  });

  describe("step (c): stop and phone-level adapters", () => {
    const STOP = { road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }] };
    const WRONG = { road: "wrong_number_close", steps: [{ kind: "wrong_number_close" }] };
    const BOUNCE = { road: "bad_number", steps: [{ kind: "hold", reason: "bad_number" }] };
    it("a confident Jev stop with model_stop_suppression on: model_stop suppression, nothing sent", async () => {
      h.evidence.mockResolvedValue(evidence(STOP, { provenance: { by: "jev", row: "2", step: "asked_stop", signal: "asked_stop", probability: 0.92 } }));
      h.stop.mockResolvedValue({ kind: "suppressed", suppressionId: "s1", status: "suppressed" });
      expect(await runRoutingV2LiveStep(fakeSupabase().client, args("stop texting me"))).toEqual({ outcome: "opted_out", reason: "routing_v2:model_stop" });
      expect(h.stop).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phone: "+18165550100", inboundMessageId: "in1", decision: expect.objectContaining({ road: "stop" }) }), expect.anything());
      expect(h.transition).not.toHaveBeenCalled();
    });
    it("stop with the slice off (or not eligible): today's human-review hold", async () => {
      h.evidence.mockResolvedValue(evidence(STOP));
      expect(await runRoutingV2LiveStep(fakeSupabase().client, args("Not interested in selling, please no more"))).toEqual({ outcome: "escalated", reason: "nine_asked_stop" });
    });
    it("wrong person, scope all (existing text match) with wrong_number_all on: phone-wide close", async () => {
      h.evidence.mockResolvedValue(evidence(WRONG, { provenance: { by: "jev", row: "3", step: "wrong", signal: "wrong_person", probability: 0.9 } }));
      h.phone.mockResolvedValue({ outcome: "applied", kind: "wrong_number_all", actionId: "a1", applied: ["p"], skipped: [], replyState: "sent" });
      expect(await runRoutingV2LiveStep(fakeSupabase().client, args("Nobody by that name here"))).toEqual({ outcome: "auto_closed", reason: "routing_v2:wrong_number_close" });
      expect(h.phone).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ wrongScope: "all", expectedRevision: 7, fromPhone: "+18165550100" }), expect.anything());
    });
    it("scope this property only: the phone action is not taken (PR-G refuses), today's route runs", async () => {
      h.evidence.mockResolvedValue(evidence(WRONG));
      h.phone.mockResolvedValue({ outcome: "not_applicable", reason: "scope_not_all" });
      // Replies slice off here -> a person closes it (today's automation switch path needs the slice).
      h.flags = { ...ON, replies: false };
      expect(await runRoutingV2LiveStep(fakeSupabase().client, args("I sold that house"))).toEqual({ outcome: "escalated", reason: "nine_needs_person" });
      expect(h.phone).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ wrongScope: "this_property" }), expect.anything());
    });
    it("a bounce with the flag off holds; an unsettled inbound is re-dispatched (bounded)", async () => {
      h.evidence.mockResolvedValue(evidence(BOUNCE, { provenance: { by: "code", check: "bad_number" } }));
      expect(await runRoutingV2LiveStep(fakeSupabase().client, args("This number has no SMS capabilities"))).toEqual({ outcome: "escalated", reason: "nine_needs_person" });
      h.phone.mockResolvedValue({ outcome: "not_settled", retryable: true, retryAfterSeconds: 30 });
      expect(await runRoutingV2LiveStep(fakeSupabase().client, args("This number has no SMS capabilities"))).toMatchObject({ outcome: "retry", reason: "reply_pending", attempt: 1 });
    });
  });

  describe("number source (existing approved question, same Jev call)", () => {
    it("asks the existing number-source question inside the single v2 classification; never the eight-answer classifier", async () => {
      await runRoutingV2LiveStep(fakeSupabase().client, args("how did you get my number"));
      expect(h.classify).toHaveBeenCalledWith(expect.objectContaining({ numberSourceQuestion: true }), expect.anything());
      expect(h.legacy).not.toHaveBeenCalled();
    });
  });
});
