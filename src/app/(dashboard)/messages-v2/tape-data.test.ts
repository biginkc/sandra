import { describe, expect, it } from "vitest";

import type { LooseSupabase } from "./queries";
import { fakePostgrest } from "./fake-postgrest.test-util";
import { chicagoDayKey, chicagoDayWindow, isOlderThanCursor, loadRunThreads, loadRunsWindow, olderThanCursorFilter, parseRunCursor, previousDayKey, type RunCursor } from "./tape-data";

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

  it("never skips runs that share a timestamp at the page edge", () => {
    // 7 runs: 3 share the edge timestamp. Page size 3, ordered (started_at, id) descending.
    const rows = [
      { id: id(9), started_at: "2026-10-14T12:05:00.000Z" },
      { id: id(8), started_at: "2026-10-14T12:04:00.000Z" },
      { id: id(7), started_at: t },
      { id: id(6), started_at: t },
      { id: id(5), started_at: t },
      { id: id(4), started_at: "2026-10-14T11:59:00.000Z" },
      { id: id(3), started_at: "2026-10-14T11:58:00.000Z" },
    ];
    const ordered = [...rows].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || (a.id < b.id ? 1 : -1));
    const seen: string[] = [];
    let cursor: RunCursor | null = null;
    for (;;) {
      const page: typeof rows = ordered.filter((r) => !cursor || isOlderThanCursor(r, cursor)).slice(0, 3);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      const last = page[page.length - 1];
      cursor = { at: last.started_at, id: last.id };
    }
    expect(seen).toEqual(ordered.map((r) => r.id)); // every run exactly once, including both runs sharing the edge timestamp
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
        let out = rows.filter((r) => eqs.every(([c, v]) => r[c] === v) && (!ids || ids.includes(r.id)));
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
        { id: "out-reply", body: "Thanks, take care.", conversation_id: "c1", direction: "outbound", created_at: "2026-10-14T12:10:00Z" },
        { id: "m1", conversation_id: "c1", body: "newer than the run", created_at: "2026-10-14T13:00:00Z", direction: "outbound" },
        { id: "m2", conversation_id: "c1", body: "Still own the place?", created_at: "2026-10-14T11:00:00Z", direction: "outbound" },
        { id: "m3", conversation_id: "c1", body: "older", created_at: "2026-10-13T11:00:00Z", direction: "outbound" },
      ]),
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
    const out = await loadRunThreads(fakeMessages(rows), [
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
    const out = await loadRunThreads(client, [{ id: "r1", conversation_id: "c1", outbound_message_id: null, started_at: "2026-10-14T12:00:00Z" }]);
    expect(out.failedRunIds).toEqual(["r1"]);
    expect(out.threads.has("r1")).toBe(false);
  });

  it("a conversation with 2,000 outbound texts still yields its last outbound before the run", async () => {
    const msgs = Array.from({ length: 2000 }, (_, i) => ({
      id: `m${String(i).padStart(5, "0")}`, conversation_id: "c1", direction: "outbound", body: `t${i}`,
      created_at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString(),
    }));
    const { client } = fakePostgrest({ messages: msgs }, { cap: 1000 });
    const out = await loadRunThreads(client, [{ id: "r1", conversation_id: "c1", outbound_message_id: null, started_at: "2026-10-03T00:00:00.000Z" }]);
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
    const last = first.runs[first.runs.length - 1];
    const second = await loadRunsWindow(client, "org", from, to, { at: last.started_at, id: last.id });
    const all = [...first.runs, ...second.runs].map((r) => r.id);
    expect(new Set(all).size).toBe(205);
  });
});

describe("I7 Chicago times do not depend on the machine's zone", () => {
  it("renders the same under TZ=UTC and TZ=Asia/Tokyo", async () => {
    const { chicagoClock, chicagoDateClock } = await import("./chicago-time");
    const prev = process.env.TZ;
    const at = "2026-10-15T00:30:00.000Z";
    process.env.TZ = "UTC";
    const utc = [chicagoClock(at), chicagoDateClock(at), chicagoDayKey(Date.parse(at))];
    process.env.TZ = "Asia/Tokyo";
    const tokyo = [chicagoClock(at), chicagoDateClock(at), chicagoDayKey(Date.parse(at))];
    process.env.TZ = prev;
    expect(utc).toEqual(["7:30 PM", "Oct 14, 7:30 PM", "2026-10-14"]);
    expect(tokyo).toEqual(utc);
  });
});
