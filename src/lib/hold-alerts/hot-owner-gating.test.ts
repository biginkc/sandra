import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportError } from "@/lib/errors/report";

import { HOT_ALERTS_START_ISO, runHoldAlertsForOrg } from "./core";
import { hold, makeDeps, ORG, OWNER } from "./test-support";
import type { HotPromotion } from "./types";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = "2026-10-15T12:00:00.000Z";
const MARK = "2026-10-15T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const promotion: HotPromotion = { propertyId: "prop-9", assigneeUserId: OWNER.userId, name: "Pat", assignedAt: "2026-10-15T11:30:00.000Z", kind: "handoff", key: "hot_promotion:prop-9" };
const isOwnerUnknownReport = (c: unknown[]) => String((c[0] as Error)?.message ?? "").includes("couldn't tell who to alert");

function setup(over: Parameters<typeof makeDeps>[0] = {}) {
  const t = makeDeps({ nowIso: NOW, recipients: [OWNER], holds: [], ...over });
  if (!over.noWatermark) t.store.watermarks.set(ORG, MARK);
  return t;
}
const chans = (t: ReturnType<typeof setup>) => t.sent.filter((s) => s.channel !== "email");

beforeEach(() => vi.mocked(reportError).mockClear());

describe("promotions need the resolved hot owner, like holds", () => {
  it("an ambiguous owner (null) means zero promotion deliveries and hotOwnerUnknown", async () => {
    const t = setup({ hotOwner: null, promotions: [promotion] });
    const summary = await runHoldAlertsForOrg(t.deps, "org-ambiguous");
    expect(chans(t)).toEqual([]);
    expect(t.store.rows).toEqual([]);
    expect(summary.hotOwnerUnknown).toBe(true);
  });

  it("an owner lookup that throws means zero promotion deliveries, hotOwnerUnknown, no crash", async () => {
    const t = setup({
      promotions: [promotion],
      loadHotOwner: async () => {
        throw new Error("owner lookup down");
      },
    });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows).toEqual([]);
    expect(summary.hotOwnerUnknown).toBe(true);
    expect(reportError).toHaveBeenCalled();
  });

  it("a promotion assigned to someone other than the resolved owner sends nothing", async () => {
    const t = setup({ promotions: [{ ...promotion, assigneeUserId: "owner-2" }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });

  it("the owner changed before send (isPropertyAssignedTo false): both rows skipped 'no_longer_assigned', nothing sent, and a later pass sends nothing", async () => {
    const asked: Array<[string, string, string]> = [];
    const t = setup({
      promotions: [promotion],
      isPropertyAssignedTo: async (org, property, user) => {
        asked.push([org, property, user]);
        return false;
      },
    });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(summary.skipped).toBe(2);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.lastError])).toEqual([
      ["slack", "skipped", "no_longer_assigned"],
      ["sms", "skipped", "no_longer_assigned"],
    ]);
    expect(asked[0]).toEqual([ORG, "prop-9", OWNER.userId]);
    t.setNow("2026-10-15T14:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
  });

  it("isPropertyAssignedTo throws: both rows failed but retryable (not terminal), nothing sent, delivered on a later pass", async () => {
    let broken = true;
    const t = setup({
      promotions: [promotion],
      isPropertyAssignedTo: async () => {
        if (broken) throw new Error("re-check down");
        return true;
      },
    });
    const first = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(first.failed).toBe(2);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.attempts, r.lastError])).toEqual([
      ["slack", "failed", 1, "re-check down"],
      ["sms", "failed", 1, "re-check down"],
    ]);
    broken = false;
    t.setNow("2026-10-15T12:05:00.000Z");
    const second = await runHoldAlertsForOrg(t.deps, ORG);
    expect(second.sent).toBe(2);
    expect(t.sent.map((s) => s.channel)).toEqual(["slack", "sms"]);
    expect(t.store.rows.every((r) => r.status === "sent" && r.attempts === 2)).toBe(true);
    // And never again.
    t.setNow("2026-10-15T12:10:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toHaveLength(2);
  });

  it("the owner re-check runs before any provider call", async () => {
    const order: string[] = [];
    const t = setup({
      promotions: [promotion],
      isPropertyAssignedTo: async () => (order.push("recheck"), true),
      sendSlack: async () => (order.push("slack"), { status: "sent" }),
      sendSms: async () => (order.push("sms"), { status: "sent" }),
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(order).toEqual(["recheck", "slack", "recheck", "sms"]);
  });
});

