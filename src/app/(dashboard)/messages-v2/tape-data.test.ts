import { describe, expect, it } from "vitest";

import type { LooseSupabase } from "./queries";
import { fakePostgrest } from "./fake-postgrest.test-util";
import { chicagoDayKey, chicagoDayWindow, isOlderThanCursor, loadRunThreads, loadRunsWindow, olderThanCursorFilter, parseRunCursor, previousDayKey } from "./tape-data";

describe("chicagoDayWindow", () => {
  it("is one America/Chicago calendar day (CDT midnight to CDT midnight)", () => {
    expect(chicagoDayWindow("2026-10-14")).toEqual({ from: "2026-10-14T05:00:00.000Z", to: "2026-10-15T05:00:00.000Z" });
  });
  it("is 25 hours on the day DST ends and 23 on the day it starts", () => {
    expect(chicagoDayWindow("2026-11-01")).toEqual({ from: "2026-11-01T05:00:00.000Z", to: "2026-11-02T06:00:00.000Z" });
    expect(chicagoDayWindow("2027-03-14")).toEqual({ from: "2027-03-14T06:00:00.000Z", to: "2027-03-15T05:00:00.000Z" });
  });
  it("rejects a malformed day or cursor", () => {
    expect(chicagoDayWindow("yesterday")).toBeNull();
  });
  it("keys instants by Chicago day (late evening Chicago is still the same day in UTC+1)", () => {
    expect(chicagoDayKey(Date.parse("2026-10-15T03:30:00Z"))).toBe("2026-10-14");
    expect(previousDayKey("2026-03-01")).toBe("2026-02-28");
  });
});

describe("run cursor (started_at, id)", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const t = "2026-10-14T12:00:00.000Z";

  it("builds a strict-older filter on the pair, not on the timestamp alone", () => {
    expect(olderThanCursorFilter({ at: t, id: id(5) })).toBe(`started_at.lt."${t}",and(started_at.eq."${t}",id.lt.${id(5)})`);
  });

  it("loadRunsWindow sends the cursor filter and orders by (started_at, id)", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt", "or", "order", "limit", "in"]) q[m] = (...args: unknown[]) => (calls.push([m, ...args]), q);
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    await loadRunsWindow({ from: () => q, rpc: () => q } as unknown as LooseSupabase, "org", "2026-10-14T05:00:00.000Z", "2026-10-15T05:00:00.000Z", { at: t, id: id(5) });
    expect(calls).toContainEqual(["or", olderThanCursorFilter({ at: t, id: id(5) })]);
    expect(calls).toContainEqual(["order", "started_at", { ascending: false }]);
    expect(calls).toContainEqual(["order", "id", { ascending: false }]);
  });

  it("only a strict timestamp and a uuid ever reach the filter string", () => {
    expect(parseRunCursor({ at: t, id: id(1) })).toEqual({ at: t, id: id(1) });
    expect(parseRunCursor({ at: "2026-10-14T12:00:00.123456+00:00", id: id(1) })?.at).toBe("2026-10-14T12:00:00.123456Z");
    expect(parseRunCursor({ at: t, id: "x),or(org_id.neq.1" })).toBeNull();
    expect(parseRunCursor({ at: "now(),a", id: id(1) })).toBeNull();
    expect(parseRunCursor(null)).toBeNull();
  });
});

/** A tiny in-memory `messages` table with the filters loadRunThreads uses. */
function fakeMessages(rows: Array<Record<string, string>>): LooseSupabase {
  return {
    from: () => {
      const f: Record<string, unknown> = {};
      const eqs: Array<[string, unknown]> = [];
      let ids: string[] | null = null;
      let lt: [string, string] | null = null;
      let max = Infinity;
      f.select = () => f;
      f.in = (_c: string, v: string[]) => ((ids = v), f);
      f.eq = (c: string, v: unknown) => (eqs.push([c, v]), f);
      f.lt = (c: string, v: string) => ((lt = [c, v]), f);
      f.order = () => f;
      f.limit = (n: number) => ((max = n), f);
      f.then = (resolve: (v: unknown) => unknown) => {
        let out = rows.map((r): Record<string, string> => ({ org_id: "org", ...r })).filter((r) => eqs.every(([c, v]) => r[c] === v) && (!ids || ids.includes(r.id)));
        if (lt) out = out.filter((r) => Date.parse(r[lt![0]]) < Date.parse(lt![1]));
        out = [...out].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
        return resolve({ data: out.slice(0, max), error: null });
      };
      return f;
    },
  } as unknown as LooseSupabase;
}

