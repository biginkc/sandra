import { describe, expect, it, vi } from "vitest";
import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { nineDecisionRecord } from "@/lib/ai-responder/nine-questions-engine";
import { classifyNineQuestions, NINE_QUESTION_IDS, SELLING_OPPORTUNITY_QUESTION, buildNineQuestionRequest } from "@/lib/sms-classification/nine-questions";
import { runHoldAlertsForOrg } from "./core";
import { isSupplementalOpportunity, loadSellingOpportunities } from "./selling-opportunities";
import { makeDeps, ORG, OWNER } from "./test-support";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
const NOW = "2026-10-28T12:00:00.000Z";
const SINCE = "2026-10-28T00:00:00.000Z";
const AT = "2026-10-28T11:00:00.000Z";
const decision = (answer = "needs_person", probability: unknown = .98) => ({ engine: "nine_questions", answer, sellingOpportunity: { probability } });
type Row = Record<string, unknown>;
function dbFor(tables: Record<string, Row[]>, fail?: string) {
  const queries: string[] = [];
  const db = { from(table: string) {
    queries.push(table);
    let rows = [...(tables[table] ?? [])];
    const value = (r: Row, key: string): unknown => key === "decision->>engine" ? (r.decision as Row)?.engine : r[key];
    const q = {
      select() { return q; },
      eq(k: string, v: unknown) { rows = rows.filter((r) => value(r, k) === v); return q; },
      is(k: string, v: unknown) { return q.eq(k, v); },
      gte(k: string, v: string) { rows = rows.filter((r) => String(r[k]) >= v); return q; },
      in(k: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[k])); return q; },
      or(filter: string) { const m = /^created_at.lt.([^,]+),and\(created_at.eq.[^,]+,id.lt.([^)]*)\)$/.exec(filter)!; rows = rows.filter((r) => String(r.created_at) < m[1]! || (r.created_at === m[1] && String(r.id) < m[2]!)); return q; },
      order() { rows.sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))); return q; },
      limit(n: number) { rows = rows.slice(0,n); return q; },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: rows, error: table === fail ? { message: "offline" } : null }).then(resolve); },
    }; return q;
  } };
  return { db: db as unknown as LooseSupabase, queries };
}
function fixtures(d = decision()): Record<string, Row[]> {
  return {
    sms_classification_runs: [{ id: "r1", org_id: ORG, property_id: "p1", source_inbound_message_id: "m1", created_at: AT, decision: d }],
    messages: [{ id: "m1", org_id: ORG, property_id: "p1", direction: "inbound", channel: "sms", created_at: AT }],
    properties: [{ id: "p1", org_id: ORG, deleted_at: null, contacts: { first_name: "Jonathan" } }],
    hold_alert_deliveries: [],
    pipeline_runs: [{ org_id: ORG, property_id: "p1", inbound_message_id: "m1", final_outcome: "escalated", reason: "nine_needs_person" }],
  };
}
const load = (tables = fixtures(), fail?: string) => loadSellingOpportunities(dbFor(tables, fail).db, ORG, SINCE, Date.parse(NOW), OWNER.userId);

