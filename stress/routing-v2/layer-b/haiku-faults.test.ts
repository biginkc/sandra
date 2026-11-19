/**
 * Stress Layer B (STRESS-TEST-DESIGN §2.3, §2.4): Haiku outcomes and provider faults through the
 * PRODUCTION classifyV2 / askHaiku / applyHaikuPolicy with injected deps. No network, no DB.
 */
import { describe, expect, it } from "vitest";

import { classifyV2, type V2ClassificationDeps } from "@/lib/sms-classification/routing-v2/classify";
import { parseRoutingV2Flags } from "@/lib/sms-classification/routing-v2/flags";
import { askHaiku, parseHaikuText } from "@/lib/sms-classification/routing-v2/haiku";
import { applyHaikuPolicy } from "@/lib/sms-classification/routing-v2/haiku-policy";
import { V2_QUESTION_IDS, type V2QuestionId } from "@/lib/sms-classification/routing-v2/questions";
import { v2ReplyText } from "@/lib/sms-classification/routing-v2/reply-texts";
import { routeV2 } from "@/lib/sms-classification/routing-v2/route";
import { askJev, JevProviderError } from "@/lib/sms-classification/providers/jev-gateway";

const PID = "11111111-2222-4333-8444-555555555555";
const FLAGS = parseRoutingV2Flags({
  questions_live: true, replies: true, drips: true, haiku: true, price_check: true,
  alert_on_time_only: true, wrong_number_all: true, model_stop_suppression: true, canary_property_ids: [PID],
});

function answers(over: Partial<Record<V2QuestionId, number>>, pt: Record<string, number> = {}) {
  const a: Record<string, { choice: string; noul?: number; probabilities?: Record<string, number> }> = {};
  for (const id of V2_QUESTION_IDS) { const p = over[id] ?? 0.02; a[id] = { choice: p >= 0.5 ? "yes" : "no", noul: p }; }
  a.property_type = { choice: "didnt_say", probabilities: { residential: 0.02, lot: 0.02, commercial: 0.02, rental: 0.02, didnt_say: 0.92, ...pt } };
  return a;
}
type HaikuOut = Awaited<ReturnType<V2ClassificationDeps["haiku"]>>;
function deps(over: Partial<Record<V2QuestionId, number>>, haiku: HaikuOut | (() => Promise<HaikuOut>) | "throw", extra: Partial<V2ClassificationDeps> = {}) {
  let haikuCalls = 0;
  let dmCalls = 0;
  const d: V2ClassificationDeps = {
    jev: async () => ({ answers: answers(over), model: "jev-test", latencyMs: 1 }),
    haiku: async () => {
      haikuCalls++;
      if (haiku === "throw") throw new Error("boom");
      return typeof haiku === "function" ? haiku() : haiku;
    },
    lookupValue: async () => { dmCalls++; return { kind: "value", value: 300000, source: "provider" }; },
    ...extra,
  };
  return { d, calls: () => ({ haikuCalls, dmCalls }) };
}
const run = (reply: string, d: V2ClassificationDeps, thread: { direction: "inbound" | "outbound"; body: string }[] = []) =>
  classifyV2({ flags: FLAGS, propertyId: PID, reply, thread }, d);
const autoSends = (steps: readonly { kind: string }[]) => steps.filter((s) => s.kind === "reply" || s.kind === "drip" || s.kind === "wrong_number_close").length;

