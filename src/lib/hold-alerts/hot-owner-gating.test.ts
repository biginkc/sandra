import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportError } from "@/lib/errors/report";

import { HOT_ALERTS_START_ISO, runHoldAlertsForOrg } from "./core";
import { hold, makeDeps, ORG, OWNER } from "./test-support";
import type { HotPromotion } from "./types";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = "2026-10-15T12:00:00.000Z";
const MARK = "2026-10-15T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const promotion: HotPromotion = { propertyId: "prop-9", assigneeUserId: OWNER.userId, name: "Pat", assignedAt: "2026-10-15T11:30:00.000Z", kind: "handoff", key: "hot_handoff:in-9" };
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

  it("a rep owns it at send time: both rows skipped 'owned_by_someone_else' (final), nothing sent, and a later pass sends nothing", async () => {
    const asked: Array<[string, string]> = [];
    const t = setup({
      promotions: [promotion],
      loadPropertyAssignee: async (org, property) => {
        asked.push([org, property]);
        return "rep-1";
      },
    });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(summary.skipped).toBe(2);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.lastError])).toEqual([
      ["slack", "skipped", "owned_by_someone_else"],
      ["sms", "skipped", "owned_by_someone_else"],
    ]);
    expect(asked[0]).toEqual([ORG, "prop-9"]);
    t.setNow("2026-10-15T14:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
  });

  it("loadPropertyAssignee throws: both rows failed but retryable (not terminal), nothing sent, delivered on a later pass", async () => {
    let broken = true;
    const t = setup({
      promotions: [promotion],
      loadPropertyAssignee: async () => {
        if (broken) throw new Error("re-check down");
        return OWNER.userId;
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
      loadPropertyAssignee: async () => (order.push("recheck"), OWNER.userId),
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
  it("a brand-new org initialises at the cutoff (no 24h clamp): a post-cutoff hot hold older than 24h still alerts on the first pass", async () => {
    const now = "2026-10-20T12:00:00.000Z";
    const t = setup({
      nowIso: now,
      noWatermark: true,
      promotions: [
        { ...promotion, propertyId: "old", key: "hot_promotion:old", assignedAt: "2026-10-18T12:00:00.000Z" }, // 48h old, after cutoff
        { ...promotion, propertyId: "new", key: "hot_promotion:new", assignedAt: "2026-10-20T00:00:00.000Z" }, // 12h old
        { ...promotion, propertyId: "pre", key: "hot_promotion:pre", assignedAt: "2026-10-14T12:00:00.000Z" }, // before cutoff: silent
      ],
    });
    t.store.watermarks.delete(ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.watermarks.get(ORG)).toBe(HOT_ALERTS_START_ISO);
    expect([...new Set(t.store.rows.map((r) => r.holdKey))].sort()).toEqual(["hot_promotion:new", "hot_promotion:old"]);
    expect(chans(t)).toHaveLength(4);
  });

  it("shortly after the cutoff the watermark is the cutoff itself", async () => {
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

describe("one alert per hot event", () => {
  const hotHold = (flagAt: string | null, over: Record<string, unknown> = {}) => hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z", flagAt, ...over } as never);

  it("a hand-off and a hold are separate events with their own keys: each one Slack + one SMS", async () => {
    const t = setup({ promotions: [{ ...promotion, key: "hot_handoff:in-1" }], holds: [hotHold("2026-10-15T11:00:00.000Z")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(2);
    expect([...new Set(t.store.rows.map((r) => r.holdKey))].sort()).toEqual(["hot_flag:prop-1:2026-10-15T11:00:00.000Z", "hot_handoff:in-1"]);
  });

  it("two different hot texts on one property alert twice", async () => {
    const t = setup({ promotions: [{ ...promotion, key: "hot_text:in-1" }, { ...promotion, key: "hot_text:in-2" }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(2);
  });

  it("a hot hold is keyed by its own flag time: a re-flag (new flagAt) alerts again, the same flag never twice", async () => {
    const t = setup({ holds: [hotHold("2026-10-15T11:00:00.000Z")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    t.deps.loadHolds = async () => ({ holds: [hotHold("2026-10-15T11:30:00.000Z")], complete: true });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(2);
  });

  it("a promotion whose lead was unassigned since: skipped not_assigned (final), nothing sent, never retried", async () => {
    let assignee: string | null = null;
    const t = setup({ promotions: [promotion], loadPropertyAssignee: async () => assignee });
    const first = await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows.map((r) => [r.status, r.lastError])).toEqual([["skipped", "not_assigned"], ["skipped", "not_assigned"]]);
    expect(first.failed).toBe(0);
    assignee = OWNER.userId;
    t.setNow("2026-10-15T12:05:00.000Z");
    expect((await runHoldAlertsForOrg(t.deps, ORG)).sent).toBe(0);
  });

  it("a hot HOLD on a rep-owned property is skipped owned_by_someone_else: nothing sent", async () => {
    const t = setup({ holds: [hotHold("2026-10-15T11:00:00.000Z")], loadPropertyAssignee: async () => "rep-1" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows.map((r) => [r.status, r.lastError])).toEqual([["skipped", "owned_by_someone_else"], ["skipped", "owned_by_someone_else"]]);
  });
});

describe("design B hot holds and failed hand-offs", () => {
  const failedPromo: HotPromotion = { propertyId: "prop-1", assigneeUserId: "", name: "Pat", assignedAt: "2026-10-15T11:30:00.000Z", kind: "hot_failed", reason: "hot_lead_assign_failed", key: "hot_failed:in-1" };
  const keys = (t: ReturnType<typeof setup>) => [...new Set(t.store.rows.map((r) => r.holdKey))].sort();

  it("a failed hand-off alerts the resolved hot owner (no assignee), one Slack + one SMS", async () => {
    const t = setup({ promotions: [failedPromo], loadPropertyAssignee: async () => null });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t).map((s) => s.channel).sort()).toEqual(["slack", "sms"]);
    expect(keys(t)).toEqual(["hot_failed:in-1"]);
  });

  it("a failed hand-off on a rep-owned lead is skipped owned_by_someone_else", async () => {
    const t = setup({ promotions: [failedPromo], loadPropertyAssignee: async () => "rep-1" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(t.store.rows.map((r) => r.lastError)).toEqual(["owned_by_someone_else", "owned_by_someone_else"]);
  });

  it("a hot hold whose reason is a failure reason is NOT alerted via the hold path", async () => {
    const t = setup({ holds: [hold({ hot: true, reasonKey: "hot_lead_assign_failed", flagHot: true, flagAt: "2026-10-15T11:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(keys(t)).toEqual([]);
  });

  it("flag-hot hold: key hot_flag:<property>:<flagAt>, cutoff on flagAt (a pre-cutoff flag is silent even if the hold started later)", async () => {
    const fresh = setup({ holds: [hold({ hot: true, flagHot: true, flagAt: "2026-10-15T11:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })] });
    await runHoldAlertsForOrg(fresh.deps, ORG);
    expect(keys(fresh)).toEqual(["hot_flag:prop-1:2026-10-15T11:00:00.000Z"]);
    const old = setup({ holds: [hold({ hot: true, flagHot: true, flagAt: "2026-10-14T11:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })] });
    await runHoldAlertsForOrg(old.deps, ORG);
    expect(chans(old)).toEqual([]);
  });

  it("run-hot hold (flag not hot): key hot_text:<run inbound>, cutoff on the run start", async () => {
    const mk = (runStartedAt: string) => hold({ hot: true, flagHot: false, runHot: true, runInbound: "in-7", runStartedAt, flagAt: "2026-10-14T00:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" });
    const fresh = setup({ holds: [mk("2026-10-15T11:00:00.000Z")] });
    await runHoldAlertsForOrg(fresh.deps, ORG);
    expect(keys(fresh)).toEqual(["hot_text:in-7"]);
    const old = setup({ holds: [mk("2026-10-14T11:00:00.000Z")] });
    await runHoldAlertsForOrg(old.deps, ORG);
    expect(chans(old)).toEqual([]);
  });

  it("a hot hold with no verifiable hot time fails closed: not alerted, reported", async () => {
    const t = setup({ holds: [hold({ hot: true, flagHot: true, flagAt: null, startedAt: "2026-10-15T11:00:00.000Z" }), hold({ hot: true, flagHot: false, runHot: false, startedAt: "2026-10-15T11:00:00.000Z", holdKey: "prop-2:x", propertyId: "prop-2" })] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("without a verified hot time") }), expect.anything());
  });
});
