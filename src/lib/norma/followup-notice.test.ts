import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { drainNormaFollowupNotices, buildNormaFollowupBlocks } from "./followup-notice";
import { NORMA_NOTIFICATION_LEASE_MS, NORMA_NOTIFICATION_MAX_ATTEMPTS } from "./slack-worker";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

type Row = Record<string, unknown>;
const NOW = Date.parse("2026-10-09T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** Reads `a->b->>c` paths the way PostgREST does. */
function pathValue(row: Row, col: string): unknown {
  const [head, ...rest] = col.split(/->>?/);
  let v: unknown = row[head!];
  for (const key of rest) v = v && typeof v === "object" ? (v as Row)[key] : undefined;
  return v;
}

/** In-memory double with the filter surface the worker uses; every write lands only in the table it names. */
function makeClient(tables: Record<string, Row[] | "absent">, hooks: { beforeWrite?: () => void } = {}) {
  const writes: { table: string; values: Row }[] = [];
  function from(table: string) {
    const source = tables[table];
    // Filters run when the statement executes (not when it is built), like Postgres re-checking a row after waiting for its lock.
    const filters: ((r: Row) => boolean)[] = [];
    let sorter: ((a: Row, b: Row) => number) | null = null;
    let max = Infinity;
    let pending: Row | null = null;
    const run = () => {
      let rows: Row[] = source === "absent" ? [] : (source ?? []);
      rows = rows.filter((r) => filters.every((f) => f(r)));
      if (sorter) rows = [...rows].sort(sorter);
      return rows.slice(0, max);
    };
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => (filters.push((r) => pathValue(r, col) === val), api),
      is: (col: string, val: null) => (filters.push((r) => (pathValue(r, col) ?? null) === val), api),
      order: (col: string, o?: { ascending?: boolean }) => ((sorter = (a, b) => String(a[col]).localeCompare(String(b[col])) * (o?.ascending === false ? -1 : 1)), api),
      limit: (n: number) => ((max = n), api),
      update: (values: Row) => ((pending = values), api),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (source === "absent") return resolve({ data: null, error: { code: "42P01", message: `relation "${table}" does not exist` } });
        const rows = run();
        if (pending) {
          hooks.beforeWrite?.();
          // The hook may change a row between the statement being issued and applied; re-check, as Postgres does.
          const still = rows.filter((r) => filters.every((f) => f(r)));
          writes.push({ table, values: pending });
          for (const row of still) Object.assign(row, pending);
          return resolve({ data: still.map((r) => ({ id: r.id })), error: null });
        }
        return resolve({ data: rows, error: null });
      },
    };
    return api;
  }
  return { client: { from } as unknown as SupabaseClient, writes, tables };
}

const reassignment = (o: Row = {}): Row => ({
  id: "f1", org_id: "o1", request_id: "r1", property_id: "p1", kind: "callback_task", status: "open",
  payload: { title: "Call seller back" }, created_at: iso(NOW - 60_000), ...o,
});
const world = (rows: Row[]) => ({
  norma_followup_reassignments: rows,
  properties: [{ id: "p1", org_id: "o1", address: "12 Oak St", city: "KC", state: "MO", homeowner_contact_id: "c1" }],
  contacts: [{ id: "c1", org_id: "o1", contact_type: "person", first_name: "Pat", last_name: "Seller", entity_name: null }],
});
const poster = () => {
  const posts: { blocks: unknown[]; text: string }[] = [];
  return { posts, post: vi.fn(async (m: { blocks: unknown[]; text: string }) => (posts.push(m), { ts: `17.${posts.length}` })) };
};
let n = 0;
const tok = () => `t${++n}`;
const notice = (row: Row) => (row.payload as Row).slack_notice as Row | undefined;

