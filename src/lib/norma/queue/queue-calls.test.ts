import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { QUEUE_NORMA_CHUNK_SIZE, QUEUE_NORMA_REP_CONTEXT_MAX, queueNormaCallsCore, type QueueNormaCallsDeps } from "./queue-calls";

// PROPOSED (RED): the testable core behind the server action `queueNormaCalls(propertyIds, repContext)`
// (thin "use server" wrapper in leads/actions.ts, exactly like norma-actions.ts wraps requestNormaCallCore).
// Pattern mirrors request-call.ts: session client proves what the caller may read (RLS); admin client calls the
// service-only RPC `fn_norma_queue_enqueue(p_org_id, p_requested_by, p_property_ids, p_rep_context)` (SQL contract s.4).

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = "44444444-4444-4444-8444-444444444444";

type Prop = { id: string; org_id: string; state: string | null };

function setup(opts: {
  userId?: string | null;
  readable?: Prop[];
  env?: Record<string, string>;
  enqueue?: (args: { p_property_ids: string[] }) => { data?: unknown; error?: { message: string } | null };
} = {}) {
  const readable = opts.readable ?? [{ id: uuid(1), org_id: "o1", state: "MO" }];
  const reads: string[][] = [];
  const session = {
    from: vi.fn(() => {
      let ids: string[] = [];
      const api: Record<string, unknown> = {
        select: () => api,
        is: () => api,
        in: (_col: string, vals: string[]) => { ids = vals; reads.push(vals); return api; },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: readable.filter((p) => ids.includes(p.id)), error: null }),
      };
      return api;
    }),
  } as unknown as SupabaseClient<Database>;
  const enqueueCalls: { p_org_id: string; p_requested_by: string; p_property_ids: string[]; p_rep_context: string | null }[] = [];
  const admin = {
    rpc: vi.fn(async (name: string, args: (typeof enqueueCalls)[number]) => {
      if (name !== "fn_norma_queue_enqueue") throw new Error(`unexpected rpc ${name}`);
      enqueueCalls.push(args);
      if (opts.enqueue) return { data: null, error: null, ...opts.enqueue(args) };
      return { data: args.p_property_ids.map((property_id) => ({ property_id, result: "queued", entry_id: `entry-${property_id}`, reason: null })), error: null };
    }),
  } as unknown as SupabaseClient<Database>;
  const run = (ids: string[], repContext: string | null = null) =>
    queueNormaCallsCore(ids, repContext, {
      getUserId: async () => (opts.userId === undefined ? USER : opts.userId),
      sessionClient: session,
      adminClient: admin,
      env: opts.env ?? { NORMA_QUEUE_ENABLED: "true", NORMA_QUEUE_MAX_CONCURRENT: "5", NORMA_QUEUE_DAILY_CAP: "200" },
    } satisfies QueueNormaCallsDeps);
  return { run, session, admin, enqueueCalls, reads };
}

describe("queueNormaCallsCore — authentication", () => {
  it("unauthenticated is refused before any read or RPC", async () => {
    const t = setup({ userId: null });
    expect(await t.run([uuid(1)])).toEqual({ ok: false, code: "unauthenticated" });
    expect(t.session.from).not.toHaveBeenCalled();
    expect(t.admin.rpc).not.toHaveBeenCalled();
  });
});

