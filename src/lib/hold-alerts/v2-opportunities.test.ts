import { describe, expect, it, vi } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { OPPORTUNITY_SIGNALS } from "@/lib/sms-classification/routing-v2/order";
import { V2_QUESTIONS } from "@/lib/sms-classification/routing-v2/questions";

import { runHoldAlertsForOrg } from "./core";
import { makeDeps, ORG, OWNER } from "./test-support";
import { isV2Opportunity, loadV2Opportunities, v2OpportunityStillAllowed } from "./v2-opportunities";

/**
 * #937 equivalence suite: every case of PR #937's selling-opportunities.test.ts, re-run
 * against the v2 decision source (routing_v2_shadow_decisions, two approved questions),
 * plus the v2 flag gate.
 */
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
const NOW = "2026-10-28T12:00:00.000Z";
const SINCE = "2026-10-28T00:00:00.000Z";
const AT = "2026-10-28T11:00:00.000Z";
const P1 = "11111111-1111-4111-8111-111111111111";
const FLAGS_ON = { shadow: true, questions_live: true, replies: true, canary_property_ids: [P1] };
/** alert_on_time_only ON: yes-family roads are non-hot. */
const TOO = { alertOnTimeOnly: true };
const probs = (own: unknown = 0.98, other: unknown = 0) => ({ own_other_property: own, someone_else_property: other });
const row = (road: string | null = "not_interested_drip", p: Record<string, unknown> = probs()) => ({
  id: "r1", org_id: ORG, property_id: P1, inbound_message_id: "m1", created_at: AT, status: "decided", road, opportunity_alert: true, probabilities: p,
});
type Row = Record<string, unknown>;
function dbFor(tables: Record<string, Row[]>, fail?: string) {
  const queries: string[] = [];
  const db = { from(table: string) {
    queries.push(table);
    let rows = [...(tables[table] ?? [])];
    const q = {
      select() { return q; },
      eq(k: string, v: unknown) { rows = rows.filter((r) => r[k] === v); return q; },
      is(k: string, v: unknown) { return q.eq(k, v); },
      gte(k: string, v: string) { rows = rows.filter((r) => String(r[k]) >= v); return q; },
      in(k: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[k])); return q; },
      or(filter: string) { const m = /^created_at.lt.([^,]+),and\(created_at.eq.[^,]+,id.lt.([^)]*)\)$/.exec(filter)!; rows = rows.filter((r) => String(r.created_at) < m[1]! || (r.created_at === m[1] && String(r.id) < m[2]!)); return q; },
      order() { rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))); return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: table === fail ? { message: "offline" } : null }); },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve({ data: rows, error: table === fail ? { message: "offline" } : null }).then(resolve); },
    }; return q;
  } };
  return { db: db as unknown as LooseSupabase, queries };
}
function fixtures(r: Row = row(), flags: unknown = FLAGS_ON): Record<string, Row[]> {
  return {
    ai_responder_configs: [{ org_id: ORG, active: true, routing_v2_flags: flags }],
    routing_v2_shadow_decisions: [r],
    messages: [{ id: "m1", org_id: ORG, property_id: P1, direction: "inbound", channel: "sms", created_at: AT }],
    properties: [{ id: P1, org_id: ORG, deleted_at: null, contacts: { first_name: "Jonathan" } }],
    hold_alert_deliveries: [],
    pipeline_runs: [{ org_id: ORG, property_id: P1, inbound_message_id: "m1", final_outcome: "escalated", reason: "nine_needs_person" }],
  };
}
const load = (tables = fixtures(), fail?: string, owner: string | null = OWNER.userId) =>
  loadV2Opportunities(dbFor(tables, fail).db, ORG, SINCE, Date.parse(NOW), owner);

