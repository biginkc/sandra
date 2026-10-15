import { describe, expect, it, vi } from "vitest";

import { reportError } from "@/lib/errors/report";

import { runHoldAlertsForOrg } from "./core";
import { ACQ, hold, makeDeps as baseMakeDeps, ORG, OWNER } from "./test-support";

/** Only HOT holds alert (PR 2), so the default hold here is hot. Tests that need a cold hold pass holds explicitly. */
const makeDeps = (over: Parameters<typeof baseMakeDeps>[0] = {}) => baseMakeDeps({ holds: [hold({ hot: true })], ...over });

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const HOUR = 60 * 60 * 1000;

describe("first stage alerts (hot hold, owner only)", () => {
  it("sends exactly one Slack DM and one SMS, both to the hot owner, and nothing to acquisitions", async () => {
    const t = makeDeps();
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    const slack = t.sent.filter((s) => s.channel === "slack");
    const sms = t.sent.filter((s) => s.channel === "sms");
    expect(slack.map((s) => s.userId)).toEqual(["owner-1"]);
    expect(sms.map((s) => s.userId)).toEqual(["owner-1"]);
    expect(slack[0].text).toContain("Dana");
    expect(slack[0].text).not.toContain("Oak St");
    expect(slack[0].text).toContain("https://app.example.com/leads/prop-1");
    expect(t.store.rows.every((r) => r.status === "sent" && r.stage === "first")).toBe(true);
    expect(t.sent.some((s) => s.userId === "acq-1")).toBe(false);
    expect(summary).toMatchObject({ holds: 1, sent: 2, failed: 0 });
  });

  it("a non-hot hold sends nothing per hold", async () => {
    const t = baseMakeDeps({ holds: [hold({ hot: false })] });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows).toEqual([]);
    expect(summary).toMatchObject({ holds: 1, sent: 0 });
  });

  it("with two owners and no way to tell which is the hot owner, sends NO hot deliveries, says so, and still sends the digest", async () => {
    vi.mocked(reportError).mockClear();
    const second = { userId: "owner-2", role: "owner" as const };
    const t = makeDeps({ hotOwner: null, recipients: [OWNER, second, ACQ], emailEnabled: true });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack" || s.channel === "sms")).toEqual([]);
    expect(t.store.rows.filter((r) => r.channel !== "email")).toEqual([]);
    expect(summary.hotOwnerUnknown).toBe(true);
    expect(reportError).toHaveBeenCalled();
    expect(t.sent.some((s) => s.channel === "email")).toBe(true);
  });

  it("a hot-owner lookup that throws is treated the same: no hot deliveries, flagged, reported, no crash, digest still sent", async () => {
    vi.mocked(reportError).mockClear();
    const t = makeDeps({
      recipients: [OWNER, ACQ],
      emailEnabled: true,
      loadHotOwner: async () => {
        throw new Error("owner lookup down");
      },
    });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack" || s.channel === "sms")).toEqual([]);
    expect(summary.hotOwnerUnknown).toBe(true);
    expect(reportError).toHaveBeenCalled();
    expect(t.sent.some((s) => s.channel === "email")).toBe(true);
  });

  it("an unknown hot owner stops promotions too: zero deliveries, hotOwnerUnknown set", async () => {
    const t = makeDeps({
      hotOwner: null,
      holds: [],
      promotions: [{ propertyId: "prop-9", assigneeUserId: OWNER.userId, name: "Pat", assignedAt: "2026-10-15T09:30:00.000Z" }],
    });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows).toEqual([]);
    expect(summary.hotOwnerUnknown).toBe(true);
  });

  it("a hot hold and a promotion for the same property in one pass send exactly one Slack and one SMS", async () => {
    const t = makeDeps({
      holds: [hold({ hot: true })],
      promotions: [{ propertyId: "prop-1", assigneeUserId: OWNER.userId, name: "Dana", assignedAt: "2026-10-15T09:30:00.000Z" }],
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    expect(t.sent.filter((s) => s.channel === "sms")).toHaveLength(1);
    expect(new Set(t.store.rows.map((r) => r.holdKey))).toEqual(new Set(["hot_promotion:prop-1"]));
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("records no_token and pref_disabled as visible skipped rows, not silence", async () => {
    const t = makeDeps();
    t.results.slack = { status: "skipped", reason: "no_token" };
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.filter((r) => r.channel === "slack").map((r) => [r.status, r.lastError])).toEqual([["skipped", "no_token"]]);
    const t2 = makeDeps();
    t2.results.slack = { status: "skipped", reason: "pref_disabled" };
    await runHoldAlertsForOrg(t2.deps, ORG);
    expect(t2.store.rows.filter((r) => r.channel === "slack").every((r) => r.status === "skipped" && r.lastError === "pref_disabled")).toBe(true);
  });
});

describe("hot-hold SMS", () => {
  it("goes to the owner only, for hot holds only", async () => {
    const hot = makeDeps({ holds: [hold({ hot: true })] });
    await runHoldAlertsForOrg(hot.deps, ORG);
    const sms = hot.sent.filter((s) => s.channel === "sms");
    expect(sms).toHaveLength(1);
    expect(sms[0].userId).toBe("owner-1");
    expect(sms[0].text).toContain("https://app.example.com/leads/prop-1");

    const cold = makeDeps({ holds: [hold({ hot: false })] });
    await runHoldAlertsForOrg(cold.deps, ORG);
    expect(cold.sent.some((s) => s.channel === "sms")).toBe(false);
    expect(cold.store.rows.some((r) => r.channel === "sms")).toBe(false);
  });

  it("records no_phone / not_configured as skipped", async () => {
    const t = makeDeps({ holds: [hold({ hot: true })] });
    t.results.sms = { status: "skipped", reason: "no_phone" };
    await runHoldAlertsForOrg(t.deps, ORG);
    const row = t.store.rows.find((r) => r.channel === "sms")!;
    expect([row.status, row.lastError]).toEqual(["skipped", "no_phone"]);
  });

  it("does not send SMS at all when there is no owner recipient", async () => {
    const t = makeDeps({ holds: [hold({ hot: true })], recipients: [ACQ] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.some((s) => s.channel === "sms")).toBe(false);
  });
});

describe("caps", () => {
  it("skips a DM past 20 per recipient per rolling hour with a visible reason", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`,
        orgId: ORG,
        propertyId: `p${i}`,
        holdKey: `p${i}:x`,
        recipientUserId: OWNER.userId,
        channel: "slack",
        stage: "first",
        status: "sent",
        attempts: 1,
        lastError: null,
        createdAt: "2026-10-15T09:50:00.000Z",
        sentAt: "2026-10-15T09:50:00.000Z",
      });
    }
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(0);
    expect(summary.deferred).toBe(1);
    // Over the cap is "not yet", not "never": the row stays pending with no attempt spent.
    const row = t.store.rows.find((r) => r.holdKey === "hot_promotion:prop-1" && r.channel === "slack")!;
    expect([row.status, row.attempts, row.lastError]).toEqual(["pending", 0, null]);
  });

  it("counts in-flight (sending) deliveries toward the DM cap", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`, orgId: ORG, propertyId: `p${i}`, holdKey: `p${i}:x`, recipientUserId: OWNER.userId,
        channel: "slack", stage: "first", status: "sending", attempts: 1, lastError: null,
        createdAt: "2026-10-15T10:01:30.000Z", sentAt: null, sendingAt: "2026-10-15T10:01:30.000Z",
      });
    }
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(0);
    expect(summary.deferred).toBe(1);
  });

  it("delivers a capped row on a later run once the hour has rolled", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`, orgId: ORG, propertyId: `p${i}`, holdKey: `p${i}:x`, recipientUserId: OWNER.userId,
        channel: "slack", stage: "first", status: "sent", attempts: 1, lastError: null,
        createdAt: "2026-10-15T09:50:00.000Z", sentAt: "2026-10-15T09:50:00.000Z",
      });
    }
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(0);
    t.setNow("2026-10-15T10:55:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    expect(t.store.rows.find((r) => r.holdKey === "hot_promotion:prop-1" && r.stage === "first")!.status).toBe("sent");
  });

  it("counts only the last hour toward the DM cap", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`,
        orgId: ORG,
        propertyId: `p${i}`,
        holdKey: `p${i}:x`,
        recipientUserId: OWNER.userId,
        channel: "slack",
        stage: "first",
        status: "sent",
        attempts: 1,
        lastError: null,
        createdAt: "2026-10-15T07:00:00.000Z",
        sentAt: "2026-10-15T07:00:00.000Z",
      });
    }
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
  });

  it("skips SMS past 10 per hour for the org", async () => {
    const t = makeDeps({ holds: [hold({ hot: true })], recipients: [OWNER] });
    for (let i = 0; i < 10; i++) {
      t.store.rows.push({
        id: `sms${i}`,
        orgId: ORG,
        propertyId: `p${i}`,
        holdKey: `p${i}:x`,
        recipientUserId: OWNER.userId,
        channel: "sms",
        stage: "first",
        status: "sent",
        attempts: 1,
        lastError: null,
        createdAt: "2026-10-15T09:55:00.000Z",
        sentAt: "2026-10-15T09:55:00.000Z",
      });
    }
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.some((s) => s.channel === "sms")).toBe(false);
    const row = t.store.rows.find((r) => r.channel === "sms" && r.holdKey === "hot_promotion:prop-1")!;
    expect([row.status, row.attempts, row.lastError]).toEqual(["pending", 0, null]);
  });
});

