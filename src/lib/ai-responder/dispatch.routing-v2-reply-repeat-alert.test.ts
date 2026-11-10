import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
// Drive the real notSent hook with a chosen cancel reason (the suppression decision itself is
// covered elsewhere): the outbox driver calls notSent(intent, reason) exactly as it would.
const notSentReason = { value: "template_already_sent" };
vi.mock("@/lib/sms-classification/routing-v2/outbox", () => ({
  deliverV2Outbox: async (intent: unknown, hooks: { notSent: (i: unknown, r: string) => Promise<void> }) => {
    if (!notSentReason.value) return { kind: "sent" };
    await hooks.notSent(intent, notSentReason.value);
    return { kind: "refused", reason: notSentReason.value };
  },
}));

import { V2_ALERT_LABELS } from "@/lib/sms-classification/routing-v2/actions";
import { deliverRoutingV2OutboxReply, enqueueV2ReplyRepeatAlert, v2ReplyRepeatAlertKey } from "./dispatch";

/** Synthetic rows only. */
function fake(markResult: string, opts: { existing?: unknown[]; inbound?: string; dripActive?: boolean } = {}) {
  const calls: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const store: Array<Record<string, unknown>> = [];
  const inbound = opts.inbound ?? "in1";
  const chain = (table: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "order", "update", "gte"]) c[m] = () => c;
    c.maybeSingle = async () => ({
      data: table === "routing_v2_outbox" ? { org_id: "org1", property_id: "p1", inbound_message_id: inbound, transition_seq: 4, kind: "reply" } : null,
      error: null,
    });
    c.limit = async () => ({ data: table === "routing_v2_outbox" ? [...(opts.existing ?? []), ...store] : opts.dripActive ? [{ id: "e1" }] : [], error: null });
    c.insert = async (row: Record<string, unknown>) => (inserts.push(row), store.push(row), { error: null });
    c.then = (res: (v: unknown) => unknown) => res({ data: opts.dripActive ? [{ id: "e1" }] : [], error: null });
    return c;
  };
  const client = {
    from: (t: string) => chain(t),
    rpc: async (name: string) => (calls.push(name), { data: name === "routing_v2_mark_outbox_not_sent" ? markResult : name === "routing_v2_write_hold" ? "held" : "ok", error: null }),
  };
  return { client: client as never, calls, inserts };
}
const row = (inbound = "in1") => ({ id: `box-${inbound}`, org_id: "org1", property_id: "p1", inbound_message_id: inbound, kind: "reply" as const, payload: { key: "book_appointment" }, created_at: new Date().toISOString() });

describe("reply_repeat owner alert (Jarrad 2026-11-08)", () => {
  it("label is registered, so loadV2OutboxAlerts delivers it", () => {
    expect(V2_ALERT_LABELS.reply_repeat).toBe("Seller texted again — same reply already sent, needs a person");
  });

  it("same seller repeats a yes: suppression kept (no hold, no send) + one alert, never time-only gated", async () => {
    notSentReason.value = "template_already_sent";
    const f = fake("ok_no_hold");
    expect(await deliverRoutingV2OutboxReply(f.client, row())).toEqual({ kind: "refused", reason: "template_already_sent" });
    expect(f.calls).not.toContain("routing_v2_write_hold");
    expect(f.inserts).toEqual([{
      org_id: "org1", property_id: "p1", inbound_message_id: "in1", transition_seq: 4, kind: "alert", engine: "v2", slice: "replies",
      payload: { reason: "reply_repeat", label: V2_ALERT_LABELS.reply_repeat, dedupe_key: "routing_v2:in1:reply_repeat", when_time_only_off: false },
    }]);
  });

  it("second contact on the same property (its own inbound): its own alert", async () => {
    notSentReason.value = "template_already_sent";
    const f = fake("ok_no_hold", { inbound: "in2" });
    await deliverRoutingV2OutboxReply(f.client, row("in2"));
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0]!.payload).toMatchObject({ reason: "reply_repeat", dedupe_key: v2ReplyRepeatAlertKey("in2") });
  });

  it("legacy DB body (plain ok) with the drip running: same alert, no hold", async () => {
    notSentReason.value = "template_already_sent";
    const f = fake("ok", { dripActive: true });
    await deliverRoutingV2OutboxReply(f.client, row());
    expect(f.calls).not.toContain("routing_v2_write_hold");
    expect(f.inserts.map((r) => (r.payload as { reason: string }).reason)).toEqual(["reply_repeat"]);
  });

  it("other no-hold cancels (superseded by a newer text, closed window) queue no reply_repeat alert", async () => {
    for (const reason of ["superseded_by_newer_inbound", "nine_window_closed"]) {
      notSentReason.value = reason;
      const f = fake("ok_no_hold");
      await deliverRoutingV2OutboxReply(f.client, row());
      expect(f.inserts).toEqual([]);
    }
  });

  it("a normal reply that was sent never queues the alert (the hook is not reached)", async () => {
    notSentReason.value = "";
    const f = fake("ok_no_hold");
    expect(await deliverRoutingV2OutboxReply(f.client, row())).toEqual({ kind: "sent" });
    expect(f.inserts).toEqual([]);
  });

  it("dedupe per inbound: a second enqueue for the same inbound is 'exists'", async () => {
    const f = fake("ok_no_hold");
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("queued");
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("exists");
    expect(f.inserts).toHaveLength(1);
    expect(v2ReplyRepeatAlertKey("in1")).not.toMatch(/^hot_text/);
  });
});

