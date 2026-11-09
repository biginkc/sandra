import { describe, expect, it, vi } from "vitest";

import { ambiguousThreadKey, hotTextKey, leadReplyKey } from "@/lib/hot-sellers/hot";

import { AMBIGUOUS_THREAD_RESOLUTIONS, ambiguousThreadLinkPath, loadAmbiguousThreadAlerts } from "./ambiguous-threads";
import { runHoldAlertsForOrg } from "./core";
import { createHoldAlertDeps } from "./index";
import { loadLeadReplies } from "./lead-replies";
import { hotPromotionSlackText, hotPromotionSmsText } from "./messages";
import { FakeStore, makeDeps, ORG, OWNER } from "./test-support";
import type { HotPromotion } from "./types";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

// Synthetic data only.
const NOW = "2026-11-09T12:00:00.000Z";
const AT = "2026-11-09T11:50:00.000Z";
const BASE = "https://app.example.com";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const col = (r: Row, c: string): unknown => {
  if (c === "metadata->>routing") {
    const v = (r.metadata as { routing?: unknown } | null)?.routing;
    return v == null ? null : String(v);
  }
  return r[c];
};

/** In-memory PostgREST subset: eq / in / is / gte / like / or (keyset, ignored) / order / limit. */
function fakeDb(tables: () => Tables, calls: Array<{ table: string; op: string; col: string; val: unknown }> = []) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let limit = Infinity;
      const rec = (op: string, c: string, v: unknown) => calls.push({ table, op, col: c, val: v });
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (rec("eq", c, v), filters.push((r) => col(r, c) === v), q),
        in: (c: string, v: unknown[]) => (rec("in", c, v), filters.push((r) => v.includes(col(r, c))), q),
        is: (c: string, v: null) => (rec("is", c, v), filters.push((r) => (col(r, c) ?? null) === v), q),
        gte: (c: string, v: string) => (filters.push((r) => String(col(r, c)) >= v), q),
        like: (c: string, v: string) => (filters.push((r) => String(col(r, c)).startsWith(v.replace(/%$/, ""))), q),
        or: () => q,
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        then(resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => void) {
          const rows = (tables()[table] ?? []).filter((r) => filters.every((f) => f(r)));
          resolve({ data: rows.slice(0, limit), error: null });
        },
      };
      return q;
    },
  } as never;
}

const amb = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  org_id: ORG,
  direction: "inbound",
  channel: "sms",
  property_id: null,
  contact_id: "c-1",
  conversation_id: "conv-1",
  created_at: AT,
  metadata: { routing: "ambiguous_contact" },
  ...over,
});
const contact = { id: "c-1", org_id: ORG, first_name: "Testa" };

/** Deps wired to the REAL loaders over a fake db whose deliveries mirror the fake store. */
function setup(tables: Tables, opts: { flag?: boolean; ambSince?: string; extra?: Parameters<typeof makeDeps>[0] } = {}) {
  const flag = opts.flag ?? true;
  const calls: Array<{ table: string; op: string; col: string; val: unknown }> = [];
  const view = (): Tables => ({
    ...tables,
    hold_alert_deliveries: t.store.rows.map((r) => ({
      org_id: r.orgId, hold_key: r.holdKey, channel: r.channel, status: r.status, attempts: r.attempts, recipient_user_id: r.recipientUserId, created_at: r.createdAt,
    })),
  });
  const db = fakeDb(view, calls);
  const t = makeDeps({
    nowIso: NOW,
    holds: [],
    loadLeadReplies: (org, since) =>
      flag
        ? loadLeadReplies(db, org, since, t.deps.now().getTime(), OWNER.userId, { ambiguousOwnsKeys: true })
        : loadLeadReplies(db, org, since, t.deps.now().getTime(), OWNER.userId),
    ...(flag ? { loadAmbiguousThreadAlerts: (org: string, since: string) => loadAmbiguousThreadAlerts(db, org, since, t.deps.now().getTime(), OWNER.userId) } : {}),
    ...opts.extra,
  });
  t.store.leadWatermarks.set(ORG, "2026-11-01T00:00:00.000Z");
  if (opts.ambSince !== undefined) t.store.ambiguousWatermarks.set(ORG, opts.ambSince);
  else t.store.ambiguousWatermarks.set(ORG, "2026-11-09T00:00:00.000Z");
  return { ...t, calls, tables };
}

