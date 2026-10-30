import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { applyHaikuPolicy, HAIKU_ERROR_ALERT, HAIKU_STOP_ALERT, type FinalDecision } from "./haiku-policy";
import { ALL_OFF, parseRoutingV2Flags } from "./flags";
import { decideV2StopAction, MODEL_STOP_MIN_PROBABILITY, MODEL_STOP_SOURCE } from "./model-stop";
import { executeV2Stop, liftModelStopSuppression } from "./model-stop-suppression";
import { PROPERTY_TYPE_OPTIONS, V2_QUESTION_IDS, type PropertyTypeOption, type V2QuestionId } from "./questions";
import { routeV2 } from "./route";

function probs(over: Partial<Record<V2QuestionId, number>> = {}) {
  return Object.fromEntries(V2_QUESTION_IDS.map((q) => [q, over[q] ?? 0.02])) as Record<V2QuestionId, number>;
}
const PT = Object.fromEntries(PROPERTY_TYPE_OPTIONS.map((o) => [o, o === "didnt_say" ? 0.9 : 0.02])) as Record<PropertyTypeOption, number>;
const decide = (over: Partial<Record<V2QuestionId, number>> = {}, reply = "hi") => routeV2({ reply, probabilities: probs(over), propertyType: PT });
const ok = (option: string, confidence: number) => ({ ok: true as const, option, confidence });

/** The full pipeline: route → Haiku policy (with Haiku's answer if asked) → stop action. */
function pipeline(over: Partial<Record<V2QuestionId, number>>, haiku: Parameters<typeof applyHaikuPolicy>[1], flag = true) {
  const d = decide(over);
  const final = applyHaikuPolicy(d, d.haiku ? haiku : null, probs(over));
  return { d, final, action: decideV2StopAction({ decision: d, final, modelStopSuppression: flag }) };
}

describe("PR-I constants", () => {
  it("uses its own suppression source and the 0.70 final cutoff", () => {
    expect(MODEL_STOP_SOURCE).toBe("model_stop");
    expect(MODEL_STOP_MIN_PROBABILITY).toBe(0.7);
  });
  it("reuses the existing alert labels verbatim", () => {
    expect(HAIKU_STOP_ALERT).toBe("Possible stop request — please check");
    expect(HAIKU_ERROR_ALERT).toBe("Haiku error — please check");
  });
});

