import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import {
  getOperatorDayBounds,
  getOutboundSmsMetrics,
} from "./message-metrics";

type MessageRecord = {
  campaign_id: string | null;
  org_id: string | null;
  channel: string;
  direction: string;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  scheduled_for: string | null;
};

function createSupabase(rows: MessageRecord[]): SupabaseClient<Database> {
  return {
    rpc: vi.fn((_name, args) => {
      const scoped = rows.filter(
        (message) =>
          message.channel === "sms" &&
          message.direction === "outbound" &&
          (!args.p_campaign_id || message.campaign_id === args.p_campaign_id) &&
          (!args.p_org_id || message.org_id === args.p_org_id),
      );
      const count = (predicate: (message: MessageRecord) => boolean) =>
        scoped.filter(predicate).length;
      const scheduled = scoped
        .filter((message) => message.status === "queued" && message.scheduled_for)
        .map((message) => message.scheduled_for as string)
        .sort();
      const inDay = (value: string | null) =>
        value !== null && value >= args.p_day_start && value < args.p_day_end;
      return Promise.resolve({
        data: [
          {
            outbound_rows: scoped.length,
            queued: count((m) => m.status === "queued"),
            paused: count((m) => m.status === "paused"),
            due_queued: count(
              (m) =>
                m.status === "queued" &&
                m.scheduled_for !== null &&
                m.scheduled_for <= args.p_now,
            ),
            pending: count((m) => m.status === "pending"),
            sent: count((m) => m.status === "sent"),
            delivered: count((m) => m.status === "delivered"),
            failed: count((m) => m.status === "failed"),
            failed_after_handoff: count(
              (m) => m.status === "failed" && m.sent_at !== null,
            ),
            handed_off_via_sent_at_today: count((m) => inDay(m.sent_at)),
            delivered_without_sent_at_today: count(
              (m) =>
                m.status === "delivered" &&
                m.sent_at === null &&
                m.delivered_at !== null &&
                inDay(m.delivered_at),
            ),
            failed_today: count(
              (m) => m.status === "failed" && inDay(m.failed_at),
            ),
            next_scheduled_for: scheduled[0] ?? null,
            last_scheduled_for: scheduled.at(-1) ?? null,
          },
        ],
        error: null,
      });
    }),
  } as unknown as SupabaseClient<Database>;
}

function row(overrides: Partial<MessageRecord>): MessageRecord {
  return {
    campaign_id: "campaign-a",
    org_id: "org-a",
    channel: "sms",
    direction: "outbound",
    status: "queued",
    sent_at: null,
    delivered_at: null,
    failed_at: null,
    scheduled_for: null,
    ...overrides,
  };
}

describe("getOperatorDayBounds", () => {
  it("uses America/Chicago midnight for daylight-saving days", () => {
    expect(getOperatorDayBounds(new Date("2026-06-30T18:00:00Z"))).toEqual({
      timeZone: "America/Chicago",
      startIso: "2026-06-30T05:00:00.000Z",
      endIso: "2026-07-01T05:00:00.000Z",
    });
  });

  it("uses America/Chicago midnight for standard-time days", () => {
    expect(getOperatorDayBounds(new Date("2026-01-15T18:00:00Z"))).toEqual({
      timeZone: "America/Chicago",
      startIso: "2026-01-15T06:00:00.000Z",
      endIso: "2026-01-16T06:00:00.000Z",
    });
  });
});

describe("getOutboundSmsMetrics", () => {
  it("counts campaign-scoped outbound SMS rows with delivered rows still handed off", async () => {
    const supabase = createSupabase([
      row({
        status: "sent",
        sent_at: "2026-06-30T05:00:00.000Z",
      }),
      row({
        status: "delivered",
        sent_at: "2026-06-30T18:10:00.000Z",
      }),
      row({
        status: "delivered",
        sent_at: "2026-06-30T04:59:59.999Z",
      }),
      row({
        status: "failed",
        failed_at: "2026-06-30T20:00:00.000Z",
      }),
      row({
        status: "failed",
        sent_at: "2026-06-30T18:20:00.000Z",
        failed_at: "2026-06-30T20:30:00.000Z",
      }),
      row({
        status: "delivered",
        delivered_at: "2026-06-30T18:25:00.000Z",
      }),
      row({
        status: "queued",
        scheduled_for: "2026-06-30T17:59:00.000Z",
      }),
      row({
        status: "queued",
        scheduled_for: "2026-06-30T19:00:00.000Z",
      }),
      row({
        status: "paused",
        scheduled_for: null,
      }),
      row({ status: "pending" }),
      row({
        campaign_id: "campaign-b",
        status: "paused",
      }),
      row({
        org_id: "org-b",
        status: "paused",
      }),
      row({
        campaign_id: "campaign-b",
        status: "sent",
        sent_at: "2026-06-30T18:30:00.000Z",
      }),
      row({
        org_id: "org-b",
        status: "sent",
        sent_at: "2026-06-30T18:30:00.000Z",
      }),
      row({
        channel: "email",
        status: "sent",
        sent_at: "2026-06-30T18:30:00.000Z",
      }),
      row({
        direction: "inbound",
        status: "sent",
        sent_at: "2026-06-30T18:30:00.000Z",
      }),
    ]);

    const metrics = await getOutboundSmsMetrics(supabase, {
      scope: { campaignId: "campaign-a", orgId: "org-a" },
      now: new Date("2026-06-30T18:00:00.000Z"),
    });

    expect(metrics).toMatchObject({
      outboundRows: 10,
      queued: 2,
      paused: 1,
      dueQueued: 1,
      pending: 1,
      sent: 1,
      delivered: 3,
      failed: 2,
      handedOff: 5,
      attempted: 6,
      handedOffToday: 4,
      failedToday: 2,
      nextScheduledFor: "2026-06-30T17:59:00.000Z",
      lastScheduledFor: "2026-06-30T19:00:00.000Z",
    });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("outbound_sms_metrics", {
      p_campaign_id: "campaign-a",
      p_org_id: "org-a",
      p_now: "2026-06-30T18:00:00.000Z",
      p_day_start: "2026-06-30T05:00:00.000Z",
      p_day_end: "2026-07-01T05:00:00.000Z",
    });
  });
});
