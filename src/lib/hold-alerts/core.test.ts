import { describe, expect, it } from "vitest";

import { runHoldAlertsForOrg } from "./core";
import { ACQ, hold, makeDeps, ORG, OWNER } from "./test-support";

const HOUR = 60 * 60 * 1000;

describe("first stage Slack DMs", () => {
  it("creates a delivery and sends one DM per owner and acquisitions member", async () => {
    const t = makeDeps();
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    const slack = t.sent.filter((s) => s.channel === "slack");
    expect(slack.map((s) => s.userId).sort()).toEqual(["acq-1", "owner-1"]);
    expect(slack[0].text).toContain("Dana");
    expect(slack[0].text).not.toContain("Oak St");
    expect(slack[0].text).toContain("https://app.example.com/messages-v2");
    expect(t.store.rows.filter((r) => r.channel === "slack").every((r) => r.status === "sent" && r.stage === "first")).toBe(true);
    expect(summary).toMatchObject({ holds: 1, sent: 2, failed: 0 });
  });

  it("records no_token and pref_disabled as visible skipped rows, not silence", async () => {
    const t = makeDeps();
    t.results.slack = { status: "skipped", reason: "no_token" };
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.map((r) => [r.status, r.lastError])).toEqual([
      ["skipped", "no_token"],
      ["skipped", "no_token"],
    ]);
    t.results.slack = { status: "skipped", reason: "pref_disabled" };
    const t2 = makeDeps();
    t2.results.slack = { status: "skipped", reason: "pref_disabled" };
    await runHoldAlertsForOrg(t2.deps, ORG);
    expect(t2.store.rows.every((r) => r.status === "skipped" && r.lastError === "pref_disabled")).toBe(true);
  });
});

describe("nudge_1h", () => {
  it("is not sent before the hold is 1h old, then sent once", async () => {
    const t = makeDeps();
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.some((r) => r.stage === "nudge_1h")).toBe(false);

    t.setNow("2026-10-08T11:05:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    const nudges = t.store.rows.filter((r) => r.stage === "nudge_1h");
    expect(nudges).toHaveLength(2);
    expect(nudges.every((r) => r.status === "sent")).toBe(true);

    const before = t.sent.length;
    t.setNow("2026-10-08T13:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.length).toBe(before);
  });

  it("does not blast a nudge on first deploy for an old hold: it waits an hour after the first DM was SENT", async () => {
    const old = hold({ since: "2026-10-01T10:00:00.000Z" });
    const t = makeDeps({ holds: [old], nowIso: "2026-10-08T10:00:00.000Z" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);
    expect(t.store.rows.some((r) => r.stage === "nudge_1h")).toBe(false);

    t.setNow("2026-10-08T10:59:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.some((r) => r.stage === "nudge_1h")).toBe(false);

    t.setNow("2026-10-08T11:01:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.filter((r) => r.stage === "nudge_1h" && r.status === "sent")).toHaveLength(2);
  });

  it("never nudges a recipient whose first DM was skipped or never sent", async () => {
    const t = makeDeps({ nowIso: "2026-10-08T10:00:00.000Z" });
    t.results.slack = { status: "skipped", reason: "no_token" };
    await runHoldAlertsForOrg(t.deps, ORG);
    t.setNow("2026-10-08T13:00:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.store.rows.some((r) => r.stage === "nudge_1h")).toBe(false);
  });
});

describe("hot-hold SMS", () => {
  it("goes to the owner only, for hot holds only", async () => {
    const hot = makeDeps({ holds: [hold({ hot: true })] });
    await runHoldAlertsForOrg(hot.deps, ORG);
    const sms = hot.sent.filter((s) => s.channel === "sms");
    expect(sms).toHaveLength(1);
    expect(sms[0].userId).toBe("owner-1");
    expect(sms[0].text).toContain("https://app.example.com/messages-v2");

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
    const t = makeDeps({ recipients: [ACQ] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`,
        orgId: ORG,
        propertyId: `p${i}`,
        holdKey: `p${i}:x`,
        recipientUserId: ACQ.userId,
        channel: "slack",
        stage: "first",
        status: "sent",
        attempts: 1,
        lastError: null,
        createdAt: "2026-10-08T09:50:00.000Z",
        sentAt: "2026-10-08T09:50:00.000Z",
      });
    }
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(0);
    expect(summary.deferred).toBe(1);
    // Over the cap is "not yet", not "never": the row stays pending with no attempt spent.
    const row = t.store.rows.find((r) => r.holdKey.startsWith("prop-1"))!;
    expect([row.status, row.attempts, row.lastError]).toEqual(["pending", 0, null]);
  });

  it("delivers a capped row on a later run once the hour has rolled", async () => {
    const t = makeDeps({ recipients: [ACQ] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`, orgId: ORG, propertyId: `p${i}`, holdKey: `p${i}:x`, recipientUserId: ACQ.userId,
        channel: "slack", stage: "first", status: "sent", attempts: 1, lastError: null,
        createdAt: "2026-10-08T09:50:00.000Z", sentAt: "2026-10-08T09:50:00.000Z",
      });
    }
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(0);
    t.setNow("2026-10-08T10:55:00.000Z");
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(1);
    expect(t.store.rows.find((r) => r.holdKey.startsWith("prop-1") && r.stage === "first")!.status).toBe("sent");
  });

  it("counts only the last hour toward the DM cap", async () => {
    const t = makeDeps({ recipients: [ACQ] });
    for (let i = 0; i < 20; i++) {
      t.store.rows.push({
        id: `old${i}`,
        orgId: ORG,
        propertyId: `p${i}`,
        holdKey: `p${i}:x`,
        recipientUserId: ACQ.userId,
        channel: "slack",
        stage: "first",
        status: "sent",
        attempts: 1,
        lastError: null,
        createdAt: "2026-10-08T07:00:00.000Z",
        sentAt: "2026-10-08T07:00:00.000Z",
      });
    }
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(1);
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
        createdAt: "2026-10-08T09:55:00.000Z",
        sentAt: "2026-10-08T09:55:00.000Z",
      });
    }
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.some((s) => s.channel === "sms")).toBe(false);
    const row = t.store.rows.find((r) => r.channel === "sms" && r.holdKey.startsWith("prop-1"))!;
    expect([row.status, row.attempts, row.lastError]).toEqual(["pending", 0, null]);
  });
});