describe("authorization re-check at delivery time", () => {
  it("skips a recipient who is no longer an owner, without sending", async () => {
    const t = makeDeps({ isRecipientAuthorized: async (_org, userId) => userId !== "owner-1" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toEqual([]);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.lastError])).toEqual([
      ["slack", "skipped", "recipient_not_owner"],
      ["sms", "skipped", "recipient_not_owner"],
    ]);
  });

  it("re-confirms role = owner at send time for both the Slack DM and the SMS", async () => {
    const asked: Array<{ user: string; requireOwner: boolean | undefined }> = [];
    const t = makeDeps({
      recipients: [OWNER],
      isRecipientAuthorized: async (_org, user, opts) => {
        asked.push({ user, requireOwner: opts?.requireOwner });
        return !opts?.requireOwner; // demoted since the list was loaded
      },
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(asked).toEqual([
      { user: "owner-1", requireOwner: true },
      { user: "owner-1", requireOwner: true },
    ]);
    expect(t.sent).toEqual([]);
    expect(t.store.rows.map((r) => [r.channel, r.status, r.lastError])).toEqual([
      ["slack", "skipped", "recipient_not_owner"],
      ["sms", "skipped", "recipient_not_owner"],
    ]);
  });

  it("re-checks immediately before each send, not once per run", async () => {
    const checked: string[] = [];
    const t = makeDeps({
      isRecipientAuthorized: async (_o, u) => {
        checked.push(u);
        return true;
      },
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(checked.length).toBeGreaterThanOrEqual(2);
  });
});

describe("email digest", () => {
  it("creates no digest rows when the flag is off", async () => {
    const t = makeDeps({ emailEnabled: false });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.some((r) => r.channel === "email")).toBe(false);
  });

  it("sends one digest per recipient per UTC hour listing open holds", async () => {
    const t = makeDeps({ emailEnabled: true });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    const mail = t.sent.filter((s) => s.channel === "email");
    expect(mail).toHaveLength(2);
    expect(mail[0].text).toContain("Dana");
    expect(mail[0].text).not.toContain("Oak St");
    expect(mail[0].text).toContain("https://app.example.com/leads/prop-1");
    const keys = t.store.rows.filter((r) => r.channel === "email").map((r) => r.holdKey);
    expect(new Set(keys)).toEqual(new Set([`digest:${ORG}:2026-10-15T10`]));
    expect(t.store.rows.find((r) => r.channel === "email")!.propertyId).toBeNull();

    t.setNow("2026-10-15T11:01:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "email")).toHaveLength(4);
  });

  it("derives the email Idempotency-Key from the delivery row id", async () => {
    const t = makeDeps({ emailEnabled: true });
    await runHoldAlertsForOrg(t.deps, ORG);
    const mail = t.sent.filter((x) => x.channel === "email");
    const rows = t.store.rows.filter((r) => r.channel === "email");
    expect(mail.map((m) => m.idempotencyKey).sort()).toEqual(rows.map((r) => `hold-alert-${r.id}`).sort());
  });
  it("records a missing Resend key as skipped", async () => {
    const t = makeDeps({ emailEnabled: true });
    t.results.email = { status: "skipped", reason: "no_resend_key" };
    await runHoldAlertsForOrg(t.deps, ORG);
    const row = t.store.rows.find((r) => r.channel === "email")!;
    expect([row.status, row.lastError]).toEqual(["skipped", "no_resend_key"]);
  });

  it("sends no digest when nothing is open", async () => {
    const t = makeDeps({ emailEnabled: true, holds: [] });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows).toHaveLength(0);
  });
});

describe("durability and idempotency", () => {
  it("never re-sends a delivery that already succeeded", async () => {
    const t = makeDeps();
    await runHoldAlertsForOrg(t.deps, ORG);
    const n = t.sent.length;
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(n);
  });

  it("does not double-send when two cron runs overlap", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    await Promise.all([runHoldAlertsForOrg(t.deps, ORG), runHoldAlertsForOrg(t.deps, ORG)]);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
  });

  it("retries a failed delivery up to 3 attempts then leaves it failed", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    t.results.slack = { status: "failed", error: "slack_down" };
    for (let i = 0; i < 5; i++) await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(3);
    const row = t.store.rows[0];
    expect([row.status, row.attempts, row.lastError]).toEqual(["failed", 3, "slack_down"]);
  });

  it("a retry that succeeds ends sent and stops", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    t.results.slack = { status: "failed", error: "blip" };
    await runHoldAlertsForOrg(t.deps, ORG);
    t.results.slack = { status: "sent" };
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);
    expect(t.store.rows[0].status).toBe("sent");
  });

  it("never retries a terminal (ambiguous) failure", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    t.results.slack = { status: "failed", error: "timeout_ambiguous", terminal: true };
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
  });

  it("a row is already `sending` when the provider is called (before, not after)", async () => {
    const seen: string[] = [];
    const t = makeDeps({ recipients: [OWNER] });
    t.deps.sendSlack = async () => {
      seen.push(t.store.rows[0]!.status);
      return { status: "sent" };
    };
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(seen).toEqual(["sending"]);
  });

  it("a crash mid-send is swept to failed:interrupted after the route's max duration and never resent", async () => {
    const t = baseMakeDeps({ recipients: [OWNER], nowIso: "2026-10-15T10:00:00.000Z" });
    t.deps.sendSlack = async () => {
      throw new Error("process died"); // stands in for a crash: the row is left claimed
    };
    // Simulate the dead run directly: a row claimed and left in `sending`.
    const row = await t.store.ensure({ orgId: ORG, propertyId: "prop-1", holdKey: "prop-1:draft_held", recipientUserId: "owner-1", channel: "slack", stage: "first" });
    await t.store.claim(row);
    expect(t.store.rows[0]).toMatchObject({ status: "sending", attempts: 1 });

    // Within the route's duration the row belongs to a live run: untouched, not resent.
    t.setNow("2026-10-15T10:00:30.000Z");
    const early = await runHoldAlertsForOrg(t.deps, ORG);
    expect(early.interrupted).toBe(0);
    expect(t.store.rows[0]!.status).toBe("sending");

    // Past it, the row is terminal and is never sent again by any later run.
    t.setNow("2026-10-15T10:01:30.000Z");
    const late = await runHoldAlertsForOrg(t.deps, ORG);
    expect(late.interrupted).toBe(1);
    expect(t.store.rows[0]).toMatchObject({ status: "failed", lastError: "interrupted", attempts: 3 });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows).toHaveLength(1);
    expect(t.sent).toHaveLength(0);
  });

  it("a sender that throws AFTER the provider call began is terminal: no retry, no duplicate", async () => {
    const t = makeDeps({
      recipients: [OWNER],
      sendSlack: async () => {
        throw new Error("socket hang up");
      },
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows[0]).toMatchObject({ status: "failed", attempts: 3, lastError: "socket hang up" });
  });

  it("an email that hit a post-submit throw or a 5xx is terminal: the next cron passes never claim it again", async () => {
    const { createChannelSenders } = await import("./channels");
    const admin = {
      auth: { admin: { getUserById: async () => ({ data: { user: { email: "o@example.com" } }, error: null }) } },
    } as never;
    const outcomes: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => new Response("bad gateway", { status: 502 }),
    ];
    for (const outcome of outcomes) {
      const calls = vi.fn(outcome);
      const senders = createChannelSenders(admin, {
        env: { RESEND_API_KEY: "k", HOLD_ALERT_EMAIL_FROM: "a@b.c" },
        fetch: calls as never,
      });
      const t = makeDeps({ emailEnabled: true, recipients: [OWNER], sendEmail: senders.sendEmail });
      for (let i = 0; i < 4; i++) await runHoldAlertsForOrg(t.deps, ORG);
      expect(calls).toHaveBeenCalledTimes(1);
      const row = t.store.rows.find((r) => r.channel === "email")!;
      expect(row).toMatchObject({ status: "failed", attempts: 3 });
    }
  });

  it("a thrown sender is recorded as failed, not crashed", async () => {
    const t = makeDeps({
      recipients: [OWNER],
      sendSlack: async () => {
        throw new Error("boom");
      },
    });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(summary.failed).toBe(1);
    expect(t.store.rows[0]).toMatchObject({ status: "failed", lastError: "boom" });
  });

  it("stops at the time budget and leaves the rest for the next run", async () => {
    const t = makeDeps({ holds: [hold({ hot: true }), hold({ hot: true, holdKey: "prop-2:x", propertyId: "prop-2" })] });
    let calls = 0;
    const base = t.deps.now;
    t.deps.now = () => new Date(base().getTime() + calls++ * HOUR);
    const summary = await runHoldAlertsForOrg(t.deps, ORG, { budgetMs: 1 });
    expect(summary.budgetExhausted).toBe(true);
  });
});