describe("PR-I decision table (flag on)", () => {
  it.each([
    [{ asked_stop: 0.7 }, "asked_stop", "asked_stop"],
    [{ asked_stop: 0.99 }, "asked_stop", "asked_stop"],
    [{ legal: 0.7 }, "legal_hostile", "legal"],
    [{ hostile: 0.85 }, "legal_hostile", "hostile"],
    [{ legal: 0.9, asked_call: 0.95 }, "legal_hostile", "legal"],
  ] as const)("Jev %j ≥0.70 → suppress (final, Haiku never asked)", (over, step, signal) => {
    const { d, action } = pipeline(over, null);
    expect(d.haiku).toBeNull();
    expect(action).toMatchObject({ kind: "suppress", step, signal });
  });

  it("a stop beats a code pre-check: 'STOP, I'm driving' at 0.99 → suppress", () => {
    const d = decide({ asked_stop: 0.99 }, "STOP, I'm driving");
    const final = applyHaikuPolicy(d, null, probs({ asked_stop: 0.99 }));
    expect(decideV2StopAction({ decision: d, final, modelStopSuppression: true })).toMatchObject({ kind: "suppress" });
  });

  it.each([{ asked_stop: 0.65 }, { legal: 0.6 }, { hostile: 0.69 }])("Jev %j in 0.60–0.70 + Haiku says stop → hold + alert", (over) => {
    for (const opt of ["asked_stop", "legal", "hostile"]) {
      const { final, action } = pipeline(over, ok(opt, 0.9));
      expect(final).toMatchObject({ road: "stop", by: "haiku", hold: true, alert: HAIKU_STOP_ALERT });
      expect(action).toEqual({ kind: "hold_alert", alert: HAIKU_STOP_ALERT, by: "haiku" });
    }
  });

  it.each([ok("needs_person", 0.9), ok("asked_stop", 0.49), ok("not_interested", 0.3)])(
    "Jev stop 0.65 + Haiku unsure (%j) → hold + alert, never suppress",
    (h) => {
      const { final, action } = pipeline({ asked_stop: 0.65 }, h);
      expect(final).toEqual({ road: "stop", by: "jev_haiku_unsure", hold: true, alert: HAIKU_STOP_ALERT, failureReason: null });
      expect(action).toEqual({ kind: "hold_alert", alert: HAIKU_STOP_ALERT, by: "jev_haiku_unsure" });
    },
  );

  it.each(["haiku_invalid:parser", "haiku_invalid:timeout", "haiku_invalid:http_500", "haiku_invalid:unknown_option"])(
    "Jev stop 0.65 + Haiku error (%s) → hold + 'Haiku error — please check'",
    (reason) => {
      const h = reason === "haiku_invalid:unknown_option" ? ok("made_up", 0.9) : { ok: false as const, reason };
      const { final, action } = pipeline({ asked_stop: 0.65 }, h);
      expect(final).toMatchObject({ by: "haiku_failed", hold: true, alert: HAIKU_ERROR_ALERT });
      expect(action).toEqual({ kind: "hold_alert", alert: HAIKU_ERROR_ALERT, by: "haiku_failed" });
    },
  );

  it("Haiku-decided stop on a reply Jev had no answer for → hold + alert", () => {
    const { d, action } = pipeline({}, ok("asked_stop", 0.95));
    expect(d.road).toBeNull();
    expect(action).toEqual({ kind: "hold_alert", alert: HAIKU_STOP_ALERT, by: "haiku" });
  });

  it("Haiku-decided legal/hostile from a non-stop band → hold + alert", () => {
    for (const opt of ["legal", "hostile"]) {
      expect(pipeline({ not_interested: 0.62 }, ok(opt, 0.8)).action).toEqual({ kind: "hold_alert", alert: HAIKU_STOP_ALERT, by: "haiku" });
    }
  });

  it("a Jev stop in the band with no Haiku run at all (haiku flag off) → hold + alert", () => {
    const d = decide({ asked_stop: 0.65 });
    expect(decideV2StopAction({ decision: d, final: null, modelStopSuppression: true })).toEqual({
      kind: "hold_alert",
      alert: HAIKU_STOP_ALERT,
      by: "jev",
    });
  });

  it("a ≥0.70 Jev stop with no Haiku policy result still suppresses", () => {
    const d = decide({ asked_stop: 0.8 });
    expect(decideV2StopAction({ decision: d, final: null, modelStopSuppression: true })).toMatchObject({ kind: "suppress" });
  });

  it("not a stop → not_stop (the road's own action applies)", () => {
    expect(pipeline({ not_interested: 0.9 }, null).action).toEqual({ kind: "not_stop" });
    expect(pipeline({ asked_call: 0.9 }, null).action).toEqual({ kind: "not_stop" });
    expect(pipeline({}, ok("not_interested", 0.9)).action).toEqual({ kind: "not_stop" });
    expect(pipeline({ asked_stop: 0.59 }, null).action).toEqual({ kind: "not_stop" });
  });

  it("never suppresses a decision that looks like a stop but was not decided by Jev ≥0.70", () => {
    const d = decide({ asked_stop: 0.9 });
    const tampered: FinalDecision = { road: "stop", by: "jev", hold: true, alert: HAIKU_STOP_ALERT, failureReason: null };
    expect(decideV2StopAction({ decision: d, final: tampered, modelStopSuppression: true }).kind).toBe("hold_alert");
  });
});