describe("loadRunThreads", () => {
  it("pairs each run with the newest outbound text sent before its inbound, and its own reply", async () => {
    const out = await loadRunThreads(
      fakeMessages([
        { id: "out-reply", body: "Thanks, take care.", org_id: "org", conversation_id: "c1", direction: "outbound", created_at: "2026-10-14T12:10:00Z" },
        { id: "m1", conversation_id: "c1", body: "newer than the run", created_at: "2026-10-14T13:00:00Z", direction: "outbound" },
        { id: "m2", conversation_id: "c1", body: "Still own the place?", created_at: "2026-10-14T11:00:00Z", direction: "outbound" },
        { id: "m3", conversation_id: "c1", body: "older", created_at: "2026-10-13T11:00:00Z", direction: "outbound" },
      ]),
      "org",
      [
        { id: "r1", conversation_id: "c1", outbound_message_id: "out-reply", started_at: "2026-10-14T12:00:00Z" },
        { id: "r2", conversation_id: null, outbound_message_id: null, started_at: "2026-10-14T12:00:00Z" },
      ],
    );
    expect(out.threads.get("r1")).toEqual({ lastOutbound: "Still own the place?", reply: "Thanks, take care." });
    expect(out.threads.get("r2")).toEqual({ lastOutbound: null, reply: null });
  });

  it("a run keeps its last outbound text even when another conversation has 1,000+ outbound rows", async () => {
    const rows = [
      ...Array.from({ length: 1500 }, (_, i) => ({ id: `b${i}`, conversation_id: "busy", body: `busy ${i}`, created_at: new Date(Date.parse("2026-10-14T10:00:00Z") + i * 1000).toISOString(), direction: "outbound" })),
      { id: "q1", conversation_id: "quiet", body: "Still own the place?", created_at: "2026-10-13T09:00:00.000Z", direction: "outbound" },
    ];
    const out = await loadRunThreads(fakeMessages(rows), "org", [
      { id: "busy-run", conversation_id: "busy", outbound_message_id: null, started_at: "2026-10-14T20:00:00Z" },
      { id: "quiet-run", conversation_id: "quiet", outbound_message_id: null, started_at: "2026-10-14T12:00:00Z" },
    ]);
    expect(out.threads.get("quiet-run")?.lastOutbound).toBe("Still own the place?");
    expect(out.threads.get("busy-run")?.lastOutbound).toBe("busy 1499");
  });
});

describe("I5 tape: thread errors and the window cut", () => {
  it("a thread-text error is returned as a failed run id (retried), never cached as 'no text'", async () => {
    const { client } = fakePostgrest({ messages: [] }, { fail: (tb, _n, ops) => tb === "messages" && ops.some((o) => o.k === "eq" && "col" in o && o.col === "conversation_id") });
    const out = await loadRunThreads(client, "org", [{ id: "r1", conversation_id: "c1", outbound_message_id: null, started_at: "2026-10-14T12:00:00Z" }]);
    expect(out.failedRunIds).toEqual(["r1"]);
    expect(out.threads.has("r1")).toBe(false);
  });

  it("a conversation with 2,000 outbound texts still yields its last outbound before the run", async () => {
    const msgs = Array.from({ length: 2000 }, (_, i) => ({
      id: `m${String(i).padStart(5, "0")}`, org_id: "org", conversation_id: "c1", direction: "outbound", body: `t${i}`,
      created_at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString(),
    }));
    const { client } = fakePostgrest({ messages: msgs }, { cap: 1000 });
    const out = await loadRunThreads(client, "org", [{ id: "r1", conversation_id: "c1", outbound_message_id: null, started_at: "2026-10-03T00:00:00.000Z" }]);
    expect(out.threads.get("r1")?.lastOutbound).toBe("t1999");
  });

  it("runs sharing started_at at the 200-row cut are not skipped", async () => {
    const base = "2026-10-14T12:00:00.000Z";
    const runs = Array.from({ length: 205 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, org_id: "org",
      started_at: i < 195 ? new Date(Date.parse(base) + (300 - i) * 1000).toISOString() : base, // 10 share the cut timestamp
    }));
    const { client } = fakePostgrest({ pipeline_runs: runs, pipeline_run_steps: [] });
    const from = "2026-10-14T05:00:00.000Z";
    const to = "2026-10-15T05:00:00.000Z";
    const first = await loadRunsWindow(client, "org", from, to);
    expect(first.runs).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const last = first.runs[first.runs.length - 1];
    const second = await loadRunsWindow(client, "org", from, to, { at: last.started_at, id: last.id });
    const all = [...first.runs, ...second.runs].map((r) => r.id);
    expect(new Set(all).size).toBe(205);
    expect(second.runs).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });
});

describe("tape cursor at microsecond precision", () => {
  it("two runs in the same millisecond on either side of the cursor are told apart", () => {
    const c = { at: "2026-10-14T12:00:00.123500Z", id: "00000000-0000-4000-8000-000000000005" };
    expect(isOlderThanCursor({ started_at: "2026-10-14T12:00:00.123400+00:00", id: "00000000-0000-4000-8000-000000000009" }, c)).toBe(true);
    expect(isOlderThanCursor({ started_at: "2026-10-14T12:00:00.123600+00:00", id: "00000000-0000-4000-8000-000000000001" }, c)).toBe(false);
    expect(isOlderThanCursor({ started_at: "2026-10-14T12:00:00.123500+00:00", id: "00000000-0000-4000-8000-000000000004" }, c)).toBe(true);
  });
});

