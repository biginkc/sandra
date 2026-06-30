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

type Filter =
  | { op: "eq"; column: keyof MessageRecord; value: unknown }
  | { op: "in"; column: keyof MessageRecord; values: unknown[] }
  | { op: "not-null"; column: keyof MessageRecord }
  | { op: "is-null"; column: keyof MessageRecord }
  | { op: "gte" | "lte" | "lt"; column: keyof MessageRecord; value: string };

class MessageQuery {
  private readonly filters: Filter[] = [];
  private isCount = false;
  private orderColumn: keyof MessageRecord | null = null;
  private ascending = true;
  private limitCount: number | null = null;

  constructor(private readonly rows: MessageRecord[]) {}

  select(_columns: string, opts?: { count?: "exact"; head?: boolean }) {
    this.isCount = opts?.count === "exact" && opts?.head === true;
    return this;
  }

  eq(column: keyof MessageRecord, value: unknown) {
    this.filters.push({ op: "eq", column, value });
    return this;
  }

  in(column: keyof MessageRecord, values: unknown[]) {
    this.filters.push({ op: "in", column, values });
    return this;
  }

  not(column: keyof MessageRecord, operator: "is", value: null) {
    if (operator !== "is" || value !== null) {
      throw new Error("message metrics test mock only supports not(..., 'is', null)");
    }
    this.filters.push({ op: "not-null", column });
    return this;
  }

  is(column: keyof MessageRecord, value: null) {
    if (value !== null) {
      throw new Error("message metrics test mock only supports is(..., null)");
    }
    this.filters.push({ op: "is-null", column });
    return this;
  }

  gte(column: keyof MessageRecord, value: string) {
    this.filters.push({ op: "gte", column, value });
    return this;
  }

  lte(column: keyof MessageRecord, value: string) {
    this.filters.push({ op: "lte", column, value });
    return this;
  }

  lt(column: keyof MessageRecord, value: string) {
    this.filters.push({ op: "lt", column, value });
    return this;
  }

  order(column: keyof MessageRecord, opts?: { ascending?: boolean }) {
    this.orderColumn = column;
    this.ascending = opts?.ascending ?? true;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?:
      | ((value: {
          count?: number | null;
          data?: Array<{ scheduled_for: string | null }> | null;
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private execute() {
    let filtered = this.rows.filter((row) =>
      this.filters.every((filter) => matchesFilter(row, filter)),
    );

    if (this.orderColumn) {
      const column = this.orderColumn;
      const direction = this.ascending ? 1 : -1;
      filtered = [...filtered].sort((a, b) =>
        String(a[column] ?? "").localeCompare(String(b[column] ?? "")) *
        direction,
      );
    }

    if (this.limitCount !== null) {
      filtered = filtered.slice(0, this.limitCount);
    }

    if (this.isCount) {
      return { count: filtered.length, error: null };
    }

    return {
      data: filtered.map((row) => ({ scheduled_for: row.scheduled_for })),
      error: null,
    };
  }
}

function matchesFilter(row: MessageRecord, filter: Filter): boolean {
  const value = row[filter.column];
  switch (filter.op) {
    case "eq":
      return value === filter.value;
    case "in":
      return filter.values.includes(value);
    case "not-null":
      return value !== null && value !== undefined;
    case "is-null":
      return value === null || value === undefined;
    case "gte":
      return typeof value === "string" && value >= filter.value;
    case "lte":
      return typeof value === "string" && value <= filter.value;
    case "lt":
      return typeof value === "string" && value < filter.value;
  }
}

function createSupabase(rows: MessageRecord[]): SupabaseClient<Database> {
  return {
    from: vi.fn((table: string) => {
      if (table !== "messages") {
        throw new Error(`unexpected table ${table}`);
      }
      return new MessageQuery(rows);
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
      row({ status: "pending" }),
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
      outboundRows: 9,
      queued: 2,
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
  });
});