describe("PR-I flag off = today's human-review path", () => {
  it.each([
    [{ asked_stop: 0.95 }, null],
    [{ legal: 0.9 }, null],
    [{ asked_stop: 0.65 }, ok("asked_stop", 0.9)],
    [{ asked_stop: 0.65 }, ok("needs_person", 0.9)],
    [{ asked_stop: 0.65 }, { ok: false as const, reason: "haiku_invalid:timeout" }],
    [{}, ok("hostile", 0.9)],
  ] as const)("%j / %j → human_review", (over, h) => {
    expect(pipeline(over, h, false).action).toEqual({ kind: "human_review" });
  });
  it("non-boolean flag values are off", () => {
    const d = decide({ asked_stop: 0.95 });
    for (const v of ["true", 1, null, undefined]) {
      expect(decideV2StopAction({ decision: d, final: null, modelStopSuppression: v as unknown as boolean })).toEqual({ kind: "human_review" });
    }
  });
});

type RpcResp = { data?: unknown; error?: { message: string } | null } | (() => never);
function fakeAdmin(apply: RpcResp, phoneIds: RpcResp = { data: [] }) {
  const resolve = (r: RpcResp) => (typeof r === "function" ? r() : { data: r.data ?? null, error: r.error ?? null });
  const rpc = vi.fn(async (fn: string) => resolve(fn === "fn_model_stop_phone_property_ids" ? phoneIds : apply));
  return { client: { rpc } as never, rpc };
}
const base = {
  orgId: "00000000-0000-4000-8000-000000000001",
  propertyId: "00000000-0000-4000-8000-000000000002",
  contactId: "00000000-0000-4000-8000-000000000003",
  inboundMessageId: "00000000-0000-4000-8000-000000000004",
  phone: "(816) 555-0101",
};
const OTHER = "00000000-0000-4000-8000-000000000009";
const on = (extra: Record<string, unknown> = {}) =>
  parseRoutingV2Flags({ questions_live: true, model_stop_suppression: true, canary_property_ids: [base.propertyId, OTHER], ...extra });
const deps = (flags: ReturnType<typeof parseRoutingV2Flags>) => ({ readFlags: async () => flags });
const applyCalls = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls.filter((c) => c[0] === "fn_apply_model_stop_suppression");