describe("our last text is cut off at the seller's inbound message, not the run start", () => {
  it("an outbound sent between the inbound text and the run start is not shown as what preceded it", async () => {
    const { client } = fakePostgrest({
      messages: [
        { id: "in-1", org_id: "org", conversation_id: "c1", direction: "inbound", body: "No thanks", created_at: "2026-10-14T12:00:00.000Z" },
        { id: "out-before", org_id: "org", conversation_id: "c1", direction: "outbound", body: "Still own the place?", created_at: "2026-10-14T11:00:00.000Z" },
        { id: "out-between", org_id: "org", conversation_id: "c1", direction: "outbound", body: "a campaign text", created_at: "2026-10-14T12:00:30.000Z" },
      ],
    });
    const out = await loadRunThreads(client, "org", [
      { id: "r1", conversation_id: "c1", outbound_message_id: null, inbound_message_id: "in-1", started_at: "2026-10-14T12:01:00.000Z" },
    ]);
    expect(out.threads.get("r1")?.lastOutbound).toBe("Still own the place?");
  });

  it("an inbound id whose row is missing is a failed (retried) lookup, never a fall-back to the run start", async () => {
    const { client } = fakePostgrest({
      messages: [{ id: "out-1", org_id: "org", conversation_id: "c1", direction: "outbound", body: "x", created_at: "2026-10-14T11:00:00.000Z" }],
    });
    const out = await loadRunThreads(client, "org", [{ id: "r1", conversation_id: "c1", outbound_message_id: null, inbound_message_id: "gone", started_at: "2026-10-14T12:00:00.000Z" }]);
    expect(out.failedRunIds).toEqual(["r1"]);
    expect(out.threads.has("r1")).toBe(false);
  });

  it("a run with no inbound id at all uses the run start", async () => {
    const { client } = fakePostgrest({
      messages: [{ id: "out-1", org_id: "org", conversation_id: "c1", direction: "outbound", body: "x", created_at: "2026-10-14T11:00:00.000Z" }],
    });
    const out = await loadRunThreads(client, "org", [{ id: "r1", conversation_id: "c1", outbound_message_id: null, started_at: "2026-10-14T12:00:00.000Z" }]);
    expect(out.threads.get("r1")?.lastOutbound).toBe("x");
  });
});

describe("referenced messages that are missing are retried, never cached as empty", () => {
  it("outbound_message_id set but the row is missing -> failed; when the row appears the retry gets it", async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = { messages: [] };
    const run1 = { id: "r1", conversation_id: null, outbound_message_id: "o1", started_at: "2026-10-14T12:00:00.000Z" };
    const first = await loadRunThreads(fakePostgrest(tables).client, "org", [run1]);
    expect(first.failedRunIds).toEqual(["r1"]);
    expect(first.threads.has("r1")).toBe(false);
    tables.messages = [{ id: "o1", body: "Thanks, take care.", org_id: "org", conversation_id: null, direction: "outbound", created_at: "2026-10-14T12:05:00.000Z" }];
    const retry = await loadRunThreads(fakePostgrest(tables).client, "org", [run1]);
    expect(retry.failedRunIds).toEqual([]);
    expect(retry.threads.get("r1")?.reply).toBe("Thanks, take care.");
  });
});

describe("thread text is read from the caller's org only (not RLS alone)", () => {
  it("every messages query carries org_id = orgId, and another org's rows never become thread text", async () => {
    const { client, log } = fakePostgrest({
      messages: [
        { id: "in-1", org_id: "org", conversation_id: "c1", direction: "inbound", body: "No thanks", created_at: "2026-10-14T12:00:00.000Z" },
        { id: "mine", org_id: "org", conversation_id: "c1", direction: "outbound", body: "Still own the place?", created_at: "2026-10-14T10:00:00.000Z" },
        { id: "theirs", org_id: "other", conversation_id: "c1", direction: "outbound", body: "other org text", created_at: "2026-10-14T11:00:00.000Z" },
        { id: "o-other", org_id: "other", conversation_id: "c1", direction: "outbound", body: "other org reply", created_at: "2026-10-14T12:05:00.000Z" },
      ],
    });
    const out = await loadRunThreads(client, "org", [
      { id: "r1", conversation_id: "c1", outbound_message_id: null, inbound_message_id: "in-1", started_at: "2026-10-14T12:01:00.000Z" },
      { id: "r2", conversation_id: null, outbound_message_id: "o-other", started_at: "2026-10-14T12:01:00.000Z" },
    ]);
    expect(out.threads.get("r1")?.lastOutbound).toBe("Still own the place?");
    expect(out.threads.has("r2")).toBe(false); // the other org's reply is a missing row (retried), never shown
    const msgQueries = log.filter((l) => l.table === "messages");
    expect(msgQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of msgQueries) expect(q.ops).toContainEqual({ k: "eq", col: "org_id", v: "org" });
  });
});
