import { describe, expect, it, vi } from "vitest";
import type { JevAskResult } from "../providers/jev-gateway";
import { OPT_OUT_PHRASES } from "@/lib/sequences/opt-out";
import { classifyV2, type V2ClassificationDeps } from "./classify";
import { ALL_OFF, type RoutingV2Flags } from "./flags";
import { isAfterRepairsReply } from "./price-check";
import { PROPERTY_TYPE_OPTIONS, REPAIRS_FOLLOW_UP_IDS, V2_QUESTION_IDS } from "./questions";
import { v2ReplyText } from "./reply-texts";
import { NUMBER_SOURCE_QUESTION, NUMBER_SOURCE_QUESTION_ID } from "../questions";

const propertyId = "11111111-1111-4111-8111-111111111111";
const flags: RoutingV2Flags = { ...ALL_OFF, questions_live: true, haiku: true, price_check: true, canaryPercent: 100 };
function fixture(overrides: Record<string, number> = {}) {
  const answers: NonNullable<JevAskResult["answers"]> = Object.fromEntries(
    [...V2_QUESTION_IDS, ...REPAIRS_FOLLOW_UP_IDS].map((key) => [key, { choice: "no", noul: overrides[key] ?? 0.01 }]),
  );
  answers.property_type = { choice: "residential", probabilities: Object.fromEntries(PROPERTY_TYPE_OPTIONS.map((key) => [key, key === "residential" ? 0.96 : 0.01])) };
  const deps: V2ClassificationDeps = {
    jev: vi.fn(async () => ({ answers, latencyMs: 20, model: "fixture" })),
    haiku: vi.fn(async () => ({ ok: true as const, option: "needs_person", confidence: 0.2 })),
    lookupValue: vi.fn(async () => ({ kind: "value" as const, value: 200000, source: "cache" as const })),
  };
  return { deps, input: { flags, propertyId, reply: "Okay", thread: [] } };
}