describe("PR-I executor", () => {
  it.each([
    ["all off", ALL_OFF],
    ["slice off", parseRoutingV2Flags({ questions_live: true, canary_percent: 100 })],
    ["questions_live off", parseRoutingV2Flags({ model_stop_suppression: true, canary_percent: 100 })],
  ])("flag off (%s): no write, today's path", async (_n, flags) => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } });
    const d = decide({ asked_stop: 0.95 });
    expect(await executeV2Stop(client, { ...base, decision: d, final: null }, deps(flags))).toEqual({ kind: "human_review", reason: "flag_off" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a flags read that throws = off", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } });
    const out = await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, {
      readFlags: async () => {
        throw new Error("db down");
      },
    });
    expect(out).toEqual({ kind: "human_review", reason: "flag_off" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("not a stop: nothing read, nothing written", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } });
    const readFlags = vi.fn(async () => on());
    expect(await executeV2Stop(client, { ...base, decision: decide({ not_interested: 0.9 }), final: null }, { readFlags })).toEqual({ kind: "not_stop" });
    expect(readFlags).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hold + alert: no write", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } });
    const d = decide({ asked_stop: 0.65 });
    const final = applyHaikuPolicy(d, ok("asked_stop", 0.9), probs({ asked_stop: 0.65 }));
    expect(await executeV2Stop(client, { ...base, decision: d, final }, deps(on()))).toEqual({
      kind: "hold_alert",
      alert: HAIKU_STOP_ALERT,
      reason: "model_stop_hold:haiku",
    });
    expect(applyCalls(rpc)).toHaveLength(0);
  });

  it("suppress: eligible phone → calls fn_apply_model_stop_suppression with the normalized phone and Jev detail", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed", suppressionId: "s1" } }, { data: [base.propertyId, OTHER] });
    const out = await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()));
    expect(out).toEqual({ kind: "suppressed", suppressionId: "s1", status: "suppressed" });
    expect(rpc).toHaveBeenCalledWith("fn_model_stop_phone_property_ids", {
      p_org_id: base.orgId,
      p_phone_e164: "+18165550101",
      p_property_id: base.propertyId,
    });
    expect(rpc).toHaveBeenCalledWith("fn_apply_model_stop_suppression", {
      p_org_id: base.orgId,
      p_phone_e164: "+18165550101",
      p_inbound_message_id: base.inboundMessageId,
      p_property_id: base.propertyId,
      p_contact_id: base.contactId,
      p_detail: { step: "asked_stop", signal: "asked_stop", probability: 0.95 },
    });
  });

  it("multi-property phone with one ineligible property → today's path, no write", async () => {
    const ineligible = "00000000-0000-4000-8000-0000000000aa";
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } }, { data: [base.propertyId, OTHER, ineligible] });
    const out = await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()));
    expect(out).toEqual({ kind: "human_review", reason: "not_eligible" });
    expect(applyCalls(rpc)).toHaveLength(0);
  });

  it("the inbound's own property is always included, even if the lookup misses it", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } }, { data: [OTHER] });
    const flags = parseRoutingV2Flags({ questions_live: true, model_stop_suppression: true, canary_property_ids: [OTHER] });
    expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(flags))).toEqual({
      kind: "human_review",
      reason: "not_eligible",
    });
    expect(applyCalls(rpc)).toHaveLength(0);
  });

  it.each([
    ["non-UUID canary id", { canary_property_ids: ["00000000-0000-4000-8000-000000000002", "nope"], canary_percent: 100 }],
    ["canary ids not an array", { canary_property_ids: "00000000-0000-4000-8000-000000000002", canary_percent: 100 }],
    ["percent out of range", { canary_property_ids: ["00000000-0000-4000-8000-000000000002"], canary_percent: 101 }],
    ["percent not an integer", { canary_property_ids: ["00000000-0000-4000-8000-000000000002"], canary_percent: 50.5 }],
    ["percent a string", { canary_property_ids: ["00000000-0000-4000-8000-000000000002"], canary_percent: "100" }],
    ["percent null", { canary_property_ids: ["00000000-0000-4000-8000-000000000002"], canary_percent: null }],
  ])("malformed canary config (%s) fails closed: no write", async (_n, extra) => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } }, { data: [base.propertyId] });
    const flags = parseRoutingV2Flags({ questions_live: true, model_stop_suppression: true, ...extra });
    expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(flags))).toEqual({
      kind: "human_review",
      reason: "not_eligible",
    });
    expect(applyCalls(rpc)).toHaveLength(0);
  });

  it("eligibility flips between decision and write: the database refuses → today's path", async () => {
    const { client } = fakeAdmin({ data: { status: "not_eligible" } }, { data: [base.propertyId] });
    expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toEqual({
      kind: "human_review",
      reason: "not_eligible",
    });
  });

  it("database cannot decide the phone set (null: un-normalizable phone data) → today's path, no write", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } }, { data: null });
    expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toEqual({
      kind: "human_review",
      reason: "not_eligible",
    });
    expect(applyCalls(rpc)).toHaveLength(0);
  });

  it.each(["816-555-0101", "8165550101", "+1 (816) 555-0101", "1.816.555.0101"])("phone variant %s is sent normalized", async (raw) => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } }, { data: [base.propertyId] });
    await executeV2Stop(client, { ...base, phone: raw, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()));
    expect((rpc.mock.calls as unknown as Array<[string, { p_phone_e164?: string }]>).every((c) => c[1].p_phone_e164 === "+18165550101")).toBe(true);
  });

  it.each([[{ error: { message: "boom" } }], [{ data: { nope: 1 } }], [{ data: [1, 2] }], [() => { throw new Error("network"); }]] as const)(
    "phone lookup failure (%j) → today's path, no write",
    async (resp) => {
      const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } }, resp as never);
      expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toEqual({
        kind: "human_review",
        reason: "model_stop_failed:eligibility",
      });
      expect(applyCalls(rpc)).toHaveLength(0);
    },
  );

  it("duplicate webhook: the database's duplicate answer is a no-op success", async () => {
    const { client } = fakeAdmin({ data: { status: "duplicate", prior: "suppressed", suppressionId: "s1" } }, { data: [base.propertyId] });
    expect(await executeV2Stop(client, { ...base, decision: decide({ legal: 0.9 }), final: null }, deps(on()))).toEqual({
      kind: "suppressed",
      suppressionId: "s1",
      status: "duplicate",
    });
  });

  it("already suppressed (carrier STOP row): reported, row left alone", async () => {
    const { client } = fakeAdmin({ data: { status: "already_suppressed", suppressionId: "c1", existingSource: "sendillo" } }, { data: [base.propertyId] });
    expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toMatchObject({
      kind: "suppressed",
      status: "already_suppressed",
    });
  });

  it("write-time flag off → today's path", async () => {
    const { client } = fakeAdmin({ data: { status: "flag_off" } }, { data: [base.propertyId] });
    expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toEqual({
      kind: "human_review",
      reason: "flag_off",
    });
  });

  it.each([[{ error: { message: "boom" } }], [{ data: { status: "weird" } }], [() => { throw new Error("network"); }]] as const)(
    "write failure (%j) → today's human-review path, never a send",
    async (resp) => {
      const { client } = fakeAdmin(resp as never, { data: [base.propertyId] });
      expect(await executeV2Stop(client, { ...base, decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toEqual({
        kind: "human_review",
        reason: "model_stop_failed:write",
      });
    },
  );

  it("unusable phone → today's path, no database call", async () => {
    const { client, rpc } = fakeAdmin({ data: { status: "suppressed" } });
    expect(await executeV2Stop(client, { ...base, phone: "nope", decision: decide({ asked_stop: 0.95 }), final: null }, deps(on()))).toEqual({
      kind: "human_review",
      reason: "model_stop_failed:no_phone",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("PR-I undo (lift)", () => {
  it.each([
    [{ data: { status: "lifted" } }, { ok: true, status: "lifted" }],
    [{ data: { status: "already_lifted" } }, { ok: true, status: "already_lifted" }],
    [{ data: { status: "not_model_stop" } }, { ok: false, code: "NOT_MODEL_STOP" }],
    [{ data: { status: "busy" } }, { ok: false, code: "FAILED" }],
    [{ error: { message: "NOT_FOUND" } }, { ok: false, code: "NOT_FOUND" }],
    [{ error: { message: "FORBIDDEN" } }, { ok: false, code: "FORBIDDEN" }],
    [{ error: { message: "AUTHENTICATION_REQUIRED" } }, { ok: false, code: "FORBIDDEN" }],
    [{ error: { message: "other" } }, { ok: false, code: "FAILED" }],
    [{ data: { status: "?" } }, { ok: false, code: "FAILED" }],
  ] as const)("%j → %j", async (resp, expected) => {
    const { client, rpc } = fakeAdmin(resp as never);
    expect(await liftModelStopSuppression(client, "s1", "seller asked to resume")).toMatchObject(expected);
    expect(rpc).toHaveBeenCalledWith("fn_lift_model_stop_suppression", { p_suppression_id: "s1", p_note: "seller asked to resume" });
  });
});

describe("PR-I flag-off parity: the live opt-out path is not touched", () => {
  it("dispatch.ts keeps the opt-out deferral; only the flag-gated v2 stop branch reaches executeV2Stop", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "../../..");
    const dispatch = readFileSync(join(root, "lib/ai-responder/dispatch.ts"), "utf8");
    const thresholds = readFileSync(join(root, "lib/sms-classification/thresholds.ts"), "utf8");
    expect(dispatch).toContain("proposeDeferredJevDisposition");
    expect(dispatch).toContain("HOLD_JEV_OPTED_OUT_NEEDS_CONFIRM");
    expect(thresholds).not.toContain("model-stop");
    for (const src of [dispatch, thresholds]) expect(src).not.toContain("fn_apply_model_stop_suppression");
    // Cutover: one import (the adapter, which re-checks flags + canary itself) and one call site.
    expect(dispatch.match(/routing-v2\/model-stop-suppression/g)).toHaveLength(1);
    expect(dispatch.match(/executeV2Stop\(/g)).toHaveLength(1);
  });
});