describe("drainNormaFollowupNotices", () => {
  it("is a silent no-op while the reassignment table does not exist", async () => {
    const { client, writes } = makeClient({ norma_followup_reassignments: "absent" });
    const { post } = poster();
    const summary = await drainNormaFollowupNotices({ client, post, now: NOW });
    expect(summary).toMatchObject({ tableAbsent: true, scanned: 0, sent: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("treats the PostgREST schema-cache miss (PGRST205) as absent too", async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { code: "PGRST205", message: "Could not find the table" } }) }) }) }) }) } as unknown as SupabaseClient;
    const summary = await drainNormaFollowupNotices({ client, post: vi.fn(), now: NOW });
    expect(summary.tableAbsent).toBe(true);
  });

  it("does nothing, and touches nothing, when Slack is not configured", async () => {
    const t = makeClient(world([reassignment()]));
    const summary = await drainNormaFollowupNotices({ client: t.client, post: null, now: NOW });
    expect(summary.configured).toBe(false);
    expect(t.writes).toEqual([]);
  });

  it("posts one notice per row and never again once sent", async () => {
    const t = makeClient(world([reassignment(), reassignment({ id: "f2", request_id: "r2", kind: "review_task", payload: { title: "Norma call needs review: outcome unknown" } })]));
    const { post, posts } = poster();
    const first = await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok });
    expect(first).toMatchObject({ sent: 2, failed: 0 });
    expect(posts.map((p) => p.text)).toEqual(expect.arrayContaining([expect.stringContaining("callback task"), expect.stringContaining("review task")]));
    const rows = t.tables.norma_followup_reassignments as Row[];
    expect(rows.map((r) => notice(r)?.state)).toEqual(["sent", "sent"]);
    const again = await drainNormaFollowupNotices({ client: t.client, post, now: NOW + 3_600_000, newToken: tok });
    expect(again).toMatchObject({ scanned: 0, sent: 0 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("scopes the lookup to the row's org: a property in another org is a failure, not a leak", async () => {
    const t = makeClient({ ...world([reassignment({ org_id: "o2" })]) });
    const { post } = poster();
    const summary = await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok });
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(post).not.toHaveBeenCalled();
  });

  it("retries after a Slack failure with the shared backoff, then sends", async () => {
    const t = makeClient(world([reassignment()]));
    let fail = true;
    const post = vi.fn(async () => {
      if (fail) throw new Error("slack_post_failed:fake_outage");
      return { ts: "9.9" };
    });
    const first = await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok });
    expect(first).toMatchObject({ failed: 1, sent: 0 });
    const row = (t.tables.norma_followup_reassignments as Row[])[0]!;
    expect(notice(row)).toMatchObject({ state: "pending", attempts: 1, last_error: "slack_post_failed:fake_outage" });
    // Not due yet.
    expect(await drainNormaFollowupNotices({ client: t.client, post, now: NOW + 30_000, newToken: tok })).toMatchObject({ scanned: 0 });
    fail = false;
    const later = await drainNormaFollowupNotices({ client: t.client, post, now: NOW + 61_000, newToken: tok });
    expect(later).toMatchObject({ sent: 1 });
    expect(notice(row)).toMatchObject({ state: "sent", attempts: 2, slack_ts: "9.9" });
  });

  it("gives up after the maximum attempts and reports it", async () => {
    const t = makeClient(world([reassignment()]));
    const post = vi.fn(async () => {
      throw new Error("down");
    });
    let now = NOW;
    let last = { gaveUp: 0 };
    for (let i = 0; i < NORMA_NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      last = await drainNormaFollowupNotices({ client: t.client, post, now, newToken: tok });
      now += 7 * 3_600_000;
    }
    expect(last.gaveUp).toBe(1);
    expect(notice((t.tables.norma_followup_reassignments as Row[])[0]!)?.state).toBe("gave_up");
    expect((await drainNormaFollowupNotices({ client: t.client, post, now, newToken: tok })).scanned).toBe(0);
  });

  it("an expired lease from a dead sweep is picked up; a live lease is respected", async () => {
    const live = reassignment({ payload: { title: "x", slack_notice: { state: "leased", lease_token: "dead", lease_until: iso(NOW + 60_000), attempts: 0 } } });
    const t = makeClient(world([live]));
    const { post } = poster();
    expect(await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok })).toMatchObject({ scanned: 0 });
    expect(await drainNormaFollowupNotices({ client: t.client, post, now: NOW + NORMA_NOTIFICATION_LEASE_MS + 1, newToken: tok })).toMatchObject({ sent: 1 });
  });

  it("two sweeps racing for the same row post it once (the loser's swap matches nothing)", async () => {
    const t = makeClient(world([reassignment()]));
    const { post, posts } = poster();
    // Both sweeps read the row before either writes, so they hold the same "absent" notice.
    const [a, b] = await Promise.all([
      drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: () => "A" }),
      drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: () => "B" }),
    ]);
    expect(posts).toHaveLength(1);
    expect(a.sent + b.sent).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
  });

  it("a callback that supersedes an unsent review notice leaves exactly one notice, the callback's", async () => {
    const t = makeClient(world([reassignment({ kind: "review_task", payload: { title: "Norma call needs review: outcome unknown" } })]));
    const rows = t.tables.norma_followup_reassignments as Row[];
    // The SQL upgrade lands between the sweep's read and its first write: kind and payload change in place.
    const { post, posts } = poster();
    let superseded = false;
    const racing = makeClient(world(rows), {
      beforeWrite: () => {
        if (superseded) return;
        superseded = true;
        Object.assign(rows[0]!, { kind: "callback_task", payload: { title: "Call seller back", outcome: "callback_requested" } });
      },
    });
    const first = await drainNormaFollowupNotices({ client: racing.client, post, now: NOW, newToken: tok });
    expect(first.skipped).toBe(1);
    expect(posts).toHaveLength(0);
    const second = await drainNormaFollowupNotices({ client: racing.client, post, now: NOW, newToken: tok });
    expect(second.sent).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("callback task");
    expect((await drainNormaFollowupNotices({ client: racing.client, post, now: NOW + 1, newToken: tok })).scanned).toBe(0);
  });

  it("a callback that supersedes an already-sent review notice gets its own fresh notice", async () => {
    const t = makeClient(world([reassignment({ kind: "review_task", payload: { title: "r" } })]));
    const { post, posts } = poster();
    await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok });
    const row = (t.tables.norma_followup_reassignments as Row[])[0]!;
    expect(notice(row)?.state).toBe("sent");
    // The SQL replaces kind and the whole payload, dropping the old notice marker.
    Object.assign(row, { kind: "callback_task", payload: { title: "Call seller back" } });
    await drainNormaFollowupNotices({ client: t.client, post, now: NOW + 1, newToken: tok });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.text).toContain("review task");
    expect(posts[1]!.text).toContain("callback task");
    expect(notice(row)?.state).toBe("sent");
  });

  it("ignores resolved rows and writes only the reassignment table", async () => {
    const t = makeClient(world([reassignment({ status: "resolved" }), reassignment({ id: "f9", request_id: "r9" })]));
    const { post } = poster();
    await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok });
    expect(post).toHaveBeenCalledTimes(1);
    expect(new Set(t.writes.map((w) => w.table))).toEqual(new Set(["norma_followup_reassignments"]));
  });

  it("a Slack failure leaves the request, task and drip tables untouched", async () => {
    const calls = [{ id: "r1", status: "completed", outcome: "callback_requested" }];
    const t = makeClient({ ...world([reassignment()]), norma_call_requests: calls, tasks: [] });
    const post = vi.fn(async () => {
      throw new Error("down");
    });
    await drainNormaFollowupNotices({ client: t.client, post, now: NOW, newToken: tok });
    expect(calls).toEqual([{ id: "r1", status: "completed", outcome: "callback_requested" }]);
    expect(t.writes.every((w) => w.table === "norma_followup_reassignments")).toBe(true);
  });
});

describe("buildNormaFollowupBlocks", () => {
  it("uses neutral, factual wording and escapes seller text", () => {
    const m = buildNormaFollowupBlocks({ kind: "callback_task", sellerName: "A <b>", propertyAddress: "1 St", title: "T & U", deepLink: "https://x/leads/1" });
    expect(JSON.stringify(m.blocks)).toContain("A &lt;b&gt;");
    expect(JSON.stringify(m.blocks)).toContain("T &amp; U");
    expect(m.text).toBe("Norma callback task needs a new owner (1 St)");
  });
});
