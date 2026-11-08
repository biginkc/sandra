import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { deliverRoutingV2OutboxReply, enqueueV2ReplyFailedAlert, runRoutingV2OutboxReplies, v2ReplyFailedAlertKey } from "./dispatch";

/** Synthetic rows only: a queued reply that could not be sent queues one reply_failed owner alert. */
function fake(opts: { src?: Record<string, unknown> | null; existing?: unknown[]; insertError?: string } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const filters: Array<[string, unknown]> = [];
  const src = opts.src === undefined
    ? { org_id: "org1", property_id: "p1", inbound_message_id: "in1", transition_seq: 7, kind: "reply" }
    : opts.src;
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => (filters.push([k, v]), chain);
  chain.maybeSingle = async () => ({ data: src, error: null });
  chain.limit = async () => ({ data: opts.existing ?? [], error: null });
  chain.insert = async (row: Record<string, unknown>) => (inserts.push(row), { error: opts.insertError ? { message: opts.insertError } : null });
  return { client: { from: () => chain } as never, inserts, filters };
}

describe("enqueueV2ReplyFailedAlert", () => {
  it("queues one alert row on the failed reply's transition, never time-only gated, own dedupe key", async () => {
    const f = fake();
    expect(await enqueueV2ReplyFailedAlert(f.client, "box1")).toBe("queued");
    expect(f.inserts).toEqual([{
      org_id: "org1", property_id: "p1", inbound_message_id: "in1", transition_seq: 7, kind: "alert", engine: "v2", slice: "replies",
      payload: { reason: "reply_failed", label: "Reply could not be sent — needs a person", dedupe_key: "routing_v2:in1:reply_failed", when_time_only_off: false },
    }]);
    expect(v2ReplyFailedAlertKey("in1")).not.toMatch(/^hot_text/);
  });

  it("idempotent: an existing reply_failed alert for the inbound is not queued again", async () => {
    const f = fake({ existing: [{ id: "a1" }] });
    expect(await enqueueV2ReplyFailedAlert(f.client, "box1")).toBe("exists");
    expect(f.inserts).toEqual([]);
    expect(f.filters).toContainEqual(["payload->>dedupe_key", "routing_v2:in1:reply_failed"]);
  });

  it("only for reply rows; a missing row is skipped", async () => {
    expect(await enqueueV2ReplyFailedAlert(fake({ src: { org_id: "o", property_id: "p", inbound_message_id: "i", transition_seq: 1, kind: "alert" } }).client, "b")).toBe("skipped");
    expect(await enqueueV2ReplyFailedAlert(fake({ src: null }).client, "b")).toBe("skipped");
  });

  it("an insert error is reported, never thrown", async () => {
    expect(await enqueueV2ReplyFailedAlert(fake({ insertError: "boom" }).client, "b")).toBe("error");
  });
});

/**
 * Production callers (Astra review of 0e561aac6): a failed enqueue keeps the retry obligation
 * (hold_pending stays set: no routing_v2_mark_outbox_hold_written) until the alert is queued.
 */