/**
 * Alert-noise F1 + F3b (2026-11-10). Synthetic rows only. `others` = the alert rows already on the
 * inbound (the coverage lookup); `flags` = the org's routing_v2_flags row (undefined = read error).
 */
const P = "11111111-1111-4111-8111-111111111111";
const FLAGS_BASE = { questions_live: true, replies: true, drips: true, canary_property_ids: [P] };
function cov(opts: { key?: string; others?: unknown[]; othersError?: boolean; flags?: Record<string, unknown> | "error" } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  let flagReads = 0;
  const client = {
    from: (table: string) => {
      const eqs: string[] = [];
      const c: Record<string, unknown> = {};
      c.select = () => c;
      c.eq = (k: string) => (eqs.push(k), c);
      c.maybeSingle = async () => {
        if (table === "ai_responder_configs") {
          flagReads++;
          return opts.flags === "error" ? { data: null, error: { message: "flags down" } } : { data: { routing_v2_flags: opts.flags ?? {} }, error: null };
        }
        return { data: { org_id: "org1", property_id: P, inbound_message_id: "in1", transition_seq: 4, kind: "reply", payload: { key: opts.key ?? "said_yes" } }, error: null };
      };
      c.limit = async () => eqs.includes("payload->>dedupe_key")
        ? { data: [], error: null }
        : opts.othersError ? { data: null, error: { message: "lookup down" } } : { data: opts.others ?? [], error: null };
      c.insert = async (row: Record<string, unknown>) => (inserts.push(row), { error: null });
      return c;
    },
  };
  return { client: client as never, inserts, flagReads: () => flagReads };
}
const hotYes = (status: string, conditional: boolean) => ({ id: "a1", status, payload: { reason: "hot_yes", dedupe_key: "hot_text:in1", when_time_only_off: conditional } });

describe("F1: a repeated no does not alert", () => {
  it("not_interested repeat: no reply_repeat queued", async () => {
    const f = cov({ key: "not_interested" });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("skipped");
    expect(f.inserts).toEqual([]);
  });
  it("any other key still queues", async () => {
    const f = cov({ key: "said_yes" });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("queued");
    expect(f.inserts).toHaveLength(1);
  });
});

describe("F3b: reply_repeat is skipped when another alert covers the inbound", () => {
  it("sent other alert covers", async () => {
    const f = cov({ others: [hotYes("sent", true)] });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("skipped");
    expect(f.inserts).toEqual([]);
  });
  it("non-conditional pending/claimed alert covers (no flag read needed)", async () => {
    for (const s of ["pending", "claimed"]) {
      const f = cov({ others: [hotYes(s, false)], flags: "error" });
      expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("skipped");
      expect(f.inserts).toEqual([]);
    }
  });
  it("repeated yes, time-only OFF: the conditional hot_yes covers", async () => {
    const f = cov({ others: [hotYes("pending", true)], flags: { ...FLAGS_BASE, alert_on_time_only: false } });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("skipped");
    expect(f.inserts).toEqual([]);
  });
  it("repeated yes, time-only ON: hot_yes will be cancelled, so reply_repeat IS queued", async () => {
    const f = cov({ others: [hotYes("pending", true)], flags: { ...FLAGS_BASE, alert_on_time_only: true } });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("queued");
    expect(f.inserts).toHaveLength(1);
  });
  it("a cancelled alert never covers", async () => {
    const f = cov({ others: [hotYes("cancelled", false)] });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("queued");
  });
  it("queued when no other alert", async () => {
    const f = cov();
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("queued");
    expect(f.flagReads()).toBe(0);
  });
  it("coverage lookup error = error, nothing queued", async () => {
    const f = cov({ othersError: true });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("error");
    expect(f.inserts).toEqual([]);
  });
  it("flag read error with a conditional alert = error (never fake coverage)", async () => {
    const f = cov({ others: [hotYes("pending", true)], flags: "error" });
    expect(await enqueueV2ReplyRepeatAlert(f.client, "box-in1")).toBe("error");
    expect(f.inserts).toEqual([]);
  });
});
