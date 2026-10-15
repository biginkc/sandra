import { describe, expect, it } from "vitest";

import { MAX_DMS_PER_RECIPIENT_PER_HOUR, MAX_SMS_PER_HOUR, runHoldAlertsForOrg } from "./core";
import { ACQ, hold, makeDeps, ORG, OWNER } from "./test-support";
import type { HotPromotion } from "./types";

// Frozen fixture: fixed clock, fixed watermark, two recipients (owner + acquisitions member).
const NOW = "2026-10-15T12:00:00.000Z";
const MARK = "2026-10-15T00:00:00.000Z";
const SECRET = "SELLER SAID: call me about 12 Oak St";

const hotHold = hold({ hot: true, holdKey: "prop-1:hot_lead", propertyId: "prop-1", startedAt: "2026-10-15T11:00:00.000Z", reasonLabel: "hot lead" });
const coldHold = hold({ hot: false, holdKey: "prop-2:draft_held", propertyId: "prop-2", startedAt: "2026-10-15T11:00:00.000Z", reasonLabel: "draft held for review" });
const promotion: HotPromotion = { propertyId: "prop-9", assigneeUserId: OWNER.userId, name: "Pat", assignedAt: "2026-10-15T11:30:00.000Z" };

function setup(over: Parameters<typeof makeDeps>[0] = {}) {
  const t = makeDeps({ nowIso: NOW, recipients: [OWNER, ACQ], ...over });
  t.store.watermarks.set(ORG, MARK);
  return t;
}
const by = (t: ReturnType<typeof setup>, channel: "slack" | "sms") => t.sent.filter((s) => s.channel === channel);
const seedSent = (t: ReturnType<typeof setup>, channel: "slack" | "sms", n: number, user: string, sentAt: string) => {
  for (let i = 0; i < n; i++) {
    t.store.rows.push({
      id: `seed-${channel}-${i}`, orgId: ORG, propertyId: `seed-${i}`, holdKey: `seed-${i}:x`, recipientUserId: user, channel,
      stage: "first", status: "sent", attempts: 1, lastError: null, createdAt: sentAt, sentAt,
    });
  }
};