describe("authorization re-check at delivery time", () => {
  it("skips a recipient who is no longer owner or acquisitions, without sending", async () => {
    const t = makeDeps({ isRecipientAuthorized: async (_org, userId) => userId !== "acq-1" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.map((s) => s.userId)).toEqual(["owner-1"]);
    const row = t.store.rows.find((r) => r.recipientUserId === "acq-1")!;
    expect([row.status, row.lastError]).toEqual(["skipped", "recipient_not_authorized"]);
  });

  it("re-confirms role = owner at send time for the SMS only", async () => {
    const asked: Array<{ user: string; requireOwner: boolean | undefined }> = [];
    const t = makeDeps({
      holds: [hold({ hot: true })],
      recipients: [OWNER],
      isRecipientAuthorized: async (_org, user, opts) => {
        asked.push({ user, requireOwner: opts?.requireOwner });
        return !opts?.requireOwner; // demoted since the list was loaded
      },
    });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(asked).toEqual([
      { user: "owner-1", requireOwner: undefined },
      { user: "owner-1", requireOwner: true },
    ]);
    expect(t.sent.some((s) => s.channel === "sms")).toBe(false);
    const row = t.store.rows.find((r) => r.channel === "sms")!;
    expect([row.status, row.lastError]).toEqual(["skipped", "recipient_not_owner"]);
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
    expect(mail[0].text).toContain("https://app.example.com/messages-v2");
    const keys = t.store.rows.filter((r) => r.channel === "email").map((r) => r.holdKey);
    expect(new Set(keys)).toEqual(new Set([`digest:${ORG}:2026-10-08T10`]));
    expect(t.store.rows.find((r) => r.channel === "email")!.propertyId).toBeNull();

    t.setNow("2026-10-08T11:01:00.000Z");
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
    expect(t.sent).toHaveLength(3);
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
    expect(t.sent).toHaveLength(2);
    expect(t.store.rows[0].status).toBe("sent");
  });

  it("never retries a terminal (ambiguous) failure", async () => {
    const t = makeDeps({ recipients: [OWNER] });
    t.results.slack = { status: "failed", error: "timeout_ambiguous", terminal: true };
    await runHoldAlertsForOrg(t.deps, ORG);
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent).toHaveLength(1);
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
    const t = makeDeps({ recipients: [OWNER], nowIso: "2026-10-08T10:00:00.000Z" });
    t.deps.sendSlack = async () => {
      throw new Error("process died"); // stands in for a crash: the row is left claimed
    };
    // Simulate the dead run directly: a row claimed and left in `sending`.
    const row = await t.store.ensure({ orgId: ORG, propertyId: "prop-1", holdKey: "prop-1:draft_held", recipientUserId: "owner-1", channel: "slack", stage: "first" });
    await t.store.claim(row);
    expect(t.store.rows[0]).toMatchObject({ status: "sending", attempts: 1 });

    // Within the route's duration the row belongs to a live run: untouched, not resent.
    t.setNow("2026-10-08T10:00:30.000Z");
    const early = await runHoldAlertsForOrg(t.deps, ORG);
    expect(early.interrupted).toBe(0);
    expect(t.store.rows[0]!.status).toBe("sending");

    // Past it, the row is terminal and is never sent again by any later run.
    t.setNow("2026-10-08T10:01:30.000Z");
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
    const t = makeDeps({ holds: [hold(), hold({ holdKey: "prop-2:x", propertyId: "prop-2" })] });
    let calls = 0;
    const base = t.deps.now;
    t.deps.now = () => new Date(base().getTime() + calls++ * HOUR);
    const summary = await runHoldAlertsForOrg(t.deps, ORG, { budgetMs: 1 });
    expect(summary.budgetExhausted).toBe(true);
  });
});