describe("reply_failed alert through the production callers", () => {
  const REPLY = { id: "box1", org_id: "org1", property_id: "p1", inbound_message_id: "in1", kind: "reply" as const, payload: {}, created_at: new Date().toISOString() };
  function prodFake(rpc: Record<string, unknown>, insertFails: { n: number }) {
    const calls: string[] = [];
    const inserts: Array<Record<string, unknown>> = [];
    const chain = (table: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "order", "update", "limit"]) c[m] = () => c;
      c.maybeSingle = async () => ({
        data: table === "routing_v2_outbox"
          ? { org_id: "org1", property_id: "p1", inbound_message_id: "in1", transition_seq: 3, kind: "reply" }
          : null,
        error: null,
      });
      c.insert = async (row: Record<string, unknown>) => {
        if (insertFails.n > 0) { insertFails.n--; return { error: { message: "transient" } }; }
        inserts.push(row);
        return { error: null };
      };
      c.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
      return c;
    };
    const client = {
      from: (t: string) => chain(t),
      rpc: async (name: string) => (calls.push(name), { data: name in rpc ? rpc[name] : null, error: null }),
    };
    return { client: client as never, calls, inserts };
  }

  it("dispatch-time (expired reply -> notSent -> holdFor): first enqueue fails = marker kept; cron sweep then queues and clears", async () => {
    const fails = { n: 1 };
    const f = prodFake({
      routing_v2_outbox_expired: true, routing_v2_mark_outbox_not_sent: "ok", routing_v2_write_hold: "held",
      routing_v2_mark_outbox_hold_written: "ok",
    }, fails);
    expect(await deliverRoutingV2OutboxReply(f.client, REPLY)).toEqual({ kind: "skipped", reason: "expired" });
    expect(f.calls).toContain("routing_v2_write_hold");
    expect(f.calls).not.toContain("routing_v2_mark_outbox_hold_written");
    expect(f.inserts).toEqual([]);

    // Recovery: the row is still hold_pending, so the sweep returns it.
    const g = prodFake({
      routing_v2_release_stale_outbox_claims: 0, routing_v2_reconcile_outbox: {}, routing_v2_write_hold: "already_held",
      routing_v2_outbox_holds_due: [{ outbox_id: "box1", property_id: "p1", reason: "not_sent:expired", attempts: 1 }],
      routing_v2_mark_outbox_hold_written: "ok", routing_v2_due_outbox_replies: [],
    }, fails);
    const r = await runRoutingV2OutboxReplies(g.client);
    expect(r.held).toBe(1);
    expect(g.inserts).toHaveLength(1);
    expect(g.inserts[0]!.payload).toMatchObject({ reason: "reply_failed", dedupe_key: "routing_v2:in1:reply_failed", when_time_only_off: false });
    expect(g.calls.indexOf("routing_v2_mark_outbox_hold_written")).toBeGreaterThan(g.calls.indexOf("routing_v2_write_hold"));
  });

  it("cron sweep: first enqueue fails = marker kept (row stays due); next sweep queues and clears", async () => {
    const fails = { n: 1 };
    const rpc = {
      routing_v2_release_stale_outbox_claims: 0, routing_v2_reconcile_outbox: {}, routing_v2_write_hold: "held",
      routing_v2_outbox_holds_due: [{ outbox_id: "box1", property_id: "p1", reason: "not_sent:no_mapping", attempts: 0 }],
      routing_v2_mark_outbox_hold_written: "ok", routing_v2_due_outbox_replies: [],
    };
    const a = prodFake(rpc, fails);
    expect((await runRoutingV2OutboxReplies(a.client)).held).toBe(0);
    expect(a.calls).not.toContain("routing_v2_mark_outbox_hold_written");
    expect(a.inserts).toEqual([]);
    const b = prodFake(rpc, fails);
    expect((await runRoutingV2OutboxReplies(b.client)).held).toBe(1);
    expect(b.calls).toContain("routing_v2_mark_outbox_hold_written");
    expect(b.inserts).toHaveLength(1);
  });

  it("a superseded hold (newer seller text) queues no alert and clears the marker", async () => {
    const f = prodFake({
      routing_v2_release_stale_outbox_claims: 0, routing_v2_reconcile_outbox: {}, routing_v2_write_hold: "superseded",
      routing_v2_outbox_holds_due: [{ outbox_id: "box1", property_id: "p1", reason: "not_sent:no_mapping" }],
      routing_v2_mark_outbox_hold_written: "ok", routing_v2_due_outbox_replies: [],
    }, { n: 0 });
    await runRoutingV2OutboxReplies(f.client);
    expect(f.inserts).toEqual([]);
    expect(f.calls).toContain("routing_v2_mark_outbox_hold_written");
  });
});
