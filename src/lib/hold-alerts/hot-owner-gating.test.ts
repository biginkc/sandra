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

  it("a promotion recorded for another user still alerts the resolved hot owner (Jarrad gets every hot alert)", async () => {
    const t = setup({ promotions: [{ ...promotion, assigneeUserId: "owner-2" }] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t).map((s) => [s.channel, s.userId])).toEqual([["slack", OWNER.userId], ["sms", OWNER.userId]]);
  });

  it("a rep owns the lead at send time: Jarrad is still alerted once, and a later pass sends nothing more", async () => {
    const t = setup({ promotions: [promotion] });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(summary.sent).toBe(2);
    expect(chans(t).map((s) => [s.channel, s.userId])).toEqual([["slack", OWNER.userId], ["sms", OWNER.userId]]);
    t.setNow("2026-10-15T14:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toHaveLength(2);
  });

  it("the owner re-check runs before any provider call", async () => {
    const order: string[] = [];
    const t = setup({
      promotions: [promotion],
      sendSlack: async () => (order.push("slack"), { status: "sent" }),
      sendSms: async () => (order.push("sms"), { status: "sent" }),
    });
    const owner = t.deps.loadHotOwner;
    t.deps.loadHotOwner = async (org) => (order.push("owner"), owner(org));
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(order).toEqual(["owner", "owner", "slack", "owner", "sms"]);
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

describe("claimWithCap that throws (replaces the old post-claim cap re-check tests)", () => {
  it("an atomic-claim error defers that row (pending, no attempt spent), the rest of the pass carries on, and the next pass delivers it", async () => {
    const t = setup({ holds: [hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z" })] });
    const real = t.store.claimWithCap.bind(t.store);
    let calls = 0;
    t.store.claimWithCap = async (row, cap) => {
      calls += 1;
      if (calls === 1) throw new Error("claim rpc down");
      return real(row, cap);
    };
    const first = await runHoldAlertsForOrg(t.deps, ORG);
    expect(first.deferred).toBe(1);
    expect(first.sent).toBe(1);
    const slackRow = t.store.rows.find((r) => r.channel === "slack")!;
    expect([slackRow.status, slackRow.attempts]).toEqual(["pending", 0]);
    expect(t.store.rows.some((r) => r.status === "sending")).toBe(false);
    expect(t.sent.map((x) => x.channel)).toEqual(["sms"]);

    t.setNow("2026-10-15T12:05:00.000Z");
    const second = await runHoldAlertsForOrg(t.deps, ORG);
    expect(second.sent).toBe(1);
    expect(t.store.rows.every((r) => r.status === "sent")).toBe(true);
  });

  it("a 'capped' answer defers the row (pending, no attempt spent) and 'lost' leaves it untouched, with no send", async () => {
    const t = setup({ holds: [hold({ hot: true, startedAt: "2026-10-15T11:00:00.000Z" })] });
    const answers: Array<"capped" | "lost"> = ["capped", "lost"];
    t.store.claimWithCap = async () => answers.shift() ?? "lost";
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(summary.deferred).toBe(1);
    expect(summary.untouched).toBe(1);
    expect(t.sent).toEqual([]);
    expect(t.store.rows.filter((r) => r.channel !== "email").every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
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

  it("a promotion whose lead is unassigned still alerts Jarrad once", async () => {
    const t = setup({ promotions: [promotion] });
    const first = await runHoldAlertsForOrg(t.deps, ORG);
    expect(first.sent).toBe(2);
    t.setNow("2026-10-15T12:05:00.000Z");
    expect((await runHoldAlertsForOrg(t.deps, ORG)).sent).toBe(0);
  });

  it("a hot HOLD on a rep-owned property still alerts Jarrad", async () => {
    const t = setup({ holds: [hotHold("2026-10-15T11:00:00.000Z")] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t).map((s) => [s.channel, s.userId])).toEqual([["slack", OWNER.userId], ["sms", OWNER.userId]]);
  });
});

describe("design B hot holds and failed hand-offs", () => {
  const failedPromo: HotPromotion = { propertyId: "prop-1", assigneeUserId: "", name: "Pat", assignedAt: "2026-10-15T11:30:00.000Z", kind: "hot_failed", reason: "hot_lead_assign_failed", key: "hot_failed:in-1" };
  const keys = (t: ReturnType<typeof setup>) => [...new Set(t.store.rows.map((r) => r.holdKey))].sort();

  it("a failed hand-off alerts the resolved hot owner (no assignee), one Slack + one SMS", async () => {
    const t = setup({ promotions: [failedPromo] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t).map((s) => s.channel).sort()).toEqual(["slack", "sms"]);
    expect(keys(t)).toEqual(["hot_failed:in-1"]);
  });

  it("a failed hand-off on a rep-owned lead still alerts Jarrad", async () => {
    const t = setup({ promotions: [failedPromo] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t).map((s) => s.channel).sort()).toEqual(["slack", "sms"]);
  });

  it("a failed hand-off whose FLAG is the failure is a normal hot flag hold: hot_flag:<property>:<flagAt>, even with a later run for another text", async () => {
    const t = setup({ holds: [hold({ hot: true, reasonKey: "hot_lead_assign_failed", flagHot: true, flagAt: "2026-10-15T11:00:00.000Z", runInbound: "in-later", runReason: "already_terminal", runStartedAt: "2026-10-15T11:30:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t).map((s) => s.channel)).toEqual(["slack", "sms"]);
    expect(keys(t)).toEqual(["hot_flag:prop-1:2026-10-15T11:00:00.000Z"]);
  });

  it("a failed hand-off known only by its RUN reason (flag not hot: the flag write no-oped) alerts under hot_failed:<run inbound>", async () => {
    const t = setup({ holds: [hold({ hot: true, flagHot: false, runHot: false, reasonKey: "jev_decision", runReason: "hot_lead_assign_failed", runInbound: "in-g", runStartedAt: "2026-10-15T11:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(keys(t)).toEqual(["hot_failed:in-g"]);
  });

  it("a failed hold and its own event (same hot_flag key) dedupe: one Slack + one SMS in total", async () => {
    const failedPromotion: HotPromotion = { propertyId: "prop-1", assigneeUserId: "", name: "Dana", assignedAt: "2026-10-15T11:00:00.000Z", kind: "hot_failed", key: "hot_flag:prop-1:2026-10-15T11:00:00.000Z", reason: "hot_lead_assign_failed" };
    const t = setup({
      promotions: [failedPromotion],
      holds: [hold({ hot: true, reasonKey: "hot_lead_assign_failed", flagHot: true, flagAt: "2026-10-15T11:00:00.000Z", runInbound: "in-f", runStartedAt: "2026-10-15T11:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toHaveLength(2);
    expect(keys(t)).toEqual(["hot_flag:prop-1:2026-10-15T11:00:00.000Z"]);
  });

  it("a run-only failed hold and its own event (same hot_failed key) dedupe too", async () => {
    const failedPromotion: HotPromotion = { propertyId: "prop-1", assigneeUserId: "", name: "Dana", assignedAt: "2026-10-15T11:00:00.000Z", kind: "hot_failed", key: "hot_failed:in-g", reason: "hot_lead_assign_failed" };
    const t = setup({
      promotions: [failedPromotion],
      holds: [hold({ hot: true, flagHot: false, runHot: false, reasonKey: "jev_decision", runReason: "hot_lead_assign_failed", runInbound: "in-g", runStartedAt: "2026-10-15T11:00:00.000Z", startedAt: "2026-10-15T11:00:00.000Z" })],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(chans(t)).toHaveLength(2);
    expect(keys(t)).toEqual(["hot_failed:in-g"]);
  });

  it("a run-only failed hold with no run inbound fails closed (reported)", async () => {
    const none = setup({ holds: [hold({ hot: true, reasonKey: "jev_decision", flagHot: false, runReason: "hot_lead_assign_failed", startedAt: "2026-10-15T11:00:00.000Z" })] });
    await runHoldAlertsForOrg(none.deps, "org-failed-no-time"); // own org: the unverified report is rate-limited per org per hour
    expect(chans(none)).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("without a verified hot time") }), expect.anything());
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

  it("the 'unverified hot time' report is rate-limited to once per org per hour", async () => {
    const unverified = () => hold({ hot: true, flagHot: true, flagAt: null, startedAt: "2026-10-15T11:00:00.000Z" });
    const reports = () => vi.mocked(reportError).mock.calls.filter((c) => String((c[0] as Error)?.message ?? "").includes("without a verified hot time")).length;
    const org = "org-unverified-rl";
    const t = setup({ holds: [unverified()] });
    await runHoldAlertsForOrg(t.deps, org);
    await runHoldAlertsForOrg(t.deps, org);
    expect(reports()).toBe(1);
    const later = setup({ holds: [unverified()], nowIso: "2026-10-15T14:00:00.000Z" });
    await runHoldAlertsForOrg(later.deps, org);
    expect(reports()).toBe(2);
  });
});
