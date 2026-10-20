import { describe, expect, it, vi } from "vitest";

import { HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE } from "@/lib/hot-sellers/assign";
import { hotTextKey, leadReplyKey } from "@/lib/hot-sellers/hot";

import { runHoldAlertsForOrg } from "./core";
import { loadHotPromotions } from "./index";
import { loadLeadReplies } from "./lead-replies";
import { hold, makeDeps, ORG, OWNER } from "./test-support";
import type { HoldAlertDeps, HotPromotion } from "./types";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = "2026-10-21T12:00:00.000Z";
const AT = "2026-10-21T11:00:00.000Z";

type Tables = Record<string, Array<Record<string, unknown>>>;

/** Minimal in-memory query builder: eq / in / gte / or (keyset) / order / limit. */
function fakeDb(tables: Tables) {
  return {
    from(table: string) {
      const filters: Array<(r: Record<string, unknown>) => boolean> = [];
      let limit = Infinity;
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
        or: () => q,
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        then(resolve: (v: { data: unknown[]; error: null }) => void) {
          const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          resolve({ data: rows.slice(0, limit), error: null });
        },
      };
      return q;
    },
  } as unknown;
}

const msg = (id: string, property_id: string, created_at = AT) => ({ id, property_id, created_at, org_id: ORG, direction: "inbound", channel: "sms" });
const prop = (id: string, status: string) => ({ id, org_id: ORG, status, address: "1 Oak St", city: "Joplin", contacts: { first_name: "Dana" } });

function depsWith(tables: Tables, extra: Parameters<typeof makeDeps>[0] = {}) {
  // The fake store's deliveries feed the loader's "already done" check, as the real table would.
  const db = {
    from(table: string) {
      if (table !== "hold_alert_deliveries") return (fakeDb(tables) as { from: (t: string) => unknown }).from(table);
      const rows = t.store.rows.map((r) => ({
        org_id: r.orgId, hold_key: r.holdKey, channel: r.channel, status: r.status, attempts: r.attempts, recipient_user_id: r.recipientUserId,
      }));
      return (fakeDb({ hold_alert_deliveries: rows }) as { from: (t: string) => unknown }).from(table);
    },
  } as never;
  const t = makeDeps({
    nowIso: NOW,
    holds: [],
    loadLeadReplies: (org, since) => loadLeadReplies(db, org, since, t.deps.now().getTime(), OWNER.userId),
    loadHotPromotions: (org, since) => loadHotPromotions(db, org, since, t.deps.now().getTime(), OWNER.userId),
    ...extra,
  });
  // An org where lead replies were switched on before these texts arrived.
  t.store.leadWatermarks.set(ORG, "2026-10-21T00:00:00.000Z");
  return t;
}