describe("§2.3 Haiku outcomes", () => {
  it("valid unsure (needs_person / conf 0.49) with a Jev road → Jev road stands (GAP-6)", async () => {
    for (const h of [{ ok: true as const, option: "needs_person", confidence: 0.9 }, { ok: true as const, option: "not_interested", confidence: 0.49 }]) {
      const { d } = deps({ not_interested: 0.65 }, h);
      const r = await run("nah", d);
      expect(r.kind).toBe("decided");
      if (r.kind !== "decided") return;
      expect(r.action.road).toBe("not_interested_drip");
      expect(r.final?.by).toBe("jev_haiku_unsure");
    }
  });
  it("valid unsure with no Jev road → ALERT_haiku_unsure (hold + alert, zero sends)", async () => {
    const { d } = deps({}, { ok: true, option: "needs_person", confidence: 0.9 });
    const r = await run("🙂", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("haiku_unsure");
    expect(autoSends(r.action.steps)).toBe(0);
    expect(r.action.steps.some((s) => s.kind === "alert")).toBe(true);
  });
  it("confidence exactly 0.50 is accepted", async () => {
    const { d } = deps({}, { ok: true, option: "maybe_later", confidence: 0.5 });
    const r = await run("later maybe", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("maybe_later_drip");
  });
  it("off-list option id → invalid → hold + 'Haiku error' alert, zero sends", async () => {
    const { d } = deps({}, { ok: true, option: "mark_as_hot", confidence: 0.99 });
    const r = await run("x", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("haiku_error");
    expect(r.final?.failureReason).toBe("haiku_invalid:unknown_option");
    expect(autoSends(r.action.steps)).toBe(0);
  });
  it.each([
    ["parser", { ok: false as const, reason: "haiku_invalid:parser" }],
    ["timeout", { ok: false as const, reason: "haiku_invalid:timeout" }],
    ["http_429", { ok: false as const, reason: "haiku_invalid:http_429" }],
    ["http_503", { ok: false as const, reason: "haiku_invalid:http_503" }],
    ["transport", { ok: false as const, reason: "haiku_invalid:transport" }],
  ])("Haiku failure %s → hold + escalate with reason, zero sends, never Jev fallback", async (_n, h) => {
    const { d } = deps({ not_interested: 0.65 }, h);
    const r = await run("hmm", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("haiku_error");
    expect(r.final?.failureReason).toBe(h.reason);
    expect(autoSends(r.action.steps)).toBe(0);
    expect(r.action.steps).toContainEqual({ kind: "alert", reason: "haiku_error" });
  });
  it("Haiku dep throws → transport failure → escalate (never throws)", async () => {
    const { d } = deps({ not_interested: 0.65 }, "throw");
    const r = await run("hmm", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("haiku_error");
    expect(r.final?.failureReason).toBe("haiku_transport");
  });
  it("Haiku-decided stop → hold + 'Possible stop request' alert, never auto-suppress", async () => {
    const { d } = deps({}, { ok: true, option: "asked_stop", confidence: 0.8 });
    const r = await run("not now please", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("possible_stop");
    expect(r.action.steps).toContainEqual({ kind: "alert", reason: "possible_stop" });
  });
  it("Jev stop 0.60–0.69 + Haiku unsure → hold + possible-stop alert (PR-I)", async () => {
    const { d } = deps({ asked_stop: 0.65 }, { ok: true, option: "needs_person", confidence: 0.9 });
    const r = await run("please no more", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.action.road).toBe("possible_stop");
  });
  it("Jev stop ≥0.70 is final: Haiku not called", async () => {
    const { d, calls } = deps({ asked_stop: 0.7 }, { ok: true, option: "asked_offer", confidence: 0.9 });
    const r = await run("stop", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(calls().haikuCalls).toBe(0);
    expect(r.action.road).toBe("stop");
  });
  it("Haiku picks an option whose Jev prob was 0.0 → accepted (GAP-5 recorded, no floor)", () => {
    const probs = Object.fromEntries(V2_QUESTION_IDS.map((q) => [q, 0])) as Record<V2QuestionId, number>;
    const d = routeV2({ reply: "x", probabilities: probs, propertyType: { residential: 0, lot: 0, commercial: 0, rental: 0, didnt_say: 1 } });
    const f = applyHaikuPolicy(d, { ok: true, option: "listed", confidence: 0.9 }, probs);
    expect(f.road).toBe("listed_drip");
  });
  it("parser (A-3 fix, first JSON object wins): prose-only, string confidence, empty, out-of-range → parser failure; fenced JSON ok; trailing prose / second object → first object", () => {
    expect(parseHaikuText('{"road":"stop","confidence":0.9}{"road":"x","confidence":1}')).toEqual({ ok: true, option: "stop", confidence: 0.9 });
    expect(parseHaikuText('{"road": "lot", "confidence": 0.3}\n\nWait—correcting this: needs_person')).toEqual({ ok: true, option: "lot", confidence: 0.3 });
    for (const t of ["I think it's stop", '{"road":"stop","confidence":"0.9"}', "", '{"road":"stop","confidence":1.5}', "[]", '{"confidence":0.9}']) {
      expect(parseHaikuText(t).ok, t).toBe(false);
    }
    expect(parseHaikuText('```json\n{"road":"stop","confidence":0.9}\n```')).toEqual({ ok: true, option: "stop", confidence: 0.9 });
  });
});

describe("askHaiku transport (one scripted retry, never throws)", () => {
  const okBody = (text: string) => new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 900, output_tokens: 12 } }), { status: 200 });
  const mk = (seq: Array<() => Response | Promise<Response>>) => { let i = 0; const f = (async () => seq[Math.min(i++, seq.length - 1)]()) as typeof fetch; return { f, n: () => i }; };
  const sleep = async () => {};
  it("429 then OK → 2 attempts, answer", async () => {
    const { f, n } = mk([() => new Response("", { status: 429 }), () => okBody('{"road":"asked_stop","confidence":0.8}')]);
    const r = await askHaiku(["SELLER: x"], { fetch: f, apiKey: "k", sleep });
    expect(r).toMatchObject({ ok: true, option: "asked_stop", attempts: 2 });
    expect(n()).toBe(2);
  });
  it("429 storm → exactly 2 attempts then http_429 (no tight loop)", async () => {
    const { f, n } = mk([() => new Response("", { status: 429 })]);
    const r = await askHaiku(["SELLER: x"], { fetch: f, apiKey: "k", sleep });
    expect(r).toMatchObject({ ok: false, reason: "haiku_invalid:http_429", attempts: 2 });
    expect(n()).toBe(2);
  });
  it("500 storm → 2 attempts, http_500; 400 → 1 attempt, http_400", async () => {
    expect(await askHaiku(["x"], { fetch: mk([() => new Response("", { status: 500 })]).f, apiKey: "k", sleep })).toMatchObject({ reason: "haiku_invalid:http_500", attempts: 2 });
    expect(await askHaiku(["x"], { fetch: mk([() => new Response("", { status: 400 })]).f, apiKey: "k", sleep })).toMatchObject({ reason: "haiku_invalid:http_400", attempts: 1 });
  });
  it("timeout → haiku_invalid:timeout", async () => {
    const f = ((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const r = await askHaiku(["x"], { fetch: f, apiKey: "k", timeoutMs: 20, sleep });
    expect(r).toMatchObject({ ok: false, reason: "haiku_invalid:timeout" });
  });
  it("malformed JSON body / non-JSON text / missing key", async () => {
    expect(await askHaiku(["x"], { fetch: mk([() => new Response("not json", { status: 200 })]).f, apiKey: "k", sleep })).toMatchObject({ reason: "haiku_invalid:parser" });
    expect(await askHaiku(["x"], { fetch: mk([() => okBody("sure! stop")]).f, apiKey: "k", sleep })).toMatchObject({ reason: "haiku_invalid:parser" });
    expect(await askHaiku(["x"], { fetch: mk([() => okBody("{}")]).f, apiKey: "", sleep })).toMatchObject({ reason: "haiku_invalid:config", attempts: 0 });
  });
  it("cost accounting from usage", async () => {
    const r = await askHaiku(["x"], { fetch: mk([() => okBody('{"road":"just_ok","confidence":0.9}')]).f, apiKey: "k", sleep });
    expect(r.costUsd).toBeCloseTo((900 * 0.1 + 12 * 0.5) / 1e6, 12);
  });
});

describe("§2.4 provider faults", () => {
  it("Jev throws (timeout/5xx/429) → failed jev_failed, Haiku and DealMachine never called", async () => {
    for (const err of [new JevProviderError("t", "timeout"), new JevProviderError("s", "server_error", 503), new JevProviderError("r", "rate_limited", 429)]) {
      const { d, calls } = deps({}, { ok: true, option: "just_ok", confidence: 1 }, { jev: async () => { throw err; } });
      expect(await run("hi", d)).toMatchObject({ kind: "failed", reason: "jev_failed" });
      expect(calls()).toEqual({ haikuCalls: 0, dmCalls: 0 });
    }
  });
  it("Jev partial answers / empty body → failed jev_incomplete", async () => {
    const partial = answers({});
    delete (partial as Record<string, unknown>).asked_stop;
    for (const body of [{ answers: partial }, {}, { answers: {} }]) {
      const { d } = deps({}, { ok: true, option: "just_ok", confidence: 1 }, { jev: async () => ({ ...body, latencyMs: 1 }) });
      expect(await run("hi", d)).toMatchObject({ kind: "failed", reason: "jev_incomplete" });
    }
  });
  it("askJev: 429 storm → 1 + maxRetries attempts, then rate_limited; 402/401 not retried", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response("", { status: 429 }); }) as typeof fetch;
    await expect(askJev({ state: {}, questions: {} }, { fetch: f, apiKey: "k", maxRetries: 2 })).rejects.toMatchObject({ kind: "rate_limited" });
    expect(n).toBe(3);
    n = 0;
    const g = (async () => { n++; return new Response("", { status: 402 }); }) as typeof fetch;
    await expect(askJev({ state: {}, questions: {} }, { fetch: g, apiKey: "k", maxRetries: 2 })).rejects.toMatchObject({ kind: "billing" });
    expect(n).toBe(1);
  }, 20_000);
  it.each([
    ["throws", async () => { throw new Error("dm down"); }],
    ["no_value 429", async () => ({ kind: "no_value" as const, reason: "http_429" })],
    ["no_value credit_out", async () => ({ kind: "no_value" as const, reason: "credits_exhausted" })],
    ["no_value no_match", async () => ({ kind: "no_value" as const, reason: "no_match" })],
    ["value 0", async () => ({ kind: "value" as const, value: 0, source: "provider" as const })],
    ["value NaN", async () => ({ kind: "value" as const, value: Number.NaN, source: "provider" as const })],
  ])("DealMachine %s → no value → fair-price reply + alert, never a drip", async (_n, lookupValue) => {
    const { d } = deps({ named_price: 0.95 }, { ok: true, option: "just_ok", confidence: 1 }, { lookupValue });
    const r = await run("I want $250,000 for it", d);
    if (r.kind !== "decided") throw new Error(r.kind);
    expect(r.priceOutcome).toBe("no_value");
    expect(r.action.steps).toContainEqual({ kind: "alert", reason: "named_price" });
    expect(r.action.steps.some((s) => s.kind === "drip")).toBe(false);
  });
  it("price check: ≤80% → fair, >80% → repairs reply, exactly 80% → fair; range/none → alert, no DM call", async () => {
    const at = async (ask: string, value: number) => {
      let dm = 0;
      const { d } = deps({ named_price: 0.95 }, { ok: true, option: "just_ok", confidence: 1 }, { lookupValue: async () => { dm++; return { kind: "value", value, source: "provider" }; } });
      const r = await run(ask, d);
      if (r.kind !== "decided") throw new Error(r.kind);
      return { out: r.priceOutcome, dm };
    };
    expect(await at("I'd take $160,000", 200000)).toEqual({ out: "fair", dm: 1 });
    expect(await at("I'd take $161,000", 200000)).toEqual({ out: "too_high", dm: 1 });
    expect(await at("between 150k and 170k", 200000)).toEqual({ out: "no_single_amount", dm: 0 });
    expect(await at("make me an offer", 200000)).toMatchObject({ dm: 0 });
  });
  it("after the repairs reply: no_repairs ≥0.60 → realtor reply; needs_repairs → alert; wrong person → close normally", async () => {
    const thread = [{ direction: "outbound" as const, body: v2ReplyText("price_too_high") }];
    const fu = (no_repairs: number, needs_repairs: number, extra: Partial<Record<V2QuestionId, number>> = {}) => {
      const a = answers(extra) as Record<string, unknown>;
      Object.assign(a, { needs_repairs: { choice: "x", noul: needs_repairs }, flexible_price: { choice: "x", noul: 0.02 }, original_portion: { choice: "x", noul: 0.02 }, no_repairs: { choice: "x", noul: no_repairs } });
      return deps({}, { ok: true, option: "needs_person", confidence: 0.9 }, { jev: async () => ({ answers: a as never, latencyMs: 1 }) }).d;
    };
    const p = async (d: V2ClassificationDeps) => { const r = await run("reply", d, thread); if (r.kind !== "decided") throw new Error(r.kind); return [r.action.road, r.priceOutcome]; };
    expect(await p(fu(0.8, 0.02, { just_ok: 0.9 }))).toEqual(["price_check", "no_repairs"]);
    expect(await p(fu(0.8, 0.7, { just_ok: 0.9 }))).toEqual(["price_check", "follow_up_yes"]);
    expect(await p(fu(0.59, 0.02, { just_ok: 0.9 }))).toEqual(["price_check", "other"]);
    expect((await p(fu(0.8, 0.02, { wrong_person: 0.9 })))[0]).toBe("wrong_number_close");
    expect((await p(fu(0.8, 0.02, { asked_call: 0.9 })))[0]).toBe("ALERT_call_me");
  });
});