describe("ambiguous-thread loader predicate", () => {
  it.each(AMBIGUOUS_THREAD_RESOLUTIONS)("alerts on %s", async (routing) => {
    const db = fakeDb(() => ({ messages: [amb("m1", { metadata: { routing } })], contacts: [contact] }));
    const r = await loadAmbiguousThreadAlerts(db, ORG, "2026-11-09T00:00:00.000Z", Date.parse(NOW));
    expect(r.promotions.map((p) => p.key)).toEqual([ambiguousThreadKey("m1")]);
    expect(r.promotions[0]).toMatchObject({ kind: "ambiguous_thread", propertyId: null, name: "Testa", inboundId: "m1" });
  });

  it.each(["unmatched_contact", "matched_contact_without_property", "matched_single_linked_property"])("excludes %s", async (routing) => {
    const db = fakeDb(() => ({ messages: [amb("m1", { metadata: { routing } })] }));
    expect((await loadAmbiguousThreadAlerts(db, ORG, "2026-11-09T00:00:00.000Z", Date.parse(NOW))).promotions).toEqual([]);
  });

  it("excludes a resolved row, another org, outbound, non-sms, missing routing, and anything older than an hour", async () => {
    const db = fakeDb(() => ({
      messages: [
        amb("resolved", { property_id: "p1" }),
        amb("other-org", { org_id: "org-2" }),
        amb("outbound", { direction: "outbound" }),
        amb("email", { channel: "email" }),
        amb("no-routing", { metadata: {} }),
        amb("old", { created_at: "2026-11-09T10:30:00.000Z" }),
      ],
    }));
    expect((await loadAmbiguousThreadAlerts(db, ORG, "2026-11-01T00:00:00.000Z", Date.parse(NOW))).promotions).toEqual([]);
  });

  it("links: a contact's reply opens its own conversation; never a contact id", async () => {
    const db = fakeDb(() => ({ messages: [amb("m1", { contact_id: "c-1", conversation_id: "conv-9" })], contacts: [contact] }));
    const [p] = (await loadAmbiguousThreadAlerts(db, ORG, "2026-11-09T00:00:00.000Z", Date.parse(NOW))).promotions;
    expect(p!.linkPath).toBe("/messages?thread=conv-9");
    expect(hotPromotionSlackText(p!, BASE)).not.toContain("c-1");
  });

  it.each(AMBIGUOUS_THREAD_RESOLUTIONS)("links: %s with several contacts (contact and conversation null) -> unknown-sender list", async (routing) => {
    const db = fakeDb(() => ({ messages: [amb("m1", { contact_id: null, conversation_id: null, metadata: { routing } })] }));
    const [p] = (await loadAmbiguousThreadAlerts(db, ORG, "2026-11-09T00:00:00.000Z", Date.parse(NOW))).promotions;
    expect(p!.linkPath).toBe("/messages?filter=unknown");
    expect(p!.name).toBe("Unknown sender");
  });

  it("link helper", () => {
    expect(ambiguousThreadLinkPath("abc")).toBe("/messages?thread=abc");
    expect(ambiguousThreadLinkPath(null)).toBe("/messages?filter=unknown");
  });

  it("drain returns failed/pending rows with no property, lookback or watermark predicate, and skips finished ones", async () => {
    const deliveries = (key: string, slack: [string, number], sms: [string, number]) => [
      { org_id: ORG, hold_key: key, channel: "slack", status: slack[0], attempts: slack[1], recipient_user_id: OWNER.userId, created_at: AT },
      { org_id: ORG, hold_key: key, channel: "sms", status: sms[0], attempts: sms[1], recipient_user_id: OWNER.userId, created_at: AT },
    ];
    const db = fakeDb(() => ({
      messages: [
        amb("retry", { property_id: "p-now", created_at: "2026-11-09T08:00:00.000Z" }),
        amb("done", { created_at: "2026-11-09T08:00:00.000Z" }),
        amb("exhausted", { created_at: "2026-11-09T08:00:00.000Z" }),
      ],
      hold_alert_deliveries: [
        ...deliveries(ambiguousThreadKey("retry"), ["sent", 1], ["failed", 1]),
        ...deliveries(ambiguousThreadKey("done"), ["sent", 1], ["skipped", 1]),
        ...deliveries(ambiguousThreadKey("exhausted"), ["sent", 1], ["failed", 3]),
      ],
    }));
    const r = await loadAmbiguousThreadAlerts(db, ORG, "2026-11-09T11:00:00.000Z", Date.parse(NOW), OWNER.userId);
    expect(r.promotions.map((p) => [p.key, p.drained])).toEqual([[ambiguousThreadKey("retry"), true]]);
  });
});

