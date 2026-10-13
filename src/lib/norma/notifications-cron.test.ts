import { describe, expect, it, vi } from "vitest";

import { makeClient, type Row } from "./followup-notice.fake";
import {
  NORMA_CRON_MAX_DURATION_MS,
  NORMA_CRON_SAFETY_MS,
  NORMA_CRON_TOTAL_MS,
  NORMA_FOLLOWUP_MIN_SLICE_MS,
  NORMA_SUMMARY_BUDGET_MS,
  remainingCronBudgetMs,
  runNormaNotificationsCron,
} from "./notifications-cron";
import { NORMA_NOTIFICATION_ROW_RESERVE_MS, type NormaSlackPost } from "./slack-worker";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const NOW = Date.parse("2026-10-09T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("shared deadline arithmetic", () => {
  it("is one total inside the function limit, with a reserved slice for follow-ups", () => {
    expect(NORMA_CRON_MAX_DURATION_MS).toBe(60_000);
    expect(NORMA_CRON_TOTAL_MS).toBe(NORMA_CRON_MAX_DURATION_MS - NORMA_CRON_SAFETY_MS);
    expect(NORMA_SUMMARY_BUDGET_MS + NORMA_FOLLOWUP_MIN_SLICE_MS).toBe(NORMA_CRON_TOTAL_MS);
    expect(NORMA_CRON_TOTAL_MS).toBeLessThan(NORMA_CRON_MAX_DURATION_MS);
    expect(NORMA_SUMMARY_BUDGET_MS).toBeGreaterThan(NORMA_NOTIFICATION_ROW_RESERVE_MS);
    expect(NORMA_FOLLOWUP_MIN_SLICE_MS).toBeGreaterThan(NORMA_NOTIFICATION_ROW_RESERVE_MS);
  });
  it("hands the follow-ups whatever is left of the shared total, never negative", () => {
    expect(remainingCronBudgetMs(0)).toBe(NORMA_CRON_TOTAL_MS);
    expect(remainingCronBudgetMs(NORMA_SUMMARY_BUDGET_MS)).toBe(NORMA_FOLLOWUP_MIN_SLICE_MS);
    expect(remainingCronBudgetMs(NORMA_CRON_TOTAL_MS + 5_000)).toBe(0);
  });
});

describe("runNormaNotificationsCron: neither drain starts a post after the deadline", () => {
  function setup(summaryRows: number, followRows: number, postMs: number) {
    let t = 0;
    const clock = () => t;
    const starts: { at: number; kind: "summary" | "followup" }[] = [];
    const post: NormaSlackPost = async (m) => {
      starts.push({ at: t, kind: m.text.startsWith("Norma callback task") ? "followup" : "summary" });
      t += postMs;
      return { ts: `1.${starts.length}` };
    };
    const tables = {
      norma_notifications: Array.from({ length: summaryRows }, (_, i): Row => ({ id: `n${i}`, request_id: `r${i}`, kind: "call_completed", status: "pending", attempts: 0, next_attempt_at: iso(NOW - 1000 - i), slack_ts: null, last_error: null })),
      norma_call_requests: Array.from({ length: summaryRows }, (_, i): Row => ({ id: `r${i}`, property_id: "p1", contact_id: "c1", outcome: "callback_requested", summary: "s", qualification: {}, callback_raw: null })),
      norma_followup_reassignments: Array.from({ length: followRows }, (_, i): Row => ({ id: `f${i}`, org_id: "o1", request_id: `fr${i}`, property_id: "p1", kind: "callback_task", status: "open", payload: { title: "x" }, created_at: iso(NOW - 100_000 + i) })),
      properties: [{ id: "p1", org_id: "o1", address: "12 Oak St", city: "KC", state: "MO", homeowner_contact_id: "c1" }],
      contacts: [{ id: "c1", org_id: "o1", contact_type: "person", first_name: "Pat", last_name: "Seller", entity_name: null }],
    };
    return { clock, starts, post, client: makeClient(tables).client };
  }

  it("slow summaries still leave the follow-ups their slice, and nothing starts past total minus a post's worst case", async () => {
    const s = setup(30, 10, 6_000);
    const result = await runNormaNotificationsCron({ client: s.client, post: s.post, clock: s.clock, now: NOW });
    const summaryPosts = s.starts.filter((p) => p.kind === "summary");
    const followPosts = s.starts.filter((p) => p.kind === "followup");
    expect(summaryPosts.length).toBeGreaterThan(0);
    expect(followPosts.length).toBeGreaterThan(0);
    for (const p of summaryPosts) expect(p.at).toBeLessThanOrEqual(NORMA_SUMMARY_BUDGET_MS - NORMA_NOTIFICATION_ROW_RESERVE_MS);
    for (const p of s.starts) expect(p.at).toBeLessThanOrEqual(NORMA_CRON_TOTAL_MS - NORMA_NOTIFICATION_ROW_RESERVE_MS);
    expect(result.summary.deferred).toBeGreaterThan(0);
  });

  it("when summaries use their whole share the follow-ups run on exactly what remains", async () => {
    const s = setup(30, 10, 11_000);
    await runNormaNotificationsCron({ client: s.client, post: s.post, clock: s.clock, now: NOW });
    for (const p of s.starts) expect(p.at).toBeLessThanOrEqual(NORMA_CRON_TOTAL_MS - NORMA_NOTIFICATION_ROW_RESERVE_MS);
    expect(s.starts.some((p) => p.kind === "followup")).toBe(true);
  });

  it("a follow-up failure is reported and does not hide the summary result", async () => {
    const s = setup(2, 0, 100);
    const inner = s.client as unknown as { from: (t: string) => unknown };
    const broken = {
      from: (table: string) => {
        if (table === "norma_followup_reassignments") throw new Error("boom");
        return inner.from(table);
      },
    };
    const onFollowupError = vi.fn();
    const result = await runNormaNotificationsCron({ client: broken as never, post: s.post, clock: s.clock, now: NOW, onFollowupError });
    expect(result.summary.sent).toBe(2);
    expect(result.followups).toEqual({ error: "followup_notice_failed" });
    expect(onFollowupError).toHaveBeenCalledTimes(1);
  });
});