describe("supplemental opportunity", () => {
  it("asks the approved question and keeps the original 15 separate", () => {
    expect(SELLING_OPPORTUNITY_QUESTION).toBe("Did the person indicate that they or someone they know is interested in selling a property?");
    expect(NINE_QUESTION_IDS).toHaveLength(15);
    const request = buildNineQuestionRequest({ our_last_text_to_homeowner: null, homeowner_reply: "My neighbor wants to sell" });
    expect(Object.keys(request.questions)).toHaveLength(16);
    expect(request.questions.selling_opportunity.instructions).toBe(SELLING_OPPORTUNITY_QUESTION);
  });
  it.each(["needs_person", "wrong_person", "already_sold", "tenant", "asked_stop", "hostile", "maybe_later", "just_ok"])("preserves %s while retaining the supplemental flag", async (answer) => {
    const answers = Object.fromEntries([...NINE_QUESTION_IDS.map((id) => [id, { noul: id === answer ? .99 : 0 }]), ["selling_opportunity", { noul: .98 }]]);
    const result = await classifyNineQuestions({ our_last_text_to_homeowner: "Would you sell?", homeowner_reply: "My neighbor wants to sell" }, {
      apiKey: "test", fetch: vi.fn(async () => new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(result.answer).toBe(answer);
    expect(result.sellingOpportunity?.probability).toBe(.98);
    expect(isSupplementalOpportunity(nineDecisionRecord(result))).toBe(true);
    expect(isSupplementalOpportunity(nineDecisionRecord(result, true))).toBe(false);
  });
  it.each([null, undefined, "0.99", -.1, .5999, 1.1, NaN, Infinity])("fails closed for supplemental probability %s", (p) => {
    expect(isSupplementalOpportunity({ ...decision(), sellingOpportunity: { probability: p } })).toBe(false);
  });
  it("does not repeat hot handoffs; accepts the exact cutoff; ignores old records", () => {
    for (const answer of ["open_to_selling", "talked_price", "asked_offer", "named_price", "asked_call"]) expect(isSupplementalOpportunity(decision(answer))).toBe(false);
    expect(isSupplementalOpportunity(decision("needs_person", .6))).toBe(true);
    expect(isSupplementalOpportunity({ engine: "nine_questions", answer: "needs_person" })).toBe(false);
  });
  it("loads a separate owner alert without writing to the property or contacting the seller", async () => {
    const { promotions, complete } = await load();
    expect(complete).toBe(true);
    expect(promotions).toEqual([expect.objectContaining({ kind: "selling_opportunity", propertyId: "p1", key: "hot_text:m1", name: "Jonathan" })]);
    const t = makeDeps({ nowIso: NOW, holds: [], promotions });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(t.sent.every((s) => s.userId === OWNER.userId && s.text.includes("Possible selling opportunity") && s.text.includes("/leads/p1"))).toBe(true);
    expect(t.sent.some((s) => s.text.includes("now on My Leads"))).toBe(false);
  });
  it("a generic lead reply in the same pass does not send a second alert", async () => {
    const { promotions } = await load();
    const t = makeDeps({ nowIso: NOW, holds: [], promotions,
      loadLeadReplies: async () => ({ complete: true, promotions: [{ ...promotions[0]!, kind: "lead_reply", key: "lead_reply:m1" }] }),
    });
    t.store.leadWatermarks.set(ORG, SINCE);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(t.sent.every((s) => s.text.includes("Possible selling opportunity"))).toBe(true);
  });
  it("uses message arrival time, rejects cross-property, deleted, outbound, and other-org rows", async () => {
    for (const [table, field, value] of [["messages", "created_at", "2026-10-01"], ["messages", "property_id", "other"], ["messages", "direction", "outbound"], ["properties", "deleted_at", AT], ["properties", "org_id", "other"], ["sms_classification_runs", "org_id", "other"]]) {
      const f = fixtures(); f[table!]![0]![field!] = value;
      expect((await load(f)).promotions).toEqual([]);
    }
  });
  it.each(["sms_classification_runs", "messages", "properties", "hold_alert_deliveries", "pipeline_runs"])("fails closed on %s lookup errors", async (table) => {
    expect(await load(fixtures(), table)).toEqual({ promotions: [], complete: false });
  });
  it("lets a deterministic price hold own its alert, including after the hold closes", async () => {
    const f = fixtures(); f.pipeline_runs![0]!.reason = "keyword:price_offer";
    expect((await load(f)).promotions).toEqual([]);
  });
  it("waits for routing but eventually alerts an abandoned classification", async () => {
    const f = fixtures(); f.pipeline_runs = [];
    f.messages![0]!.created_at = "2026-10-28T11:50:00.000Z";
    expect((await load(f)).promotions).toEqual([]);
    f.messages![0]!.created_at = AT;
    expect((await load(f)).promotions).toHaveLength(1);
  });
  it("suppresses completed alerts and active generic replies; retries one failed channel", async () => {
    const f = fixtures();
    f.hold_alert_deliveries = ["slack", "sms"].map((channel) => ({ org_id: ORG, recipient_user_id: OWNER.userId, hold_key: "hot_text:m1", channel, status: "sent", attempts: 1 }));
    expect((await load(f)).promotions).toEqual([]);
    f.hold_alert_deliveries[1]!.status = "failed";
    expect((await load(f)).promotions).toHaveLength(1);
    f.hold_alert_deliveries = [{ org_id: ORG, recipient_user_id: OWNER.userId, hold_key: "lead_reply:m1", channel: "sms", status: "sending", attempts: 1 }];
    expect((await load(f)).promotions).toEqual([]);
  });
  it("pages tied timestamps and uses the newest run including a newer negative", async () => {
    const f = fixtures();
    f.sms_classification_runs = Array.from({ length: 201 }, (_, i) => ({ ...f.sms_classification_runs![0], id: `r${String(i).padStart(3, "0")}`, decision: decision("needs_person", i === 200 ? 0 : .98) }));
    expect((await load(f)).promotions).toEqual([]);
    f.sms_classification_runs[200]!.decision = decision();
    expect((await load(f)).promotions).toHaveLength(1);
  });
});