describe("ambiguous-thread alerts: wording reuses the existing hold strings", () => {
  const p: HotPromotion = { propertyId: null, assigneeUserId: "", name: "Testa", assignedAt: AT, kind: "ambiguous_thread", key: "k", linkPath: "/messages?thread=conv-1" };
  it("Slack and SMS", () => {
    expect(hotPromotionSlackText(p, BASE)).toBe("New hold needs review: Testa (needs a reply). https://app.example.com/messages?thread=conv-1");
    expect(hotPromotionSmsText(p, BASE)).toBe("Hot hold: Testa (needs a reply). https://app.example.com/messages?thread=conv-1");
  });
  it("matches the existing routing-v2 hold copy shape exactly", () => {
    const v2: HotPromotion = { ...p, propertyId: "p1", kind: "routing_v2_alert", label: "needs a reply" };
    expect(hotPromotionSlackText(v2, BASE).replace(/ https.*$/, "")).toBe(hotPromotionSlackText(p, BASE).replace(/ https.*$/, ""));
    expect(hotPromotionSmsText(v2, BASE).replace(/ https.*$/, "")).toBe(hotPromotionSmsText(p, BASE).replace(/ https.*$/, ""));
  });
});

describe("ambiguous-thread alerts end to end (fake store, real loaders)", () => {
  it("flag on: one Slack + one SMS to Jarrad with the hold copy; a replay sends nothing", async () => {
    const t = setup({ messages: [amb("m1")], contacts: [contact] });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.userId, s.text])).toEqual([
      ["slack", OWNER.userId, "New hold needs review: Testa (needs a reply). https://app.example.com/messages?thread=conv-1"],
      ["sms", OWNER.userId, "Hot hold: Testa (needs a reply). https://app.example.com/messages?thread=conv-1"],
    ]);
    expect(t.store.rows.map((r) => [r.holdKey, r.propertyId])).toEqual([
      [ambiguousThreadKey("m1"), null],
      [ambiguousThreadKey("m1"), null],
    ]);
  });

  it("flag off: nothing read or written for this feature", async () => {
    const t = setup({ messages: [amb("m1")], contacts: [contact] }, { flag: false });
    t.store.ambiguousWatermarks.clear();
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.ambiguousWatermarks.size).toBe(0);
  });

  it("first enabled pass sets the watermark to now: earlier replies (today's backlog) stay silent", async () => {
    const t = setup({ messages: [amb("m1")], contacts: [contact] }, { ambSince: "" });
    t.store.ambiguousWatermarks.clear();
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.ambiguousWatermarks.get(ORG)).toBe(NOW);
    expect(t.sent).toEqual([]);
    t.tables.messages!.push(amb("m2", { created_at: "2026-11-09T12:01:00.000Z" }));
    t.setNow("2026-11-09T12:05:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    expect(t.store.rows.every((r) => r.holdKey === ambiguousThreadKey("m2"))).toBe(true);
  });

  it("missing migration column: the feature no-ops, the pass completes, hot alerts still go", async () => {
    const hot: HotPromotion = { propertyId: "p1", assigneeUserId: OWNER.userId, name: "Dana", assignedAt: AT, kind: "hot_text", key: hotTextKey("x") };
    const t = setup({ messages: [amb("m1")], contacts: [contact] }, { extra: { promotions: [hot] } });
    t.store.ambiguousColumnMissing = true;
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(summary.sent).toBe(2);
    expect(t.store.rows.map((r) => r.holdKey)).toEqual([hotTextKey("x"), hotTextKey("x")]);
  });

  it("a loader that throws does not break the cron", async () => {
    const t = setup({}, { extra: { loadAmbiguousThreadAlerts: async () => { throw new Error("boom"); } } });
    await expect(runHoldAlertsForOrg(t.deps, ORG)).resolves.toBeDefined();
  });

  describe("MAJOR a: both channel intents persist before either send", () => {
    it("the SMS row exists (pending) before Slack is called", async () => {
      const t = setup({ messages: [amb("m1")], contacts: [contact] });
      let rowsAtSlack: string[] = [];
      t.deps.sendSlack = async () => {
        rowsAtSlack = t.store.rows.map((r) => `${r.channel}:${r.status}`);
        return { status: "sent" };
      };
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(rowsAtSlack.sort()).toEqual(["slack:sending", "sms:pending"]);
    });

    it("run dies after Slack (budget/timeout), reply is then resolved and ages past the lookback: SMS still goes out once", async () => {
      const t = setup({ messages: [amb("m1")], contacts: [contact] });
      const realSlack = t.deps.sendSlack;
      t.deps.sendSlack = async (u, text) => {
        const r = await realSlack(u, text);
        t.setNow("2026-11-09T12:00:49.000Z"); // the budget is gone right after Slack
        return r;
      };
      const first = await runHoldAlertsForOrg(t.deps, ORG, { budgetMs: 50_000 });
      expect(first.budgetExhausted).toBe(true);
      expect(t.sent.map((s) => s.channel)).toEqual(["slack"]);
      expect(t.store.rows.find((r) => r.channel === "sms")?.status).toBe("pending");
      // Resolved to a property by hand, and now well past the 1h lookback.
      t.tables.messages![0]!.property_id = "p-resolved";
      t.tables.messages![0]!.conversation_id = "conv-restamped";
      t.setNow("2026-11-09T15:00:00.000Z");
      await runHoldAlertsForOrg(t.deps, ORG);
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent.map((s) => s.channel)).toEqual(["slack", "sms"]);
      expect(t.sent[1]!.text).toBe("Hot hold: Testa (needs a reply). https://app.example.com/messages?thread=conv-restamped");
    });

    it("recovery for an interrupted intent: Slack sent but the SMS row was never created -> SMS sent later, Slack not repeated", async () => {
      const t = setup({ messages: [amb("m1", { property_id: "p-resolved", created_at: "2026-11-09T08:00:00.000Z" })], contacts: [contact] });
      const slack = await t.store.ensure({ orgId: ORG, propertyId: null, holdKey: ambiguousThreadKey("m1"), recipientUserId: OWNER.userId, channel: "slack", stage: "first" });
      await t.store.claim(slack);
      await t.store.markSent(slack.id);
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent.map((s) => s.channel)).toEqual(["sms"]);
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent).toHaveLength(1);
    });
  });

  describe("MAJOR b: one recovery owner per flag state", () => {
    const resolvedLeadMsg = (over: Partial<Row> = {}) =>
      amb("m1", { property_id: "p1", created_at: "2026-11-09T11:20:00.000Z", ...over });
    const leadProp = { id: "p1", org_id: ORG, status: "new_lead", address: "1 Test St", city: "Testville", contacts: { first_name: "Testa" } };
    const seedPartial = async (store: FakeStore) => {
      const s = await store.ensure({ orgId: ORG, propertyId: null, holdKey: ambiguousThreadKey("m1"), recipientUserId: OWNER.userId, channel: "slack", stage: "first" });
      await store.claim(s);
      await store.markSent(s.id);
      const m = await store.ensure({ orgId: ORG, propertyId: null, holdKey: ambiguousThreadKey("m1"), recipientUserId: OWNER.userId, channel: "sms", stage: "first" });
      await store.claim(m);
      await store.markFailed(m.id, "provider 500");
    };

    it("flag off: lead-reply lookup keys are exactly today's four (byte-identical path)", async () => {
      const calls: Array<{ table: string; op: string; col: string; val: unknown }> = [];
      const db = fakeDb(() => ({ messages: [resolvedLeadMsg()], properties: [leadProp] }), calls);
      await loadLeadReplies(db, ORG, "2026-11-01T00:00:00.000Z", Date.parse(NOW), OWNER.userId);
      const keys = calls.find((c) => c.table === "hold_alert_deliveries" && c.op === "in")!.val as string[];
      expect(keys).toEqual(["hot_text:m1", "hot_handoff:m1", "hot_failed:m1", leadReplyKey("m1")]);
    });

    it("flag on, partial ambiguous delivery on a since-resolved lead reply: lead loader skips it, the ambiguous drain finishes SMS", async () => {
      const t = setup({ messages: [resolvedLeadMsg()], properties: [leadProp], contacts: [contact] });
      await seedPartial(t.store);
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent.map((s) => [s.channel, s.text])).toEqual([["sms", "Hot hold: Testa (needs a reply). https://app.example.com/messages?thread=conv-1"]]);
      expect(t.store.rows.some((r) => r.holdKey.startsWith("lead_reply:"))).toBe(false);
    });

    it("flag on, SMS capped: the row stays pending and is drained once the cap frees", async () => {
      const t = setup({ messages: [amb("m1")], contacts: [contact] });
      let capped = true;
      const real = t.store.claimWithCap.bind(t.store);
      t.store.claimWithCap = async (row, cap) => (cap.channel === "sms" && capped ? "capped" : real(row, cap));
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent.map((s) => s.channel)).toEqual(["slack"]);
      t.setNow("2026-11-09T14:00:00.000Z"); // past the lookback
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent).toHaveLength(1);
      capped = false;
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent.map((s) => s.channel)).toEqual(["slack", "sms"]);
    });

    it("flag on: a failed SMS is retried up to MAX_ATTEMPTS, then stops", async () => {
      const t = setup({ messages: [amb("m1")], contacts: [contact] });
      t.results.sms = { status: "failed", error: "provider 500" };
      for (let i = 0; i < 5; i += 1) {
        t.setNow(new Date(Date.parse(NOW) + i * 3_600_000).toISOString());
        await runHoldAlertsForOrg(t.deps, ORG);
      }
      expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(3);
      expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    });

    it("rollback (flag off after rows exist): no ambiguous sends; the lead-reply path behaves exactly as before the feature", async () => {
      const t = setup({ messages: [resolvedLeadMsg()], properties: [leadProp], contacts: [contact] }, { flag: false });
      await seedPartial(t.store);
      await runHoldAlertsForOrg(t.deps, ORG);
      // The pending ambiguous SMS is inert; today's lead-reply alert runs unchanged.
      expect(t.store.rows.filter((r) => r.holdKey === ambiguousThreadKey("m1")).map((r) => r.status).sort()).toEqual(["failed", "sent"]);
      expect(t.sent.map((s) => s.channel)).toEqual(["slack", "sms"]);
      expect(t.sent[0]!.text).toContain("New text on your lead: Testa");
    });
  });

  describe("MAJOR c: the deduplicated selection drives the tasks, hot first", () => {
    it("hot and ambiguous loaders return the same key: one pair, hot wording", async () => {
      const hot: HotPromotion = { propertyId: "p1", assigneeUserId: OWNER.userId, name: "Dana", assignedAt: AT, kind: "hot_text", key: ambiguousThreadKey("m1") };
      const t = setup({ messages: [amb("m1")], contacts: [contact] }, { extra: { promotions: [hot] } });
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent).toHaveLength(2);
      expect(t.sent.every((s) => s.text.startsWith("Hot text on your lead: Dana"))).toBe(true);
      expect(t.store.rows).toHaveLength(2);
    });

    it("a hot_text alert on the same inbound this pass wins over the ambiguous alert", async () => {
      const hot: HotPromotion = { propertyId: "p1", assigneeUserId: OWNER.userId, name: "Dana", assignedAt: AT, kind: "hot_text", key: hotTextKey("m1") };
      const t = setup({ messages: [amb("m1")], contacts: [contact] }, { extra: { promotions: [hot] } });
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.store.rows.map((r) => r.holdKey)).toEqual([hotTextKey("m1"), hotTextKey("m1")]);
    });

    it("a lead reply for the same inbound this pass wins over the ambiguous alert", async () => {
      const lead: HotPromotion = { propertyId: "p1", assigneeUserId: "", name: "Testa", assignedAt: AT, kind: "lead_reply", key: leadReplyKey("m1"), inboundId: "m1" };
      const t = setup({ messages: [amb("m1")], contacts: [contact] }, { extra: { loadLeadReplies: async () => ({ promotions: [lead], complete: true }) } });
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.store.rows.map((r) => r.holdKey)).toEqual([leadReplyKey("m1"), leadReplyKey("m1")]);
    });

    it("two loaders returning one ambiguous key twice: one pair", async () => {
      const t = setup({ messages: [amb("m1")], contacts: [contact] });
      const load = t.deps.loadAmbiguousThreadAlerts!;
      t.deps.loadAmbiguousThreadAlerts = async (o, s) => {
        const r = await load(o, s);
        return { ...r, promotions: [...r.promotions, ...r.promotions] };
      };
      await runHoldAlertsForOrg(t.deps, ORG);
      expect(t.sent).toHaveLength(2);
    });
  });

  it("several owners (hot owner unknown): nothing sent, surfaced", async () => {
    const t = setup({ messages: [amb("m1")], contacts: [contact] }, { extra: { hotOwner: null } });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(summary.hotOwnerUnknown).toBe(true);
  });
});

describe("createHoldAlertDeps flag", () => {
  const admin = {} as never;
  it("defines the ambiguous loader only when HOLD_ALERT_AMBIGUOUS_THREAD_ENABLED=1", () => {
    expect(createHoldAlertDeps(admin, { NEXT_PUBLIC_APP_URL: "https://sandra.example.test" }).loadAmbiguousThreadAlerts).toBeUndefined();
    expect(typeof createHoldAlertDeps(admin, { NEXT_PUBLIC_APP_URL: "https://sandra.example.test", HOLD_ALERT_AMBIGUOUS_THREAD_ENABLED: "1" }).loadAmbiguousThreadAlerts).toBe("function");
  });
});