describe("lead-reply alerts (owner decision 2026-10-20)", () => {
  it("a non-hot follow-up on a lead sends one Slack DM + one SMS to Jarrad, keyed by the inbound", async () => {
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.userId])).toEqual([["slack", OWNER.userId], ["sms", OWNER.userId]]);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set([leadReplyKey("in-1")]));
    expect(t.sent[0]!.text).toContain("/leads/p1");
  });

  it("a replay (second pass) sends nothing more", async () => {
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "contacted")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("a hot follow-up that alerts as hot_text sends exactly one alert, not two", async () => {
    const hot: HotPromotion = { propertyId: "p1", assigneeUserId: OWNER.userId, name: "Dana", assignedAt: AT, kind: "hot_text", key: hotTextKey("in-1") };
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")] }, { loadHotPromotions: async () => ({ promotions: [hot], complete: true }) });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set([hotTextKey("in-1")]));
  });

  it("a hot follow-up already alerted on an earlier pass (uncovered hot event) is not re-alerted as lead_reply", async () => {
    const t = depsWith({
      messages: [msg("in-1", "p1")],
      properties: [prop("p1", "new_lead")],
      lead_events: [{ org_id: ORG, property_id: "p1", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "in-1", payload: { covered_by_hold: false } }],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
  });

  it("a hot follow-up covered_by_hold (no hot alert of its own) still alerts once as lead_reply", async () => {
    const t = depsWith({
      messages: [msg("in-1", "p1")],
      properties: [prop("p1", "new_lead")],
      lead_events: [{ org_id: ORG, property_id: "p1", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "in-1", payload: { covered_by_hold: true } }],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(t.store.rows[0]!.holdKey).toBe(leadReplyKey("in-1"));
  });

  it("a non-lead prospect texting 'No' sends nothing", async () => {
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "prospect")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
  });

  it("a prospect-status property with a hot hand-off event counts as a lead", async () => {
    const t = depsWith({
      messages: [msg("in-2", "p1")],
      properties: [prop("p1", "prospect")],
      lead_events: [{ org_id: ORG, property_id: "p1", source_type: HOT_HANDOFF_SOURCE_TYPE, source_id: "in-0", created_at: "2026-10-21T10:00:00.000Z", payload: {} }],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("an event lead: a text from before the hand-off does not alert; one from after does", async () => {
    const t = depsWith({
      messages: [msg("in-early", "p1", "2026-10-21T10:00:00.000Z"), msg("in-late", "p1", "2026-10-21T11:00:00.000Z")],
      properties: [prop("p1", "prospect")],
      lead_events: [{ org_id: ORG, property_id: "p1", source_type: HOT_HANDOFF_SOURCE_TYPE, source_id: "in-x", created_at: "2026-10-21T10:30:00.000Z", payload: {} }],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set([leadReplyKey("in-late")]));
  });

  it("a fresh text whose pipeline run finished alerts right away", async () => {
    const t = depsWith({
      messages: [msg("in-1", "p1", "2026-10-21T11:58:00.000Z")],
      properties: [prop("p1", "new_lead")],
      pipeline_runs: [{ org_id: ORG, inbound_message_id: "in-1", final_outcome: "skipped" }],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("a rep-owned lead still alerts Jarrad (assignment never gates)", async () => {
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [{ ...prop("p1", "interested"), assigned_user_id: "rep-9" }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.every((s) => s.userId === OWNER.userId)).toBe(true);
    expect(t.sent).toHaveLength(2);
  });

  it("the first pass sets the lead-reply watermark to now: earlier texts stay silent (no deploy burst)", async () => {
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")] });
    t.store.leadWatermarks.clear();
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.leadWatermarks.get(ORG)).toBe(NOW);
  });

  it("waits for AI dispatch: a fresh text with no finished claim does not alert; the hot event that lands later sends the only alert", async () => {
    const fresh = "2026-10-21T11:55:00.000Z";
    const tables: Tables = {
      messages: [{ ...msg("in-1", "p1", fresh), metadata: null }],
      properties: [prop("p1", "new_lead")],
      lead_events: [],
      ai_response_claims: [{ org_id: ORG, inbound_message_id: "in-1", status: "processing" }],
    };
    const t = depsWith(tables);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    // Dispatch finishes minutes later and writes the hot event.
    tables.lead_events!.push({ id: "e1", org_id: ORG, property_id: "p1", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "in-1", created_at: "2026-10-21T12:03:00.000Z", payload: { to: OWNER.userId, covered_by_hold: false } });
    tables.ai_response_claims![0]!.status = "completed";
    t.setNow("2026-10-21T12:05:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    t.setNow("2026-10-21T13:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set([hotTextKey("in-1")]));
  });

  it("a fresh text whose dispatch completed (completedAt stamp) alerts right away", async () => {
    const t = depsWith({
      messages: [{ ...msg("in-1", "p1", "2026-10-21T11:58:00.000Z"), metadata: { processing: { aiResponder: { completedAt: "2026-10-21T11:58:30.000Z" } } } }],
      properties: [prop("p1", "new_lead")],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("symmetric: once lead_reply:<X> went out, a late hot_text for X sends nothing more", async () => {
    const tables: Tables = { messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")], lead_events: [] };
    const t = depsWith(tables);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    tables.lead_events!.push({ id: "e1", org_id: ORG, property_id: "p1", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "in-1", created_at: "2026-10-21T11:59:00.000Z", payload: { to: OWNER.userId, covered_by_hold: false } });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("a text covered by a hot hold this pass (its run inbound, or before its hot flag) alerts only as hot", async () => {
    const t = depsWith(
      { messages: [msg("in-1", "p1"), msg("in-2", "p2")], properties: [prop("p1", "new_lead"), prop("p2", "new_lead")] },
      {
        holds: [
          hold({ propertyId: "p1", holdKey: "p1:x", hot: true, flagHot: false, runHot: true, runInbound: "in-1", runStartedAt: AT, startedAt: AT }),
          hold({ propertyId: "p2", holdKey: "p2:x", hot: true, startedAt: AT, flagAt: "2026-10-21T11:30:00.000Z" }),
        ],
      },
    );
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.some((r) => r.holdKey.startsWith("lead_reply:"))).toBe(false);
    expect(t.sent).toHaveLength(4);
  });

  it("hot alerts are queued before lead replies", async () => {
    const hot: HotPromotion = { propertyId: "p9", assigneeUserId: OWNER.userId, name: "Hot", assignedAt: AT, kind: "hot_text", key: hotTextKey("in-9") };
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")] }, { loadHotPromotions: async () => ({ promotions: [hot], complete: true }) });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.map((r) => r.holdKey)).toEqual([hotTextKey("in-9"), hotTextKey("in-9"), leadReplyKey("in-1"), leadReplyKey("in-1")]);
  });

  it("a failing lead-reply watermark skips lead replies for the pass; hot alerts still send", async () => {
    const hot: HotPromotion = { propertyId: "p9", assigneeUserId: OWNER.userId, name: "Hot", assignedAt: AT, kind: "hot_text", key: hotTextKey("in-9") };
    const t = depsWith({ messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")] }, { loadHotPromotions: async () => ({ promotions: [hot], complete: true }) });
    t.store.getOrInitLeadRepliesSince = async () => {
      throw new Error("column lead_replies_since does not exist");
    };
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.map((r) => r.holdKey)).toEqual([hotTextKey("in-9"), hotTextKey("in-9")]);
    expect(summary.sent).toBe(2);
  });

  it("a skipped or terminally failed lead_reply does not swallow the late hot alert", async () => {
    const tables: Tables = { messages: [msg("in-1", "p1")], properties: [prop("p1", "new_lead")], lead_events: [] };
    const t = depsWith(tables);
    t.deps.sendSlack = async () => ({ status: "skipped", reason: "test" });
    t.deps.sendSms = async () => ({ status: "skipped", reason: "test" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.every((r) => r.holdKey === leadReplyKey("in-1") && r.status === "skipped")).toBe(true);
    tables.lead_events!.push({ id: "e1", org_id: ORG, property_id: "p1", source_type: HOT_TEXT_SOURCE_TYPE, source_id: "in-1", created_at: "2026-10-21T11:59:00.000Z", payload: { to: OWNER.userId, covered_by_hold: false } });
    t.deps.sendSlack = async (userId, text) => (t.sent.push({ channel: "slack", userId, text }), { status: "sent" });
    t.deps.sendSms = async (userId, text) => (t.sent.push({ channel: "sms", userId, text }), { status: "sent" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.filter((r) => r.holdKey === hotTextKey("in-1") && r.status === "sent")).toHaveLength(2);
  });

  it("texts before the lead-reply watermark stay silent", async () => {
    const t = depsWith({ messages: [msg("in-old", "p1", "2026-10-20T10:00:00.000Z")], properties: [prop("p1", "new_lead")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
  });

  it("no loadLeadReplies dep → behaviour unchanged", async () => {
    const t = makeDeps({ nowIso: NOW, holds: [] });
    const deps: HoldAlertDeps = { ...t.deps, loadLeadReplies: undefined };
    await runHoldAlertsForOrg(deps, ORG);
    expect(t.sent).toEqual([]);
  });
});
