import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Routing v2 cutover (b): the seller-reply consumer, mocked (no database). The SQL claim /
 * authorize / provider-check / sent bookkeeping is proven by the 330000 DB suite; outbox.ts's
 * ordering (never retry an unknown outcome) by outbox.test.ts.
 */
const h = vi.hoisted(() => ({ reply: vi.fn(), send: vi.fn(), closed: false }));
vi.mock("@/lib/sms-classification/routing-v2/reply-template", () => ({ resolveV2Reply: h.reply }));
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: h.send }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => (h.closed ? { ok: false, reason: "outside_window", state: "MO", localTime: "22:00" } : { ok: true, state: "MO", localTime: "12:00", florida: false }),
}));

import { deliverRoutingV2OutboxReply, isOwnOlderAutoReplyOnly, isV2MechanicsNoOpReason, isV2SupersededReason, ROUTING_V2_REPLY_MAX_AGE_MS, routingV2OutboxHoldReason, runRoutingV2OutboxReplies } from "./dispatch";

const ROW = {
  id: "0b8f3c1e-6a2b-4c3d-8e4f-5a6b7c8d9e0f", org_id: "org1", property_id: "p1", inbound_message_id: "in1",
  kind: "reply" as const, payload: { key: "where_located" }, created_at: new Date().toISOString(),
};

function fakeSupabase(rpc: Record<string, unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; values: unknown }> = [];
  const chain = (table: string) => {
    const rows = table === "messages" ? [{ contact_id: "c1", conversation_id: "conv1", from_address: "+18165550100", to_address: "+18165550199", body: "Where are you?" }]
      : table === "ai_responder_configs" ? [{ model: "m", outbound_mode: "automatic" }]
      : table === "properties" ? [{ id: "p1" }] : [];
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "ilike", "gte", "gt", "lt", "lte", "order", "limit", "insert", "upsert", "delete", "contains", "filter", "match", "range"]) c[m] = () => c;
    c.update = (values: unknown) => { updates.push({ table, values }); return c; };
    c.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    c.single = async () => ({ data: rows[0] ?? null, error: null });
    // List reads (repeat-text guard, turn count) see no prior outbound texts.
    c.then = (res: (v: unknown) => unknown) => res({ data: table === "messages" ? [] : rows, error: null });
    return c;
  };
  const client = {
    from: (t: string) => chain(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: name in rpc ? rpc[name] : null, error: null };
    },
  };
  return { client: client as never, calls, updates };
}
const names = (calls: Array<{ name: string }>) => calls.map((c) => c.name).filter((n) => n.startsWith("routing_v2_"));

beforeEach(() => {
  h.reply.mockReset(); h.send.mockReset(); h.closed = false;
  h.reply.mockResolvedValue({ kind: "ready", body: "We're based in the Kansas City metro, but we buy properties throughout the Midwest.", source: "x", templateId: "t1", fixed: false });
});

