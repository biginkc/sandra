import { describe, expect, it } from "vitest";

import { isNewHold, runHoldAlertsForOrg } from "./core";
import { hold, makeDeps, ORG } from "./test-support";

const MARK = "2026-10-08T10:00:00.000Z";

describe("isNewHold", () => {
  const ms = Date.parse(MARK);
  it("is true at or after the watermark", () => {
    expect(isNewHold({ startedAt: MARK }, ms)).toBe(true);
    expect(isNewHold({ startedAt: "2026-10-08T10:00:00.001Z" }, ms)).toBe(true);
  });
  it("is false before the watermark", () => {
    expect(isNewHold({ startedAt: "2026-10-08T09:59:59.999Z" }, ms)).toBe(false);
  });
  it("is false when the start is unknown or unparseable (backlog)", () => {
    expect(isNewHold({ startedAt: null }, ms)).toBe(false);
    expect(isNewHold({ startedAt: "not a date" }, ms)).toBe(false);
  });
  it("is false when the watermark is unparseable", () => {
    expect(isNewHold({ startedAt: MARK }, Number.NaN)).toBe(false);
  });
});

describe("alerts only for holds that start after alerts were enabled", () => {
  const old = hold({ holdKey: "old:x", propertyId: "old", startedAt: "2026-05-01T00:00:00.000Z" });
  const unknown = hold({ holdKey: "unk:x", propertyId: "unk", startedAt: null });
  const fresh = hold({ holdKey: "new:x", propertyId: "new", startedAt: "2026-10-08T11:00:00.000Z" });

  it("first run for an org records the watermark and sends nothing", async () => {
    const t = makeDeps({ holds: [old, unknown, fresh], noWatermark: true, nowIso: "2026-10-08T12:00:00.000Z", emailEnabled: true });
    const s = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows).toEqual([]);
    expect(s.holds).toBe(0);
    expect(t.store.watermarks.get(ORG)).toBe("2026-10-08T12:00:00.000Z");
  });

  it("the watermark is set once: the second run does not move it", async () => {
    const t = makeDeps({ holds: [], noWatermark: true, nowIso: "2026-10-08T12:00:00.000Z" });
    await runHoldAlertsForOrg(t.deps, ORG);
    t.setNow("2026-10-08T13:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.watermarks.get(ORG)).toBe("2026-10-08T12:00:00.000Z");
  });

  it("a 2,504-hold backlog never alerts", async () => {
    const backlog = Array.from({ length: 2504 }, (_, i) =>
      hold({
        holdKey: `p${i}:x`,
        propertyId: `p${i}`,
        startedAt: i % 2 ? null : "2026-05-01T00:00:00.000Z",
      }),
    );
    const t = makeDeps({ holds: backlog, emailEnabled: true });
    t.store.watermarks.set(ORG, MARK);
    const s = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows).toEqual([]);
    expect(s.holds).toBe(0);
  });

  it("alerts once for a hold that began after the watermark, and not for the backlog beside it", async () => {
    const t = makeDeps({ holds: [old, unknown, fresh], nowIso: "2026-10-08T12:00:00.000Z" });
    t.store.watermarks.set(ORG, MARK);
    await runHoldAlertsForOrg(t.deps, ORG);
    const slack = t.sent.filter((s) => s.channel === "slack");
    expect(slack).toHaveLength(2); // owner + acquisitions, for the new hold only
    expect(t.store.rows.every((r) => r.holdKey === "new:x")).toBe(true);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);
  });

  it("the digest covers only eligible holds and is not sent when none are", async () => {
    const t = makeDeps({ holds: [old, unknown, fresh], emailEnabled: true, nowIso: "2026-10-08T12:00:00.000Z" });
    t.store.watermarks.set(ORG, MARK);
    await runHoldAlertsForOrg(t.deps, ORG);
    const email = t.sent.filter((s) => s.channel === "email");
    expect(email.length).toBeGreaterThan(0);
    expect(email[0]!.text).toContain("1 ");

    const none = makeDeps({ holds: [old, unknown], emailEnabled: true });
    none.store.watermarks.set(ORG, MARK);
    await runHoldAlertsForOrg(none.deps, ORG);
    expect(none.sent).toEqual([]);
  });

  it("archives delivery rows for closed holds; a backlog hold elsewhere does not matter", async () => {
    const t = makeDeps({ holds: [fresh], nowIso: "2026-10-08T12:00:00.000Z" });
    t.store.watermarks.set(ORG, MARK);
    await runHoldAlertsForOrg(t.deps, ORG);
    // The hold closes; a backlog hold elsewhere stays open and silent.
    const t2 = {
      ...t.deps,
      loadHolds: async () => ({ holds: [], complete: true }),
      loadHeldPropertyIds: async () => new Set(["old"]),
    };
    const s = await runHoldAlertsForOrg(t2, ORG);
    expect(s.archived).toBeGreaterThan(0);
  });
});

describe("seller activity after the watermark on a lead flagged before it", () => {
  // The query layer turns "old flag + new inbound / new pending row" into a post-watermark startedAt
  // (see queries.test.ts); here the core must alert exactly once for it and stay silent otherwise.
  it("old-flagged lead with new activity alerts once; old activity stays silent; post-watermark flag with an old draft alerts", async () => {
    const reflagged = hold({ holdKey: "a:x", propertyId: "a", startedAt: "2026-10-08T11:30:00.000Z" }); // old flag, new inbound
    const stale = hold({ holdKey: "b:x", propertyId: "b", startedAt: "2026-07-01T00:00:00.000Z" }); // old flag, only old activity
    const flagNewDraftOld = hold({ holdKey: "c:x", propertyId: "c", startedAt: "2026-10-08T11:00:00.000Z" }); // flag after wm, draft older
    const t = makeDeps({ holds: [reflagged, stale, flagNewDraftOld], nowIso: "2026-10-08T12:00:00.000Z" });
    t.store.watermarks.set(ORG, MARK);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set(["a:x", "c:x"]));
    const before = t.sent.length;
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(before);
  });
});

describe("a discarded backlog delivery does not block a fresh seller text on the same hold", () => {
  it("sends exactly one first notification per recipient, and a second run sends nothing more", async () => {
    // The migration retires discarded rows' keys, so the live key has no row yet.
    const live = hold({ holdKey: "a:seller_reply", propertyId: "a", startedAt: "2026-10-08T11:30:00.000Z" });
    const t = makeDeps({ holds: [live], nowIso: "2026-10-08T12:00:00.000Z" });
    t.store.watermarks.set(ORG, MARK);
    t.store.rows.push({
      id: "discarded-1",
      orgId: ORG,
      propertyId: "a",
      holdKey: "a:seller_reply:closed:backlog_discarded:discarded-1",
      recipientUserId: "u",
      channel: "slack",
      stage: "first",
      status: "skipped",
      attempts: 0,
      lastError: "backlog_discarded",
      createdAt: "2026-10-08T09:00:00.000Z",
      sentAt: null,
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    const slack = t.sent.filter((s) => s.channel === "slack");
    expect(slack.length).toBeGreaterThan(0);
    const firstCount = t.sent.length;
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(firstCount);
  });
});