describe("archive-on-clear (a re-opened hold alerts again)", () => {
  it("a hold that clears and re-opens gets a fresh first alert", async () => {
    const t = makeDeps({ nowIso: "2026-10-08T10:02:00.000Z" });
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.filter((s) => s.channel === "slack")).toHaveLength(2);

    // The hold clears: the next pass sees no open holds and archives its rows.
    const open = t.deps.loadHolds;
    t.deps.loadHolds = async () => ({ holds: [], complete: true });
    t.setNow("2026-10-08T10:10:00.000Z");
    const summary = await runHoldAlertsForOrg(t.deps, ORG);
    expect(summary.archived).toBe(2);
    expect(t.store.rows.every((r) => r.holdKey.includes(":closed:"))).toBe(true);

    // It re-opens (same property, same reason): new keys, new alerts.
    t.deps.loadHolds = open;
    t.setNow("2026-10-08T10:20:00.000Z");
    const before = t.sent.length;
    await runHoldAlertsForOrg(t.deps, ORG);
    expect(t.sent.slice(before).filter((s) => s.channel === "slack")).toHaveLength(2);
    expect(t.store.rows.filter((r) => !r.holdKey.includes(":closed:") && r.status === "sent")).toHaveLength(2);
  });

  it("does not archive a hold that is still open, a digest row, or another org's row", async () => {
    const t = makeDeps({ emailEnabled: true });
    await runHoldAlertsForOrg(t.deps, ORG);
    const digest = t.store.rows.filter((r) => r.channel === "email");
    expect(digest.length).toBeGreaterThan(0);
    await t.store.ensure({ orgId: "other-org", propertyId: "other-prop", holdKey: "other-prop:x", recipientUserId: "u", channel: "slack", stage: "first" });
    const again = await runHoldAlertsForOrg(t.deps, ORG);
    expect(again.archived).toBe(0);
    expect(t.store.rows.some((r) => r.holdKey.includes(":closed:"))).toBe(false);
  });

  it("an incomplete hold load (truncated or failed query) archives nothing", async () => {
    const t = makeDeps();
    await runHoldAlertsForOrg(t.deps, ORG);
    const partial = makeDeps({ store: t.store, holds: [], holdsComplete: false });
    const summary = await runHoldAlertsForOrg(partial.deps, ORG);
    expect(summary.archived).toBe(0);
    expect(t.store.rows.some((r) => r.holdKey.includes(":closed:"))).toBe(false);
  });

  it("archiving is idempotent: a repeat pass after a crash archives nothing more", async () => {
    const t = makeDeps();
    await runHoldAlertsForOrg(t.deps, ORG);
    const cleared = makeDeps({ store: t.store, holds: [] });
    expect((await runHoldAlertsForOrg(cleared.deps, ORG)).archived).toBe(2);
    expect((await runHoldAlertsForOrg(cleared.deps, ORG)).archived).toBe(0);
  });
});