describe("queueNormaCallsCore — RLS visibility", () => {
  it("leads the session cannot read are excluded: never sent to the RPC, reported as not_found", async () => {
    const t = setup({ readable: [{ id: uuid(1), org_id: "o1", state: "MO" }] });
    const out = await t.run([uuid(1), uuid(2)]);
    expect(t.enqueueCalls.flatMap((c) => c.p_property_ids)).toEqual([uuid(1)]);
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) throw new Error("unreachable");
    expect(out.results.find((r) => r.propertyId === uuid(2))).toMatchObject({ result: "not_found" });
    expect(out.results.find((r) => r.propertyId === uuid(1))).toMatchObject({ result: "queued" });
  });

  it("when nothing is readable the RPC is never called", async () => {
    const t = setup({ readable: [] });
    await t.run([uuid(1)]);
    expect(t.admin.rpc).not.toHaveBeenCalled();
  });

  it("calls the RPC as the signed-in user (callback owner = requester) with the lead's org", async () => {
    const t = setup();
    await t.run([uuid(1)]);
    expect(t.enqueueCalls[0]).toMatchObject({ p_org_id: "o1", p_requested_by: USER, p_property_ids: [uuid(1)] });
  });

  it("leads from different orgs are enqueued in separate per-org calls", async () => {
    const t = setup({ readable: [{ id: uuid(1), org_id: "o1", state: "MO" }, { id: uuid(2), org_id: "o2", state: "MO" }] });
    await t.run([uuid(1), uuid(2)]);
    expect(t.enqueueCalls.map((c) => [c.p_org_id, c.p_property_ids]).sort()).toEqual([["o1", [uuid(1)]], ["o2", [uuid(2)]]]);
  });
});

describe("queueNormaCallsCore — input hygiene", () => {
  it("chunks at <= 200 ids per RPC and per read, losing and duplicating nothing", async () => {
    expect(QUEUE_NORMA_CHUNK_SIZE).toBe(200);
    const ids = Array.from({ length: 450 }, (_, i) => uuid(i + 1));
    const t = setup({ readable: ids.map((id) => ({ id, org_id: "o1", state: "MO" })) });
    const out = await t.run(ids);
    expect(t.enqueueCalls.length).toBe(3);
    for (const call of t.enqueueCalls) expect(call.p_property_ids.length).toBeLessThanOrEqual(200);
    for (const read of t.reads) expect(read.length).toBeLessThanOrEqual(200);
    expect(t.enqueueCalls.flatMap((c) => c.p_property_ids).sort()).toEqual([...ids].sort());
    if (!out.ok) throw new Error("unreachable");
    expect(out.results).toHaveLength(450);
  });

  it("dedupes repeated ids", async () => {
    const t = setup();
    await t.run([uuid(1), uuid(1), uuid(1)]);
    expect(t.enqueueCalls.flatMap((c) => c.p_property_ids)).toEqual([uuid(1)]);
  });

  it("malformed ids are not_found and never reach the database", async () => {
    const t = setup();
    const out = await t.run(["not-a-uuid", uuid(1)]);
    expect(t.reads.flat()).not.toContain("not-a-uuid");
    expect(t.enqueueCalls.flatMap((c) => c.p_property_ids)).not.toContain("not-a-uuid");
    if (!out.ok) throw new Error("unreachable");
    expect(out.results.find((r) => r.propertyId === "not-a-uuid")).toMatchObject({ result: "not_found" });
  });

  it("an empty selection is a no-op", async () => {
    const t = setup();
    expect(await t.run([])).toMatchObject({ ok: true, results: [] });
    expect(t.admin.rpc).not.toHaveBeenCalled();
  });

  it("rep context is trimmed, capped at 2000 characters, and blank becomes null", async () => {
    expect(QUEUE_NORMA_REP_CONTEXT_MAX).toBe(2000);
    const long = setup();
    await long.run([uuid(1)], `  ${"x".repeat(2500)}  `);
    expect(long.enqueueCalls[0].p_rep_context).toBe("x".repeat(2000));
    const blank = setup();
    await blank.run([uuid(1)], "   ");
    expect(blank.enqueueCalls[0].p_rep_context).toBeNull();
    const kept = setup();
    await kept.run([uuid(1)], "  seller texted yes  ");
    expect(kept.enqueueCalls[0].p_rep_context).toBe("seller texted yes");
  });
});