describe("routing v2 outbox reply consumer", () => {
  it("quiet hours: waits BEFORE any claim (no claim, no send)", async () => {
    h.closed = true;
    const { client, calls } = fakeSupabase({});
    expect(await deliverRoutingV2OutboxReply(client, ROW)).toMatchObject({ kind: "waiting" });
    expect(names(calls)).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a superseded / taken-over row refused at claim: nothing sent, no hold", async () => {
    const { client, calls, updates } = fakeSupabase({ routing_v2_claim_outbox: "superseded" });
    expect(await deliverRoutingV2OutboxReply(client, ROW)).toEqual({ kind: "skipped", reason: "superseded" });
    expect(names(calls)).toEqual(["routing_v2_claim_outbox"]);
    expect(h.send).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("a slice switched off at authorize: nothing sent, inbound back to the human queue (§13.3)", async () => {
    const { client, calls, updates } = fakeSupabase({ routing_v2_claim_outbox: "ok", routing_v2_authorize_outbox_send: "flag_off" });
    expect(await deliverRoutingV2OutboxReply(client, ROW)).toEqual({ kind: "skipped", reason: "flag_off" });
    expect(names(calls)).toEqual(["routing_v2_claim_outbox", "routing_v2_authorize_outbox_send"]);
    expect(h.send).not.toHaveBeenCalled();
    expect(JSON.stringify(updates)).toContain("needs_reply");
  });

  it("an authorization whose answer was lost goes to reconcile, never to the provider", async () => {
    const { client } = fakeSupabase({ routing_v2_claim_outbox: "ok" });
    (client as unknown as { rpc: unknown }).rpc = async (name: string) =>
      name === "routing_v2_authorize_outbox_send" ? { data: null, error: { message: "timeout" } } : { data: name === "routing_v2_claim_outbox" ? "ok" : "ok", error: null };
    expect(await deliverRoutingV2OutboxReply(client, ROW)).toEqual({ kind: "reconcile", reason: "authorization_unknown" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("a reply that is not approved / not ready is cancelled before any claim and a person looks", async () => {
    h.reply.mockResolvedValue({ kind: "none", reason: "reply_text_not_approved" });
    const { client, calls, updates } = fakeSupabase({ routing_v2_mark_outbox_not_sent: "ok" });
    expect(await deliverRoutingV2OutboxReply(client, ROW)).toEqual({ kind: "skipped", reason: "reply_text_not_approved" });
    expect(names(calls)).toEqual(["routing_v2_mark_outbox_not_sent"]);
    expect(JSON.stringify(updates)).toContain("nine_reply_not_sent:reply_text_not_approved");
  });

  it("an old queued reply is never sent late", async () => {
    const { client, calls } = fakeSupabase({ routing_v2_mark_outbox_not_sent: "ok" });
    const old = { ...ROW, created_at: new Date(Date.now() - ROUTING_V2_REPLY_MAX_AGE_MS - 1000).toISOString() };
    expect(await deliverRoutingV2OutboxReply(client, old)).toEqual({ kind: "skipped", reason: "expired" });
    expect(names(calls)).toEqual(["routing_v2_mark_outbox_not_sent"]);
    expect(h.reply).not.toHaveBeenCalled();
  });

  it("alerts are not delivered here", async () => {
    expect(await deliverRoutingV2OutboxReply(fakeSupabase({}).client, { ...ROW, kind: "alert" })).toEqual({ kind: "skipped", reason: "not_a_reply" });
  });

  it("a not-sent refusal holds ONLY when this call cancelled the row (review N2)", async () => {
    h.reply.mockResolvedValue({ kind: "none", reason: "reply_text_not_approved" });
    const { client, updates } = fakeSupabase({ routing_v2_mark_outbox_not_sent: "already_sent" });
    expect(await deliverRoutingV2OutboxReply(client, ROW)).toEqual({ kind: "skipped", reason: "reply_text_not_approved" });
    expect(updates).toEqual([]);
  });
});

describe("stress A-2 round 2: an overtaken reply is not a failure", () => {
  it("only the send gate's supersession reasons skip the hold (and only with a newer seller text: E2E)", () => {
    expect(isV2SupersededReason("superseded_before_send")).toBe(true);
    expect(isV2SupersededReason("superseded_by_newer_inbound")).toBe(true);
    for (const r of ["superseded_by_broadcast", "provider_failed", "test_send_refused", "flag_off", "send_lease_lost"]) {
      expect(isV2SupersededReason(r)).toBe(false);
    }
  });
});

describe("A-2 consolidated fix: mechanics no-ops and rule 3 (C1, C3)", () => {
  it("C1: only the mechanics reasons are no-ops (a lookup failure still holds)", () => {
    for (const r of ["template_already_sent", "nine_window_closed", "nine_window_closed_at_fence", "v2_older_auto_reply_sent"]) expect(isV2MechanicsNoOpReason(r)).toBe(true);
    for (const r of ["template_already_sent:lookup_failed", "reply_text_not_approved", "already_answered", "superseded_before_send", "send_check_failed", "test_send_refused"]) expect(isV2MechanicsNoOpReason(r)).toBe(false);
  });
  it("C3: quiet cancel only when OUR OWN older auto reply is the only rule-3 trigger; a person's text keeps the flag", () => {
    const r3 = (triggers?: Array<"ai_other_inbound" | "human_unrelated">) => ({ action: "skip" as const, flag: true as const, rule: 3 as const, reason: "unrelated_conversational_text" as const, triggers });
    expect(isOwnOlderAutoReplyOnly(r3(["ai_other_inbound"]))).toBe(true);
    expect(isOwnOlderAutoReplyOnly(r3(["human_unrelated"]))).toBe(false);
    expect(isOwnOlderAutoReplyOnly(r3(["ai_other_inbound", "human_unrelated"]))).toBe(false);
    expect(isOwnOlderAutoReplyOnly(r3(undefined))).toBe(false);
    expect(isOwnOlderAutoReplyOnly({ action: "skip", flag: true, rule: 1, reason: "newer_inbound_unhandled" })).toBe(false);
  });
});

describe("routing v2 outbox recovery (review B1)", () => {
  it("maps every cancelled-before-the-seller reason to today's hold family", () => {
    expect(routingV2OutboxHoldReason("not_sent:no_message_row")).toBe("nine_reply_not_sent:no_message_row");
    expect(routingV2OutboxHoldReason("not_sent:provider_failed")).toBe("nine_reply_not_sent:provider_failed");
    expect(routingV2OutboxHoldReason("unknown:held_for_person")).toBe("nine_reply_not_sent:send_outcome_unknown");
  });
  it("writes the hold for each reply the seller did not get, then clears its marker", async () => {
    const { client, calls, updates } = fakeSupabase({
      routing_v2_release_stale_outbox_claims: 0,
      routing_v2_reconcile_outbox: { never_submitted: 1 },
      routing_v2_outbox_holds_due: [{ outbox_id: "o9", property_id: "p9", reason: "not_sent:no_message_row" }],
      routing_v2_mark_outbox_hold_written: "ok",
      routing_v2_due_outbox_replies: [],
    });
    const r = await runRoutingV2OutboxReplies(client);
    expect(r.held).toBe(1);
    expect(JSON.stringify(updates)).toContain("nine_reply_not_sent:no_message_row");
    const names = calls.map((c) => c.name);
    expect(names.indexOf("routing_v2_mark_outbox_hold_written")).toBeGreaterThan(names.indexOf("routing_v2_outbox_holds_due"));
    expect(calls.find((c) => c.name === "routing_v2_reconcile_outbox")?.args).toEqual({ p_older_than_seconds: 180, p_unknown_hold_minutes: 30 });
  });
  it("time budget: no new claim once over it", async () => {
    let t = 0;
    const rows = [ROW, { ...ROW, id: "1b8f3c1e-6a2b-4c3d-8e4f-5a6b7c8d9e0f" }];
    const { client, calls } = fakeSupabase({ routing_v2_due_outbox_replies: rows, routing_v2_claim_outbox: "superseded" });
    const r = await runRoutingV2OutboxReplies(client, { propertyId: "p1", budgetMs: 45_000, now: () => (t += 30_000) });
    expect(r.results).toHaveLength(1);
    expect(calls.filter((c) => c.name === "routing_v2_claim_outbox")).toHaveLength(1);
  });
});
