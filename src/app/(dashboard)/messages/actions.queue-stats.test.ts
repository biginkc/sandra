import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

// eslint-disable-next-line import/first
import { getQueueStats } from "./actions";

/**
 * `getQueueStats` makes five sequential calls against `messages`:
 *   1. count(*) where status='queued'                        → number
 *   2. count(*) where status='sent' AND created_at >= today → number
 *   3. count(*) where status='failed' AND updated_at >= today → number
 *   4. select('scheduled_for') ...order asc .limit(1)       → next row
 *   5. select('scheduled_for') ...order desc .limit(1)      → last row
 *
 * The mock builder below records each filter applied so tests can assert
 * the call shape, then resolves with a per-call response taken from a
 * queue. Tests push five responses in order before invoking
 * `getQueueStats()`.
 */

type CountResponse = { count: number | null; error: { message: string } | null };
type RowsResponse = {
  data: Array<{ scheduled_for: string | null }> | null;
  error: { message: string } | null;
};
type Response = CountResponse | RowsResponse;

type CallRecord = {
  selectArgs: unknown[];
  filters: Array<{ op: string; args: unknown[] }>;
  order?: { column: string; ascending: boolean };
  limit?: number;
};

let responseQueue: Response[] = [];
let calls: CallRecord[] = [];

function makeBuilder(record: CallRecord): {
  select: (...args: unknown[]) => unknown;
} {
  const builder: Record<string, unknown> = {};
  // Resolve from the head of the response queue when awaited.
  const thenable = {
    then(
      onFulfilled: (value: Response) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      const resp = responseQueue.shift();
      if (!resp) {
        return Promise.reject(
          new Error("queue-stats test: no mock response queued"),
        ).then(onFulfilled, onRejected);
      }
      return Promise.resolve(resp).then(onFulfilled, onRejected);
    },
  };

  function chain<T extends keyof typeof builder>(
    method: T,
    op: string,
  ): (...args: unknown[]) => typeof builder {
    return (...args: unknown[]) => {
      record.filters.push({ op, args });
      return builder as typeof builder;
    };
  }

  builder.select = (...args: unknown[]) => {
    record.selectArgs = args;
    return builder;
  };
  builder.eq = chain("eq", "eq");
  builder.gte = chain("gte", "gte");
  builder.in = chain("in", "in");
  builder.order = (column: string, opts?: { ascending?: boolean }) => {
    record.order = { column, ascending: opts?.ascending ?? true };
    return builder;
  };
  builder.limit = (n: number) => {
    record.limit = n;
    return thenable;
  };
  builder.then = thenable.then;

  return builder as { select: (...args: unknown[]) => unknown };
}

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      if (table !== "messages") {
        throw new Error(`unexpected table ${table}`);
      }
      const record: CallRecord = { selectArgs: [], filters: [] };
      calls.push(record);
      return makeBuilder(record);
    }),
  };
}

beforeEach(() => {
  createClient.mockReset();
  responseQueue = [];
  calls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

function pushAllZeros() {
  responseQueue = [
    { count: 0, error: null }, // queued
    { count: 0, error: null }, // sentToday
    { count: 0, error: null }, // failedToday
    { data: [], error: null }, // nextScheduledFor (no rows)
    { data: [], error: null }, // lastScheduledFor (no rows)
  ];
}

describe("getQueueStats", () => {
  it("returns 0/0/0/null/null when no messages exist", async () => {
    pushAllZeros();
    createClient.mockResolvedValue(makeSupabase());

    const result = await getQueueStats();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      queued: 0,
      sentToday: 0,
      failedToday: 0,
      nextScheduledFor: null,
      lastScheduledFor: null,
    });
  });

  it("queued counts only status='queued' rows", async () => {
    responseQueue = [
      { count: 42, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await getQueueStats();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.queued).toBe(42);

    // First call must be a head+count select filtered to status='queued'.
    expect(calls[0].filters).toEqual([{ op: "eq", args: ["status", "queued"] }]);
  });

  it("sentToday counts only status='sent' rows with created_at >= todayStart UTC", async () => {
    responseQueue = [
      { count: 0, error: null },
      { count: 7, error: null },
      { count: 0, error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await getQueueStats();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sentToday).toBe(7);

    const sentCall = calls[1];
    const ops = sentCall.filters.map((f) => f.op);
    expect(ops).toContain("eq");
    expect(ops).toContain("gte");
    const eqFilter = sentCall.filters.find((f) => f.op === "eq");
    const gteFilter = sentCall.filters.find((f) => f.op === "gte");
    expect(eqFilter?.args).toEqual(["status", "sent"]);
    expect(gteFilter?.args[0]).toBe("created_at");
    // Boundary should be the start of UTC day, i.e. 'YYYY-MM-DDT00:00:00.000Z'.
    expect(String(gteFilter?.args[1])).toMatch(/T00:00:00\.000Z$/);
  });

  it("failedToday counts only status='failed' rows with updated_at >= todayStart UTC", async () => {
    responseQueue = [
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 3, error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await getQueueStats();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.failedToday).toBe(3);

    const failedCall = calls[2];
    const eqFilter = failedCall.filters.find((f) => f.op === "eq");
    const gteFilter = failedCall.filters.find((f) => f.op === "gte");
    expect(eqFilter?.args).toEqual(["status", "failed"]);
    expect(gteFilter?.args[0]).toBe("updated_at");
    expect(String(gteFilter?.args[1])).toMatch(/T00:00:00\.000Z$/);
  });

  it("nextScheduledFor / lastScheduledFor return min/max scheduled_for of queued rows", async () => {
    responseQueue = [
      { count: 5, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
      { data: [{ scheduled_for: "2026-05-04T18:00:00Z" }], error: null },
      { data: [{ scheduled_for: "2026-05-05T06:30:00Z" }], error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await getQueueStats();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.nextScheduledFor).toBe("2026-05-04T18:00:00Z");
    expect(result.data.lastScheduledFor).toBe("2026-05-05T06:30:00Z");

    // Min query: order ascending, limit 1, filtered to status='queued'.
    const minCall = calls[3];
    expect(minCall.order).toEqual({ column: "scheduled_for", ascending: true });
    expect(minCall.limit).toBe(1);
    expect(minCall.filters).toEqual([{ op: "eq", args: ["status", "queued"] }]);

    // Max query: order descending.
    const maxCall = calls[4];
    expect(maxCall.order).toEqual({ column: "scheduled_for", ascending: false });
    expect(maxCall.limit).toBe(1);
  });

  it("supabase error in any sub-query surfaces as { ok: false, code: 'QUEUE_STATS_FAILED' }", async () => {
    responseQueue = [
      { count: 0, error: null },
      { count: null, error: { message: "boom: sentToday failed" } },
      { count: 0, error: null },
      { data: [], error: null },
      { data: [], error: null },
    ];
    createClient.mockResolvedValue(makeSupabase());

    const result = await getQueueStats();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("QUEUE_STATS_FAILED");
    expect(result.error.message).toContain("boom");
  });
});