describe("number source in the same Jev call (existing approved question)", () => {
  it("asks the existing question verbatim (by reference) only when requested; shadow/replay requests unchanged", async () => {
    const { input, deps } = fixture({ text_only: 0.95 });
    await classifyV2(input, deps);
    const plain = (deps.jev as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { questions: Record<string, unknown> };
    expect(NUMBER_SOURCE_QUESTION_ID in plain.questions).toBe(false);
    await classifyV2({ ...input, numberSourceQuestion: true }, deps);
    const live = (deps.jev as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { questions: Record<string, unknown> };
    expect(live.questions[NUMBER_SOURCE_QUESTION_ID]).toBe(NUMBER_SOURCE_QUESTION);
  });
  it("\"yes\" replaces the road's reply with the approved number_source reply; one Jev call", async () => {
    const { input, deps } = fixture({ text_only: 0.95 });
    const answers = (await (deps.jev as unknown as () => Promise<JevAskResult>)()).answers!;
    answers[NUMBER_SOURCE_QUESTION_ID] = { choice: "yes", probabilities: { yes: 0.93, no: 0.07 } };
    (deps.jev as ReturnType<typeof vi.fn>).mockClear();
    const result = await classifyV2({ ...input, reply: "Text only. How did you get my number?", numberSourceQuestion: true }, deps);
    expect(result).toMatchObject({ kind: "decided", action: { road: "text_only_reply", steps: [{ kind: "reply", key: "number_source" }] } });
    expect(deps.jev).toHaveBeenCalledTimes(1);
  });
  it("\"no\" (or a road with no reply) leaves the action alone", async () => {
    const { input, deps } = fixture({ text_only: 0.95 });
    expect(await classifyV2({ ...input, numberSourceQuestion: true }, deps)).toMatchObject({ action: { steps: [{ kind: "reply", key: "text_only" }] } });
    const callMe = fixture({ asked_call: 0.95 });
    const answers = (await (callMe.deps.jev as unknown as () => Promise<JevAskResult>)()).answers!;
    answers[NUMBER_SOURCE_QUESTION_ID] = { choice: "yes" };
    const r = await classifyV2({ ...callMe.input, numberSourceQuestion: true }, callMe.deps);
    expect(r.kind === "decided" && r.action.steps.some((step) => step.kind === "reply")).toBe(false);
  });
});

describe("v2 decision preparation", () => {
  it("does no provider work when disabled or outside the canary", async () => {
    const { input, deps } = fixture();
    for (const off of [ALL_OFF, { ...flags, canaryPercent: 0 }]) {
      expect(await classifyV2({ ...input, flags: off }, deps)).toEqual({ kind: "off" });
    }
    expect(deps.jev).not.toHaveBeenCalled();
    expect(deps.haiku).not.toHaveBeenCalled();
    expect(deps.lookupValue).not.toHaveBeenCalled();
  });
  it("a confident acknowledgement books without Haiku", async () => {
    const { input, deps } = fixture({ just_ok: 0.95 });
    const result = await classifyV2(input, deps);
    expect(result).toMatchObject({ kind: "decided", action: { road: "book_appointment" } });
    expect(deps.haiku).not.toHaveBeenCalled();
  });
  it("a confident stop bypasses Haiku and keeps original provenance", async () => {
    const { input, deps } = fixture({ asked_stop: 0.7 });
    expect(await classifyV2(input, deps)).toMatchObject({ kind: "decided", decision: { provenance: { signal: "asked_stop", probability: 0.7 } }, action: { road: "stop" } });
    expect(deps.haiku).not.toHaveBeenCalled();
  });
  it("Haiku transport failure holds even after a repairs reply", async () => {
    const { input, deps } = fixture({ named_price: 0.65, no_repairs: 0.99 });
    deps.haiku = vi.fn(async () => { throw new Error("private provider body"); });
    const result = await classifyV2({ ...input, thread: [{ direction: "outbound", body: v2ReplyText("price_too_high") }] }, deps);
    expect(result).toMatchObject({ kind: "decided", action: { road: "haiku_error" }, priceOutcome: null });
    expect(deps.lookupValue).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private provider body");
  });
  it("valid unsure retains Jev; a Haiku-decided stop holds", async () => {
    const { input, deps } = fixture({ just_ok: 0.65 });
    expect(await classifyV2(input, deps)).toMatchObject({ kind: "decided", final: { by: "jev_haiku_unsure" }, action: { road: "book_appointment" } });
    deps.haiku = vi.fn(async () => ({ ok: true as const, option: "asked_stop", confidence: 0.9 }));
    expect(await classifyV2(input, deps)).toMatchObject({ kind: "decided", decision: { road: "book_appointment" }, final: { by: "haiku", hold: true }, action: { road: "possible_stop" } });
  });
  it("ambiguous stop with Haiku disabled still holds and alerts", async () => {
    const { input, deps } = fixture({ asked_stop: 0.65 });
    expect(await classifyV2({ ...input, flags: { ...flags, haiku: false } }, deps)).toMatchObject({ kind: "decided", action: { road: "possible_stop" } });
    expect(deps.haiku).not.toHaveBeenCalled();
  });
  it("fails closed on incomplete or failed Jev without asking Haiku", async () => {
    const { input, deps } = fixture();
    deps.jev = vi.fn(async () => ({ answers: {}, latencyMs: 1 }));
    expect(await classifyV2(input, deps)).toEqual({ kind: "failed", reason: "jev_incomplete" });
    deps.jev = vi.fn(async () => { throw new Error("private data"); });
    expect(await classifyV2(input, deps)).toEqual({ kind: "failed", reason: "jev_failed" });
    expect(deps.haiku).not.toHaveBeenCalled();
  });
  it("asks follow-ups after an approved repairs reply with any exact footer", async () => {
    for (const footer of OPT_OUT_PHRASES) {
      const { input, deps } = fixture({ no_repairs: 0.9, not_interested: 0.9 });
      const body = `${v2ReplyText("price_too_high")} ${footer}`;
      expect(isAfterRepairsReply(body)).toBe(true);
      expect(await classifyV2({ ...input, thread: [{ direction: "outbound", body }] }, deps)).toMatchObject({ kind: "decided", priceOutcome: "no_repairs", action: { steps: [{ kind: "reply", key: "no_repairs_realtor" }] } });
      expect(deps.jev).toHaveBeenCalledWith(expect.objectContaining({ questions: expect.objectContaining({ no_repairs: expect.any(Object) }) }));
    }
    expect(isAfterRepairsReply(`${v2ReplyText("price_too_high")} Not approved text`)).toBe(false);
  });
  it("call-me beats repair follow-ups, and disabled price does not ask them", async () => {
    const { input, deps } = fixture({ asked_call: 0.95, no_repairs: 0.99 });
    const thread = [{ direction: "outbound" as const, body: v2ReplyText("price_too_high") }];
    expect(await classifyV2({ ...input, thread }, deps)).toMatchObject({ kind: "decided", action: { road: "ALERT_call_me" }, priceOutcome: null });
    await classifyV2({ ...input, thread, flags: { ...flags, price_check: false } }, deps);
    expect(vi.mocked(deps.jev).mock.calls.at(-1)![0].questions).not.toHaveProperty("no_repairs");
  });
  it("uses the 80 percent check and replaces only the reply for number source", async () => {
    const { input, deps } = fixture({ named_price: 0.95 });
    expect(await classifyV2({ ...input, reply: "$180000" }, deps)).toMatchObject({ kind: "decided", priceOutcome: "too_high", action: { steps: [{ kind: "reply", key: "price_too_high" }] } });
    expect(await classifyV2({ ...input, reply: "$180000", askedHowNumber: true }, deps)).toMatchObject({ kind: "decided", action: { steps: [{ kind: "reply", key: "number_source" }] } });
  });
});