describe("queueNormaCallsCore — per-lead results and display schedule", () => {
  it.each(["queued", "already_queued", "blocked", "open_request", "unknown_state"] as const)("passes the RPC result %s through per lead (with reason and entry id)", async (result) => {
    const t = setup({
      enqueue: ({ p_property_ids }) => ({ data: p_property_ids.map((property_id) => ({ property_id, result, entry_id: result === "blocked" ? null : "e1", reason: result === "blocked" ? "dnc" : null })) }),
    });
    const out = await t.run([uuid(1)]);
    if (!out.ok) throw new Error("unreachable");
    expect(out.results[0]).toMatchObject({ propertyId: uuid(1), result });
    if (result === "blocked") expect(out.results[0]).toMatchObject({ reason: "dnc" });
    if (result === "already_queued" || result === "queued") expect(out.results[0]).toMatchObject({ entryId: "e1" });
  });

  // Rule 1 / B16: SQL is the only authority for the schedule. The action NEVER computes a zone or next attempt itself; it passes
  // through what fn_norma_queue_enqueue returns (PROPOSED extra return columns: next_attempt_at, display_tz).
  it("passes through the RPC's next_attempt_at and display zone unchanged (and never derives its own)", async () => {
    // The RPC values deliberately disagree with anything TS could derive from the lead state (MO) and the clock.
    const t = setup({
      enqueue: ({ p_property_ids }) => ({
        data: p_property_ids.map((property_id) => ({
          property_id, result: "queued", entry_id: "e1", reason: null,
          next_attempt_at: "2030-02-14T03:21:00Z", display_tz: "Pacific/Honolulu",
        })),
      }),
    });
    const out = await t.run([uuid(1)]);
    if (!out.ok) throw new Error("unreachable");
    expect(out.results[0]).toMatchObject({ zone: "Pacific/Honolulu", nextAttemptAt: "2030-02-14T03:21:00Z" });
  });

  it("when the RPC returns no schedule the action reports none; it does not fill one in from the lead's state", async () => {
    const t = setup(); // default RPC rows carry no next_attempt_at / display_tz; the lead is in MO (a known zone)
    const out = await t.run([uuid(1)]);
    if (!out.ok) throw new Error("unreachable");
    const first = out.results[0] as { zone?: string | null; nextAttemptAt?: string | null };
    expect(first.zone ?? null).toBeNull();
    expect(first.nextAttemptAt ?? null).toBeNull();
  });

  it("an unknown state has no zone and no next attempt (fails closed)", async () => {
    const t = setup({
      readable: [{ id: uuid(1), org_id: "o1", state: "ZZ" }],
      enqueue: ({ p_property_ids }) => ({ data: p_property_ids.map((property_id) => ({ property_id, result: "unknown_state", entry_id: null, reason: null })) }),
    });
    const out = await t.run([uuid(1)]);
    if (!out.ok) throw new Error("unreachable");
    expect(out.results[0]).toMatchObject({ result: "unknown_state" });
    expect((out.results[0] as { nextAttemptAt?: string | null }).nextAttemptAt ?? null).toBeNull();
  });
});

describe("queueNormaCallsCore — flag and failures", () => {
  it("reports whether the queue is switched on, and still queues when it is off", async () => {
    const off = setup({ env: {} });
    const out = await off.run([uuid(1)]);
    expect(out).toMatchObject({ ok: true, queueEnabled: false });
    expect(off.enqueueCalls).toHaveLength(1);
    const on = setup();
    expect(await on.run([uuid(1)])).toMatchObject({ ok: true, queueEnabled: true });
  });

  it("requester not an active member -> a typed refusal, nothing partially reported as queued", async () => {
    const t = setup({ enqueue: () => ({ error: { message: "requester_not_member" } }) });
    expect(await t.run([uuid(1)])).toEqual({ ok: false, code: "not_member" });
  });

  it("any other RPC error -> { ok:false, code:'error' } and never throws", async () => {
    const t = setup({ enqueue: () => ({ error: { message: "boom" } }) });
    expect(await t.run([uuid(1)])).toEqual({ ok: false, code: "error" });
  });

  it("a thrown error is contained", async () => {
    const t = setup({ enqueue: () => { throw new Error("network"); } });
    expect(await t.run([uuid(1)])).toEqual({ ok: false, code: "error" });
  });
});