describe("hot decisions (frozen fixture)", () => {
  it("(1) a hot hold sends exactly one Slack DM and one SMS, both to the owner", async () => {
    const t = setup({ holds: [hotHold] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.userId])).toEqual([["slack", "owner-1"], ["sms", "owner-1"]]);
    expect(t.store.rows.map((r) => [r.channel, r.stage, r.status, r.holdKey])).toEqual([
      ["slack", "first", "sent", "prop-1:hot_lead"],
      ["sms", "first", "sent", "prop-1:hot_lead"],
    ]);
  });

  it("(2b) a hot hold that started before the 2026-10-15 cutoff sends nothing", async () => {
    const t = setup({ holds: [hold({ hot: true, startedAt: "2026-10-14T23:00:00.000Z" })], promotions: [{ ...promotion, assignedAt: "2026-10-14T23:00:00.000Z" }] });
    t.store.watermarks.set(ORG, "2026-10-01T00:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
  });

  it("(2) a non-hot hold sends nothing", async () => {
    const t = setup({ holds: [coldHold] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });

  it("(3) a hot promotion sends one Slack and one SMS to the assignee, with propertyId null", async () => {
    const t = setup({ holds: [], promotions: [promotion] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.userId])).toEqual([["slack", "owner-1"], ["sms", "owner-1"]]);
    expect(t.store.rows.every((r) => r.propertyId === null && r.holdKey === "hot_promotion:prop-9")).toBe(true);
  });

  it("(3b) a promotion whose assignee is not an owner recipient sends nothing", async () => {
    const t = setup({ holds: [], promotions: [{ ...promotion, assigneeUserId: ACQ.userId }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
  });

  it("(4) the SMS cap (10/hr) and DM cap (20/hr) hold: excess stays pending and goes out the next hour", async () => {
    const holds = Array.from({ length: 12 }, (_, i) => hold({ hot: true, holdKey: `p${i}:hot_lead`, propertyId: `p${i}`, startedAt: "2026-10-15T11:00:00.000Z" }));
    const t = setup({ holds });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(MAX_SMS_PER_HOUR).toBe(10);
    expect(by(t, "sms")).toHaveLength(10);
    expect(by(t, "slack")).toHaveLength(12);
    expect(t.store.rows.filter((r) => r.channel === "sms" && r.status === "pending")).toHaveLength(2);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(by(t, "sms")).toHaveLength(10);

    t.setNow("2026-10-15T13:05:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(by(t, "sms")).toHaveLength(12);
    expect(t.store.rows.filter((r) => r.status === "pending")).toEqual([]);

    const dm = setup({ holds: Array.from({ length: 22 }, (_, i) => hold({ hot: true, holdKey: `d${i}:hot_lead`, propertyId: `d${i}`, startedAt: "2026-10-15T11:00:00.000Z" })) });
    seedSent(dm, "sms", 0, OWNER.userId, NOW);
    await runHoldAlertsForOrg(dm.deps, ORG);
    expect(MAX_DMS_PER_RECIPIENT_PER_HOUR).toBe(20);
    expect(by(dm, "slack")).toHaveLength(20);
    dm.setNow("2026-10-15T13:05:00.000Z");
    await runHoldAlertsForOrg(dm.deps, ORG);
    expect(by(dm, "slack")).toHaveLength(22);
  });

  it("(5) re-running the pass never duplicates a send, also after a failed-then-retried send", async () => {
    const t = setup({ holds: [hotHold], promotions: [promotion] });
    await runHoldAlertsForOrg(t.deps, ORG);
    const n = t.sent.length;
    expect(n).toBe(4);
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(n);

    const r = setup({ holds: [hotHold] });
    r.results.slack = { status: "failed", error: "blip" };
    await runHoldAlertsForOrg(r.deps, ORG);
    r.results.slack = { status: "sent" };
    await runHoldAlertsForOrg(r.deps, ORG);
    await runHoldAlertsForOrg(r.deps, ORG);
    expect(r.sent.filter((s) => s.channel === "slack")).toHaveLength(2); // the failed attempt + one successful retry
    expect(r.store.rows.filter((x) => x.channel === "slack").map((x) => x.status)).toEqual(["sent"]);
    expect(by(r, "sms")).toHaveLength(1);
  });

  it("(6) promotion rows survive archive-on-clear: a changed hold set never re-sends them", async () => {
    const t = setup({ holds: [hotHold], promotions: [promotion] });
    await runHoldAlertsForOrg(t.deps, ORG);
    const promoRows = () => t.store.rows.filter((r) => r.holdKey === "hot_promotion:prop-9");
    expect(promoRows()).toHaveLength(2);

    // The hot hold clears: its rows are archived, the promotion rows are not.
    t.deps.loadHolds = async () => ({ holds: [], complete: true });
    t.setNow("2026-10-15T12:30:00.000Z");
    const s = await runHoldAlertsForOrg(t.deps, ORG);
    expect(s.archived).toBe(2);
    expect(promoRows()).toHaveLength(2);
    expect(promoRows().every((r) => !r.holdKey.includes(":closed:") && r.status === "sent")).toBe(true);

    // The hold set changes again: nothing new goes out for the promotion.
    const before = t.sent.length;
    t.deps.loadHolds = async () => ({ holds: [coldHold], complete: true });
    t.setNow("2026-10-15T14:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(before);
  });

  it("(7) messages carry only the first name and a link: no seller text or address", async () => {
    const t = setup({ holds: [hotHold], promotions: [promotion], emailEnabled: false });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(4);
    for (const s of t.sent) {
      expect(s.text).not.toContain(SECRET);
      expect(s.text).not.toContain("Oak St");
      expect(s.text.match(/https?:\/\//g)).toHaveLength(1);
      expect(s.text).toMatch(/https:\/\/app\.example\.com\/leads\/prop-(1|9)/);
      expect(s.text).toMatch(/Dana|Pat/);
    }
  });
});