describe("v2 opportunity alert (#937 equivalence)", () => {
  it("reads the two approved opportunity questions (not #937's retired one)", () => {
    expect(OPPORTUNITY_SIGNALS).toEqual(["own_other_property", "someone_else_property"]);
    expect(V2_QUESTIONS.own_other_property).toBe("Did the seller mention another property that they own and are interested in selling?");
    expect(V2_QUESTIONS.someone_else_property).toBe("Did the seller mention a different property, not the one we asked about and not one they own, that may be for sale?");
  });

  it("flag gate: off, questions_live off, not eligible, or config error = nothing, and no decision query", async () => {
    for (const flags of [{}, { shadow: true, replies: true, canary_property_ids: [P1] }, { shadow: true, questions_live: true, canary_property_ids: [P1] }, { questions_live: true, replies: true, canary_property_ids: [P1] }, null]) {
      const { db, queries } = dbFor(fixtures(row(), flags));
      expect(await loadV2Opportunities(db, ORG, SINCE, Date.parse(NOW), OWNER.userId)).toEqual({ promotions: [], complete: true });
      expect(queries).toEqual(["ai_responder_configs"]);
    }
    expect((await load(fixtures(row(), { shadow: true, questions_live: true, replies: true }))).promotions).toEqual([]);
    expect(await load(fixtures(), "ai_responder_configs")).toEqual({ promotions: [], complete: true });
  });

  it.each(["stop", "wrong_number_close", "not_interested_drip", "maybe_later_drip", "who_reply_drip", "listed_drip", "vacant_land_drip", "text_only_reply"])(
    "keeps the %s route and adds the opportunity alert", (road) => {
      expect(isV2Opportunity(row(road), TOO)).toBe(true);
    });

  it("requires the persisted opportunity_alert === true (code pre-checks store false)", async () => {
    for (const v of [false, null, undefined, "true", 1]) {
      expect(isV2Opportunity({ ...row("stop"), opportunity_alert: v as never }, TOO)).toBe(false);
      const f = fixtures({ ...row("stop"), opportunity_alert: v });
      expect((await load(f)).promotions).toEqual([]);
    }
  });

  it("yes-family roads are hot (today's alert owns them) unless alert_on_time_only is on", async () => {
    for (const road of ["book_appointment", "reaction+book_appointment", "driving_reply+book_appointment"]) {
      expect(isV2Opportunity(row(road), { alertOnTimeOnly: false }), road).toBe(false);
      expect(isV2Opportunity(row(road), { alertOnTimeOnly: true }), road).toBe(true);
      expect((await load(fixtures(row(road)))).promotions, road).toEqual([]);
      expect((await load(fixtures(row(road), { ...FLAGS_ON, alert_on_time_only: true }))).promotions, road).toHaveLength(1);
    }
  });

  it("unknown or future roads never alert (allow-list)", () => {
    for (const road of ["ALERT_future_thing", "brand_new_road", "", "STOP", "haiku_unsure", "possible_stop", "haiku_error"]) {
      expect(isV2Opportunity(row(road), TOO), road).toBe(false);
    }
  });

  it("re-checks flags + eligibility right before send: a flip between load and send sends nothing", async () => {
    const { promotions } = await load();
    expect(promotions).toHaveLength(1);
    let allowed = false;
    const t = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: async () => allowed });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    // Missing dep or a throwing check also fails closed.
    const t2 = makeDeps({ nowIso: NOW, holds: [], promotions });
    await runHoldAlertsForOrg(t2.deps, ORG);
    expect(t2.sent).toEqual([]);
    const t3 = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: async () => { throw new Error("db"); } });
    await runHoldAlertsForOrg(t3.deps, ORG);
    expect(t3.sent).toEqual([]);
    allowed = true;
    const t4 = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: async () => allowed });
    await runHoldAlertsForOrg(t4.deps, ORG);
    expect(t4.sent).toHaveLength(2);
  });

  it("send-time check re-judges the latest decision with fresh alert_on_time_only, both ways", async () => {
    const yes = (flags: unknown) => fixtures(row("book_appointment"), flags);
    // loaded while ON (eligible), flipped OFF before send -> not sent (today's hot alert owns it)
    expect(await v2OpportunityStillAllowed(dbFor(yes({ ...FLAGS_ON, alert_on_time_only: true })).db, ORG, P1, "m1")).toBe(true);
    expect(await v2OpportunityStillAllowed(dbFor(yes({ ...FLAGS_ON, alert_on_time_only: false })).db, ORG, P1, "m1")).toBe(false);
    // non-yes road is unaffected by the flip
    expect(await v2OpportunityStillAllowed(dbFor(fixtures(row("stop"), { ...FLAGS_ON, alert_on_time_only: false })).db, ORG, P1, "m1")).toBe(true);
    // a newer decision for the inbound that says no wins at send time
    const f = fixtures(); f.routing_v2_shadow_decisions!.push({ ...row(), id: "r2", created_at: "2026-10-28T11:30:00.000Z", opportunity_alert: false });
    expect(await v2OpportunityStillAllowed(dbFor(f).db, ORG, P1, "m1")).toBe(false);
    // no inbound id, decision lookup error, property mismatch -> false
    expect(await v2OpportunityStillAllowed(dbFor(fixtures()).db, ORG, P1, undefined)).toBe(false);
    expect(await v2OpportunityStillAllowed(dbFor(fixtures(), "routing_v2_shadow_decisions").db, ORG, P1, "m1")).toBe(false);
    expect(await v2OpportunityStillAllowed(dbFor(fixtures()).db, ORG, "22222222-2222-4222-8222-222222222222", "m1")).toBe(false);
  });

  it("end to end: flip alert_on_time_only between load and send, both ways", async () => {
    const tables = fixtures(row("book_appointment"), { ...FLAGS_ON, alert_on_time_only: true });
    const { promotions } = await load(tables);
    expect(promotions).toHaveLength(1);
    tables.ai_responder_configs![0]!.routing_v2_flags = { ...FLAGS_ON, alert_on_time_only: false };
    const t = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: (o, p, i) => v2OpportunityStillAllowed(dbFor(tables).db, o, p, i) });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    tables.ai_responder_configs![0]!.routing_v2_flags = { ...FLAGS_ON, alert_on_time_only: true };
    const t2 = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: (o, p, i) => v2OpportunityStillAllowed(dbFor(tables).db, o, p, i) });
    await runHoldAlertsForOrg(t2.deps, ORG);
    expect(t2.sent).toHaveLength(2);
  });

  it("the send-time check never touches today's hot alerts", async () => {
    const hot = { propertyId: P1, assigneeUserId: OWNER.userId, name: "Jonathan", assignedAt: AT, kind: "hot_text" as const, inboundId: "m9", key: "hot_text:m9" };
    const check = vi.fn(async () => false);
    const t = makeDeps({ nowIso: NOW, holds: [], promotions: [hot], v2OpportunityStillAllowed: check });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(check).not.toHaveBeenCalled();
  });

  it("v2OpportunityStillAllowed reads fresh flags and fails closed", async () => {
    expect(await v2OpportunityStillAllowed(dbFor(fixtures()).db, ORG, P1, "m1")).toBe(true);
    expect(await v2OpportunityStillAllowed(dbFor(fixtures(row(), { ...FLAGS_ON, replies: false })).db, ORG, P1, "m1")).toBe(false);
    expect(await v2OpportunityStillAllowed(dbFor(fixtures(row(), { ...FLAGS_ON, canary_property_ids: [] })).db, ORG, P1, "m1")).toBe(false);
    expect(await v2OpportunityStillAllowed(dbFor(fixtures(), "ai_responder_configs").db, ORG, P1, "m1")).toBe(false);
  });

  it("either question alone qualifies", () => {
    expect(isV2Opportunity(row("stop", probs(0, 0.7)), TOO)).toBe(true);
    expect(isV2Opportunity(row("stop", probs(0.7, 0)), TOO)).toBe(true);
    expect(isV2Opportunity(row("stop", probs(0, 0)), TOO)).toBe(false);
  });

  it.each([null, undefined, "0.99", -0.1, 0.5999, 1.1, NaN, Infinity])("fails closed for probability %s", (p) => {
    expect(isV2Opportunity(row("stop", { own_other_property: p, someone_else_property: p }), TOO)).toBe(false);
  });

  it("does not repeat hot/alert routes; accepts the exact cutoff; ignores failed and no-answer rows", () => {
    for (const road of ["ALERT_call_me", "ALERT_land_price", "ALERT_commercial", "ALERT_said_theyll_call", "ALERT_reason_to_sell", "price_check", "possible_stop", "haiku_error", "haiku_unsure"]) {
      expect(isV2Opportunity(row(road), TOO)).toBe(false);
    }
    expect(isV2Opportunity(row("stop", probs(0.6)), TOO)).toBe(true);
    expect(isV2Opportunity({ ...row(), status: "failed" }, TOO)).toBe(false);
    expect(isV2Opportunity(row(null), TOO)).toBe(false);
    expect(isV2Opportunity({ ...row(), probabilities: null }, TOO)).toBe(false);
  });

  it("owner-only: no owner = no alert", async () => {
    expect(await load(fixtures(), undefined, null)).toEqual({ promotions: [], complete: true });
  });

  it("loads a separate owner alert without writing to the property or contacting the seller", async () => {
    const { promotions, complete } = await load();
    expect(complete).toBe(true);
    expect(promotions).toEqual([expect.objectContaining({ kind: "selling_opportunity", propertyId: P1, key: "hot_text:m1", name: "Jonathan" })]);
    const t = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: async () => true });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(t.sent.every((s) => s.userId === OWNER.userId && s.text.includes("Possible selling opportunity") && s.text.includes(`/leads/${P1}`))).toBe(true);
    expect(t.sent.some((s) => s.text.includes("now on My Leads"))).toBe(false);
  });

  it("is read-only: only selects, never writes", async () => {
    const { db, queries } = dbFor(fixtures());
    await loadV2Opportunities(db, ORG, SINCE, Date.parse(NOW), OWNER.userId);
    expect(new Set(queries)).toEqual(new Set(["ai_responder_configs", "routing_v2_shadow_decisions", "messages", "properties", "pipeline_runs", "hold_alert_deliveries"]));
  });

  it("a generic lead reply in the same pass does not send a second alert", async () => {
    const { promotions } = await load();
    const t = makeDeps({ nowIso: NOW, holds: [], promotions, v2OpportunityStillAllowed: async () => true,
      loadLeadReplies: async () => ({ complete: true, promotions: [{ ...promotions[0]!, kind: "lead_reply", key: "lead_reply:m1" }] }),
    });
    t.store.leadWatermarks.set(ORG, SINCE);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(t.sent.every((s) => s.text.includes("Possible selling opportunity"))).toBe(true);
  });

  it("uses message arrival time (7-day lookback), rejects cross-property, deleted, outbound, and other-org rows", async () => {
    for (const [table, field, value] of [["messages", "created_at", "2026-10-01"], ["messages", "property_id", "other"], ["messages", "direction", "outbound"], ["properties", "deleted_at", AT], ["properties", "org_id", "other"], ["routing_v2_shadow_decisions", "org_id", "other"]] as const) {
      const f = fixtures(); f[table]![0]![field] = value;
      expect((await load(f)).promotions).toEqual([]);
    }
    const old = fixtures(); old.routing_v2_shadow_decisions![0]!.created_at = "2026-10-20T00:00:00.000Z";
    expect((await loadV2Opportunities(dbFor(old).db, ORG, "2026-10-01T00:00:00.000Z", Date.parse(NOW), OWNER.userId)).promotions).toEqual([]);
  });

  it.each(["routing_v2_shadow_decisions", "messages", "properties", "hold_alert_deliveries", "pipeline_runs"])("fails closed on %s lookup errors", async (table) => {
    expect(await load(fixtures(), table)).toEqual({ promotions: [], complete: false });
  });

  it("lets a deterministic price hold own its alert, including after the hold closes", async () => {
    const f = fixtures(); f.pipeline_runs![0]!.reason = "keyword:price_offer";
    expect((await load(f)).promotions).toEqual([]);
  });

  it("waits 30 min for routing but eventually alerts an abandoned decision", async () => {
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

  it("pages tied timestamps and uses the newest decision including a newer negative", async () => {
    const f = fixtures();
    f.routing_v2_shadow_decisions = Array.from({ length: 201 }, (_, i) => ({ ...row(), id: `r${String(i).padStart(3, "0")}`, probabilities: probs(i === 200 ? 0 : 0.98) }));
    expect((await load(f)).promotions).toEqual([]);
    f.routing_v2_shadow_decisions[200]!.probabilities = probs();
    expect((await load(f)).promotions).toHaveLength(1);
  });
});