describe("incomplete alert load", () => {
  it("is reported once per run, and still alerts on what did load", async () => {
    vi.mocked(reportError).mockClear();
    const t = makeDeps({ holdsComplete: false });
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(summary.holds).toBe(1);
  });
  it("a complete load reports nothing", async () => {
    vi.mocked(reportError).mockClear();
    await runHoldAlertsForOrg(makeDeps().deps, ORG);
    expect(reportError).not.toHaveBeenCalled();
  });
});

/** Rows as they existed before one-key-per-hot-seller: tied to a property, so archive-on-clear can still close them. */
function seedPropertyRows(t: ReturnType<typeof makeDeps>, propertyId = "prop-1") {
  for (const channel of ["slack", "sms"] as const) {
    t.store.rows.push({
      id: `legacy-${propertyId}-${channel}`, orgId: ORG, propertyId, holdKey: `${propertyId}:hot_lead`, recipientUserId: OWNER.userId,
      channel, stage: "first", status: "sent", attempts: 1, lastError: null,
      createdAt: "2026-10-15T09:00:00.000Z", sentAt: "2026-10-15T09:00:00.000Z",
    });
  }
}

describe("archive-on-clear (property-tied rows close when the hold clears)", () => {
  it("hot-seller rows have no property id and are never archived: a cleared hold does not re-arm the alert", async () => {
    const t = makeDeps();
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.every((r) => r.propertyId === null && r.holdKey === "hot_promotion:prop-1")).toBe(true);
    const cleared = makeDeps({ store: t.store, holds: [] });
    expect((await runHoldAlertsForOrg(cleared.deps, ORG)).archived).toBe(0);
    expect(t.store.rows.some((r) => r.holdKey.includes(":closed:"))).toBe(false);
  });

  it("a hot hold that clears and re-opens does NOT alert again (one Slack + one SMS per seller, ever)", async () => {
    const t = makeDeps({ nowIso: "2026-10-15T10:02:00.000Z" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
    const open = t.deps.loadHolds;
    t.deps.loadHolds = async () => ({ holds: [], complete: true });
    t.setNow("2026-10-15T10:10:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    t.deps.loadHolds = open;
    t.setNow("2026-10-15T10:20:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(2);
  });

  it("archives only properties this run saw as delivered: a row ensured by an overlapping run is left alone", async () => {
    const t = makeDeps();
    seedPropertyRows(t);
    const cleared = makeDeps({ store: t.store, holds: [] });
    const realListing = t.store.deliveredPropertyIds.bind(t.store);
    cleared.store.deliveredPropertyIds = async (org: string) => {
      const listing = await realListing(org);
      // An overlapping run ensures a fresh row AFTER this run listed delivered properties.
      await t.store.ensure({ orgId: ORG, propertyId: "prop-2", holdKey: "prop-2:draft_held", recipientUserId: "owner-1", channel: "slack", stage: "first" });
      return listing;
    };
    const summary = await runHoldAlertsForOrg(cleared.deps, ORG);
    expect(summary.archived).toBe(2);
    const fresh = t.store.rows.find((r) => r.propertyId === "prop-2")!;
    expect(fresh.holdKey.includes(":closed:")).toBe(false);
  });

  it("does not archive a hold that is still open, a digest row, or another org's row", async () => {
    const t = makeDeps({ emailEnabled: true });
    seedPropertyRows(t);
    await runHoldAlertsForOrg(t.deps, ORG);
    const digest = t.store.rows.filter((r) => r.channel === "email");
    expect(digest.length).toBeGreaterThan(0);
    await t.store.ensure({ orgId: "other-org", propertyId: "other-prop", holdKey: "other-prop:x", recipientUserId: "u", channel: "slack", stage: "first" });
    const again = await runHoldAlertsForOrg(t.deps, ORG);
    expect(again.archived).toBe(0);
    expect(t.store.rows.some((r) => r.holdKey.includes(":closed:"))).toBe(false);
  });

  it("a failed held-lookup, or an incomplete delivered-property list, archives nothing", async () => {
    const t = makeDeps();
    seedPropertyRows(t);
    const failed = makeDeps({ store: t.store, holds: [], loadHeldPropertyIds: async () => null });
    expect((await runHoldAlertsForOrg(failed.deps, ORG)).archived).toBe(0);
    const incomplete = makeDeps({ store: t.store, holds: [] });
    t.store.deliveredPropertyIds = async () => ({ ids: ["prop-1"], complete: false });
    expect((await runHoldAlertsForOrg(incomplete.deps, ORG)).archived).toBe(0);
    expect(t.store.rows.some((r) => r.holdKey.includes(":closed:"))).toBe(false);
  });

  it("archives a closed hold even when the alert load is incomplete or the backlog is huge", async () => {
    const t = makeDeps();
    seedPropertyRows(t);
    const closed = makeDeps({ store: t.store, holds: [], holdsComplete: false });
    expect((await runHoldAlertsForOrg(closed.deps, ORG)).archived).toBe(2);
  });

  it("archiving is idempotent: a repeat pass after a crash archives nothing more", async () => {
    const t = makeDeps();
    seedPropertyRows(t);
    const cleared = makeDeps({ store: t.store, holds: [] });
    expect((await runHoldAlertsForOrg(cleared.deps, ORG)).archived).toBe(2);
    expect((await runHoldAlertsForOrg(cleared.deps, ORG)).archived).toBe(0);
  });
});

describe("lead links and reason labels", () => {
  it("every format links only the lead page, labels the reason, and carries no message text or Messages v2 link", async () => {
    const t = makeDeps({ emailEnabled: true, holds: [hold({ hot: true, propertyId: "prop-9", holdKey: "prop-9:price_or_offer", reasonLabel: "price talk" })] });
    await runHoldAlertsForOrg(t.deps, ORG);
    const texts = t.sent.map((s) => s.text);
    expect(new Set(t.sent.map((s) => s.channel))).toEqual(new Set(["slack", "sms", "email"]));
    for (const text of texts) {
      expect(text).toContain("https://app.example.com/leads/prop-9");
      expect(text).toContain("price talk");
      expect(text).not.toContain("messages-v2");
      expect(text.match(/https?:\/\//g)).toHaveLength(1);
      expect(text).not.toContain("Oak St");
    }
  });
});