describe("hot owner re-resolved immediately before each provider call", () => {
  // Call 1 is the pass's own selection; later calls are the pre-send re-checks.
  const afterFirst = (later: () => Promise<string | null>) => {
    let n = 0;
    return async () => (++n === 1 ? OWNER.userId : later());
  };

  it("owner changed between selection and send: nothing sent, rows skipped hot_owner_changed", async () => {
    const t = setup({ promotions: [promotion], loadHotOwner: afterFirst(async () => "owner-2") });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(summary.skipped).toBe(2);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.lastError])).toEqual([
      ["slack", "skipped", "hot_owner_changed"],
      ["sms", "skipped", "hot_owner_changed"],
    ]);
  });

  it("owner ambiguous at send time: nothing sent, rows skipped hot_owner_ambiguous", async () => {
    const t = setup({ promotions: [promotion], loadHotOwner: afterFirst(async () => null) });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.lastError])).toEqual([
      ["slack", "skipped", "hot_owner_ambiguous"],
      ["sms", "skipped", "hot_owner_ambiguous"],
    ]);
  });

  it("the same guard covers hot holds (not just promotions)", async () => {
    const t = setup({ holds: [hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z" })], loadHotOwner: afterFirst(async () => "owner-2") });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows.every((r) => r.status === "skipped" && r.lastError === "hot_owner_changed")).toBe(true);
  });

  it("re-check throws: retryable failed with nothing sent, then sent on the next pass", async () => {
    let broken = true;
    let n = 0;
    const t = setup({
      promotions: [promotion],
      loadHotOwner: async () => {
        n += 1;
        if (broken && n > 1) throw new Error("owner recheck down");
        return OWNER.userId;
      },
    });
    const first = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(first.failed).toBe(2);
    expect(t.store.rows.every((r) => r.status === "failed" && r.attempts === 1)).toBe(true);
    broken = false;
    t.setNow("2026-10-15T12:05:00.000Z");
    const second = await runHoldAlertsForOrg(t.deps, ORG);
    expect(second.sent).toBe(2);
    expect(t.sent.map((s) => s.channel)).toEqual(["slack", "sms"]);
  });
});

describe("cap re-check that throws", () => {
  it("puts the row back to pending (never left 'sending'), counts it deferred, and delivers it on a later pass", async () => {
    const t = setup({ holds: [hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z" })] });
    let calls = 0;
    const real = t.store.countSentSince.bind(t.store);
    t.store.countSentSince = async (q) => {
      calls += 1;
      // Call 1 = slack pre-claim check, call 2 = slack post-claim re-check.
      if (calls === 2) throw new Error("count down");
      return real(q);
    };
    const first = await runHoldAlertsForOrg(t.deps, ORG);
    const slackRow = t.store.rows.find((r) => r.channel === "slack")!;
    expect(slackRow.status).toBe("pending");
    expect(slackRow.attempts).toBe(0);
    expect(t.store.rows.some((r) => r.status === "sending")).toBe(false);
    expect(t.sent.filter((s) => s.channel === "slack")).toEqual([]);
    expect(first.deferred).toBe(1);
    expect(reportError).toHaveBeenCalled();
    // The text (separate row) is unaffected.
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(1);

    t.setNow("2026-10-15T12:05:00.000Z");
    const second = await runHoldAlertsForOrg(t.deps, ORG);
    expect(second.sent).toBe(1);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(1);
    expect(t.store.rows.every((r) => r.status === "sent")).toBe(true);
  });

  it("if the release itself also throws the pass still ends normally (best effort)", async () => {
    const t = setup({ holds: [hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z" })] });
    let calls = 0;
    const real = t.store.countSentSince.bind(t.store);
    t.store.countSentSince = async (q) => {
      calls += 1;
      if (calls === 2) throw new Error("count down");
      return real(q);
    };
    t.store.release = async () => {
      throw new Error("release down");
    };
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(summary.deferred).toBe(1);
    expect(t.sent.filter((s) => s.channel === "slack")).toEqual([]);
  });
});

describe("new-org watermark start", () => {
  it("a brand-new org starts at now - 24h when that is after the 2026-10-15 cutoff: older backlog is silent, newer hot sellers alert", async () => {
    const now = "2026-10-20T12:00:00.000Z";
    const t = setup({
      nowIso: now,
      noWatermark: true,
      promotions: [
        { ...promotion, propertyId: "old", key: "hot_promotion:old", assignedAt: "2026-10-18T12:00:00.000Z" }, // 48h old
        { ...promotion, propertyId: "old2", key: "hot_promotion:old2", assignedAt: "2026-10-19T11:00:00.000Z" }, // 25h old
        { ...promotion, propertyId: "new", key: "hot_promotion:new", assignedAt: "2026-10-20T00:00:00.000Z" }, // 12h old
      ],
    });
    t.store.watermarks.delete(ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.watermarks.get(ORG)).toBe("2026-10-19T12:00:00.000Z");
    expect([...new Set(t.store.rows.map((r) => r.holdKey))]).toEqual(["hot_promotion:new"]);
    expect(chans(t)).toHaveLength(2);
  });

  it("before the cutoff + 24h the watermark is the cutoff itself", async () => {
    const t = setup({ nowIso: "2026-10-15T12:00:00.000Z", noWatermark: true });
    t.store.watermarks.delete(ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.watermarks.get(ORG)).toBe(HOT_ALERTS_START_ISO);
  });

  it("never in the future: a clock before the cutoff starts at now", async () => {
    const t = setup({ nowIso: "2026-10-14T06:00:00.000Z", noWatermark: true });
    t.store.watermarks.delete(ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.watermarks.get(ORG)).toBe("2026-10-14T06:00:00.000Z");
  });

  it("an existing org's watermark is left alone", async () => {
    const t = setup({ nowIso: "2026-10-20T12:00:00.000Z" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.watermarks.get(ORG)).toBe(MARK);
  });
});

describe("owner-unknown report", () => {
  const unknownReports = () => vi.mocked(reportError).mock.calls.filter(isOwnerUnknownReport);

  it("is reported at most once per org per hour, however many passes run, and again in the next hour", async () => {
    const org = "org-report-once";
    const t = setup({ hotOwner: null, holds: [hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z" })], promotions: [promotion] });
    t.store.watermarks.set(org, MARK);
    t.setNow("2026-10-15T12:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      t.setNow(new Date(Date.parse("2026-10-15T12:05:00.000Z") + i * 10 * 60_000).toISOString()); // 12:05 .. 12:35
      const summary = await runHoldAlertsForOrg(t.deps, org);
      expect(summary.hotOwnerUnknown).toBe(true); // every pass says so in its summary
    }
    expect(unknownReports()).toHaveLength(1);

    // A different org in the same hour is reported on its own.
    const other = "org-report-other";
    t.store.watermarks.set(other, MARK);
    await runHoldAlertsForOrg(t.deps, other);
    expect(unknownReports()).toHaveLength(2);

    // The next hour reports again, once.
    t.setNow(new Date(Date.parse("2026-10-15T13:05:00.000Z")).toISOString());
    await runHoldAlertsForOrg(t.deps, org);
    await runHoldAlertsForOrg(t.deps, org);
    expect(unknownReports()).toHaveLength(3);
    expect(Date.parse("2026-10-15T13:05:00.000Z") - Date.parse("2026-10-15T12:05:00.000Z")).toBe(HOUR);
  });

  it("is not reported when there is nothing hot to alert about", async () => {
    const org = "org-report-quiet";
    const t = setup({ hotOwner: null, holds: [] });
    t.store.watermarks.set(org, MARK);
    const summary = await runHoldAlertsForOrg(t.deps, org);
    expect(summary.hotOwnerUnknown).toBe(false);
    expect(unknownReports()).toHaveLength(0);
  });
});
