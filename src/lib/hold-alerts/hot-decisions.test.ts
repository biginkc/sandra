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
const promotion: HotPromotion = { propertyId: "prop-9", assigneeUserId: OWNER.userId, name: "Pat", assignedAt: "2026-10-15T11:30:00.000Z", key: "hot_handoff:in-9" };

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
    // One alert key per hot event (the flag time), no property id (never archived).
    expect(t.store.rows.map((r) => [r.channel, r.stage, r.status, r.holdKey, r.propertyId])).toEqual([
      ["slack", "first", "sent", "hot_flag:prop-1:2026-10-15T11:00:00.000Z", null],
      ["sms", "first", "sent", "hot_flag:prop-1:2026-10-15T11:00:00.000Z", null],
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
    expect(t.store.rows.every((r) => r.propertyId === null && r.holdKey === "hot_handoff:in-9")).toBe(true);
  });

  it("(3b) a promotion recorded for a non-owner still goes to the hot owner only", async () => {
    const t = setup({ holds: [], promotions: [{ ...promotion, assigneeUserId: ACQ.userId }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.userId])).toEqual([["slack", "owner-1"], ["sms", "owner-1"]]);
  });

  it("(4) the SMS cap (500/hr) and DM cap (500/hr) runaway guards hold: excess stays pending and goes out the next hour", async () => {
    const holds = Array.from({ length: MAX_SMS_PER_HOUR + 2 }, (_, i) => hold({ hot: true, holdKey: `p${i}:hot_lead`, propertyId: `p${i}`, startedAt: "2026-10-15T11:00:00.000Z" }));
    const t = setup({ holds });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(MAX_SMS_PER_HOUR).toBe(500);
    expect(by(t, "sms")).toHaveLength(MAX_SMS_PER_HOUR);
    expect(by(t, "slack")).toHaveLength(MAX_DMS_PER_RECIPIENT_PER_HOUR);
    expect(t.store.rows.filter((r) => r.channel === "sms" && r.status === "pending")).toHaveLength(2);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(by(t, "sms")).toHaveLength(MAX_SMS_PER_HOUR);

    t.setNow("2026-10-15T13:05:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(by(t, "sms")).toHaveLength(MAX_SMS_PER_HOUR + 2);
    expect(t.store.rows.filter((r) => r.status === "pending")).toEqual([]);

    const dm = setup({ holds: Array.from({ length: MAX_DMS_PER_RECIPIENT_PER_HOUR + 2 }, (_, i) => hold({ hot: true, holdKey: `d${i}:hot_lead`, propertyId: `d${i}`, startedAt: "2026-10-15T11:00:00.000Z" })) });
    seedSent(dm, "sms", 0, OWNER.userId, NOW);
    await runHoldAlertsForOrg(dm.deps, ORG);
    expect(MAX_DMS_PER_RECIPIENT_PER_HOUR).toBe(500);
    expect(by(dm, "slack")).toHaveLength(MAX_DMS_PER_RECIPIENT_PER_HOUR);
    dm.setNow("2026-10-15T13:05:00.000Z");
    await runHoldAlertsForOrg(dm.deps, ORG);
    expect(by(dm, "slack")).toHaveLength(MAX_DMS_PER_RECIPIENT_PER_HOUR + 2);
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
    const promoRows = () => t.store.rows.filter((r) => r.holdKey === "hot_handoff:in-9");
    expect(promoRows()).toHaveLength(2);

    // The hot hold clears: hot rows carry no property id, so nothing is archived (promotion or hold).
    t.deps.loadHolds = async () => ({ holds: [], complete: true });
    t.setNow("2026-10-15T12:30:00.000Z");
    const s = await runHoldAlertsForOrg(t.deps, ORG);
    expect(s.archived).toBe(0);
    expect(t.store.rows.some((r) => r.holdKey.includes(":closed:"))).toBe(false);
    expect(promoRows()).toHaveLength(2);
    expect(promoRows().every((r) => !r.holdKey.includes(":closed:") && r.status === "sent")).toBe(true);

    // The hold set changes again: nothing new goes out for the promotion.
    const before = t.sent.length;
    t.deps.loadHolds = async () => ({ holds: [coldHold], complete: true });
    t.setNow("2026-10-15T14:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(before);
  });

  it("(7) messages carry only the first name and a link: no seller text or address, even when the data passed in contains them", async () => {
    const ADDRESS = "12 Oak St";
    // Seller text and address sit on fields adjacent to the ones alerts may read (as a loader that over-fetches would hand them over).
    const dirtyHold = { ...hotHold, body: SECRET, lastInboundText: SECRET, address: ADDRESS, propertyAddress: ADDRESS } as typeof hotHold;
    const dirtyPromotion = { ...promotion, body: SECRET, lastInboundText: SECRET, address: ADDRESS } as HotPromotion;
    const t = setup({ holds: [dirtyHold], promotions: [dirtyPromotion], emailEnabled: true });
    // Guard: the fixture handed to the deps really does contain the strings that must not leak.
    const fed = JSON.stringify([(await t.deps.loadHolds(ORG, MARK)).holds, (await t.deps.loadHotPromotions(ORG, MARK)).promotions]);
    expect(fed).toContain(SECRET);
    expect(fed).toContain(ADDRESS);

    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel !== "email")).toHaveLength(4);
    expect(t.sent.some((s) => s.channel === "email")).toBe(true);
    for (const s of t.sent) {
      expect(s.text).not.toContain(SECRET);
      expect(s.text).not.toContain("call me about");
      expect(s.text).not.toContain("Oak St");
      expect(s.text).toMatch(/https:\/\/app\.example\.com\/leads\/prop-(1|9)/);
      if (s.channel !== "email") {
        expect(s.text.match(/https?:\/\//g)).toHaveLength(1);
        expect(s.text).toMatch(/Dana|Pat/);
      }
    }
  });

  it("(8) a hot hold and a hand-off are separate events: each its own key, one Slack and one SMS each", async () => {
    const t = setup({ holds: [hotHold], promotions: [{ ...promotion, propertyId: "prop-1" }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(by(t, "slack")).toHaveLength(2);
    expect(by(t, "sms")).toHaveLength(2);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set(["hot_handoff:in-9", "hot_flag:prop-1:2026-10-15T11:00:00.000Z"]));
  });

  it("(9) two overlapping passes never push SMS past the cap in the hour", async () => {
    const holds = [0, 1, 2].map((i) => hold({ hot: true, holdKey: `c${i}:hot_lead`, propertyId: `c${i}`, startedAt: "2026-10-15T11:00:00.000Z" }));
    const t = setup({ holds });
    seedSent(t, "sms", MAX_SMS_PER_HOUR - 1, OWNER.userId, "2026-10-15T11:45:00.000Z");
    // Force the race: both passes reach claimWithCap before either finishes it, and they go for different rows.
    // claimWithCap is the atomic count+claim, so the second one in must see the first's 'sending' row.
    const realClaim = t.store.claimWithCap.bind(t.store);
    let waiting = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let capped = 0;
    t.store.claimWithCap = async (row, cap) => {
      if (row.channel === "sms" && waiting < 2) {
        waiting += 1;
        if (waiting === 2) open();
        await gate;
      }
      const result = await realClaim(row, cap);
      if (result === "capped") capped += 1;
      return result;
    };
    const reversed = { ...t.deps, loadHolds: async () => ({ holds: [...holds].reverse(), complete: true }) };
    await Promise.all([runHoldAlertsForOrg(t.deps, ORG), runHoldAlertsForOrg(reversed, ORG)]);
    expect(capped).toBeGreaterThan(0); // the atomic claim really refused the over-cap row
    const inHour = t.store.rows.filter((r) => r.channel === "sms" && (r.status === "sent" || r.status === "sending"));
    expect(inHour.length).toBeLessThanOrEqual(MAX_SMS_PER_HOUR);
    expect(by(t, "sms").length).toBeLessThanOrEqual(1);
    // The over-cap rows stayed pending, not lost: next hour they go out, once each.
    t.setNow("2026-10-15T13:30:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(by(t, "sms")).toHaveLength(3);
  });

  it("(10) the first pass for a brand-new org (no watermark) alerts a post-cutoff hot hold", async () => {
    const t = setup({ holds: [hotHold], noWatermark: true });
    t.store.watermarks.delete(ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => [s.channel, s.userId])).toEqual([["slack", "owner-1"], ["sms", "owner-1"]]);
  });
});
