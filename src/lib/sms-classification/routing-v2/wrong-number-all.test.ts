import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";

import type { FinalDecision } from "./haiku-policy";
import type { V2Decision } from "./route";
import {
  phoneActionCandidate,
  runRoutingV2PhoneAction,
  settleUnsettledRoutingV2PhoneReplies,
  undoRoutingV2PhoneAction,
  WRONG_NUMBER_REPLY_BODY,
  WRONG_NUMBER_REPLY_KEY,
  type RoutingV2PhoneActionDeps,
} from "./wrong-number-all";

const jev = (signal: string, probability: number, road: V2Decision["road"] = "wrong_number_close", haiku: V2Decision["haiku"] = null): V2Decision =>
  ({
    road,
    provenance: { by: "jev", row: "3", step: "wrong", signal, probability },
    haiku,
    opportunityAlert: false,
  }) as V2Decision;
const bounce: V2Decision = { road: "bad_number", provenance: { by: "code", check: "bad_number" }, haiku: null, opportunityAlert: false };
const final = (over: Partial<FinalDecision>): FinalDecision => ({ road: "wrong_number_close", by: "haiku", hold: false, alert: null, failureReason: null, ...over });

describe("phoneActionCandidate (scope)", () => {
  it("wrong person, scope all, Jev ≥0.60 → wrong_number_all", () => {
    expect(phoneActionCandidate(jev("wrong_person", 0.9), "all")).toEqual({ kind: "wrong_number_all", signal: "wrong_person", probability: 0.9 });
    expect(phoneActionCandidate(jev("wrong_person", 0.6), "all").kind).toBe("wrong_number_all");
  });
  it("scope this_property or unknown → nothing (today's path)", () => {
    expect(phoneActionCandidate(jev("wrong_person", 0.95), "this_property")).toEqual({ kind: null, reason: "scope_not_all" });
    expect(phoneActionCandidate(jev("wrong_person", 0.95), null)).toEqual({ kind: null, reason: "scope_not_all" });
  });
  it("already sold / tenant are property-specific → nothing", () => {
    expect(phoneActionCandidate(jev("already_sold", 0.95), "all")).toEqual({ kind: null, reason: "not_wrong_person" });
    expect(phoneActionCandidate(jev("tenant", 0.95), "all")).toEqual({ kind: null, reason: "not_wrong_person" });
  });
  it("below 0.60 → nothing", () => {
    expect(phoneActionCandidate(jev("wrong_person", 0.59), "all")).toEqual({ kind: null, reason: "below_cutoff" });
  });
  it("other roads and no-match → nothing", () => {
    expect(phoneActionCandidate(jev("asked_stop", 0.9, "stop"), "all")).toEqual({ kind: null, reason: "not_wrong_number" });
    const none = { road: null, provenance: { by: "jev", row: null, step: null, signal: null, probability: null }, haiku: "no_match", opportunityAlert: false } as V2Decision;
    expect(phoneActionCandidate(none, "all").kind).toBeNull();
  });
  it("Haiku band: acts only when Haiku confirmed the wrong-number road without a hold", () => {
    const d = jev("wrong_person", 0.65, "wrong_number_close", "decider_band");
    expect(phoneActionCandidate(d, "all")).toEqual({ kind: null, reason: "haiku_pending" });
    expect(phoneActionCandidate(d, "all", final({ road: "not_interested_drip" }))).toEqual({ kind: null, reason: "haiku_not_confirmed" });
    expect(phoneActionCandidate(d, "all", final({ road: null, hold: true, by: "haiku_failed" }))).toEqual({ kind: null, reason: "haiku_not_confirmed" });
    expect(phoneActionCandidate(d, "all", final({ by: "jev_haiku_unsure" })).kind).toBe("wrong_number_all");
  });
  it("ORDER-TABLE band rule: Jev 0.65 + Haiku unsure → Jev's road stands → qualifies; Jev 0.55 + unsure → below 0.60, not", () => {
    const unsure = final({ by: "jev_haiku_unsure", road: "wrong_number_close" });
    expect(phoneActionCandidate(jev("wrong_person", 0.65, "wrong_number_close", "decider_band"), "all", unsure)).toEqual({
      kind: "wrong_number_all", signal: "wrong_person", probability: 0.65,
    });
    expect(phoneActionCandidate(jev("wrong_person", 0.55, "wrong_number_close", "decider_band"), "all", unsure)).toEqual({ kind: null, reason: "below_cutoff" });
  });
  it("no SMS capabilities bounce (code check) → bad_number", () => {
    expect(phoneActionCandidate(bounce, null)).toEqual({ kind: "bad_number", signal: "code:bad_number", probability: null });
  });
});

type Call = { kind: "from" | "rpc"; table?: string; fn?: string; args?: Record<string, unknown>; filters: unknown[] };
type Rpc = (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null };

/** Fake Supabase: config reads (one flag value per read, last repeats), rpc handlers, one action read. */
function fakeDb(opts: { flags?: unknown; flagSeq?: unknown[]; configError?: boolean; rpc?: Record<string, Rpc>; action?: unknown }) {
  const calls: Call[] = [];
  let reads = 0;
  const nextFlags = () => (opts.flagSeq ? opts.flagSeq[Math.min(reads++, opts.flagSeq.length - 1)] : opts.flags);
  // Default reply-state machine: pending -> sending|skipped, sending -> sent|failed|unknown.
  let state = "pending";
  const rpc: Record<string, Rpc> = {
    fn_routing_v2_phone_action_reply: (a) => {
      const to = String(a.p_to);
      const ok = (state === "pending" && (to === "sending" || to === "skipped")) || (state === "sending" && ["sent", "failed", "unknown"].includes(to));
      if (ok) state = to;
      return { data: { ok, replyState: state } };
    },
    fn_routing_v2_phone_action_send_allowed: () => ({ data: true }),
    ...opts.rpc,
  };
  const db = {
    from(table: string) {
      const call: Call = { kind: "from", table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => chain,
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return chain;
        },
        maybeSingle: async () => {
          if (table === "routing_v2_phone_actions") return { data: opts.action ?? null, error: null };
          if (opts.configError) return { data: null, error: { message: "boom" } };
          const f = nextFlags();
          return { data: f === undefined ? null : { routing_v2_flags: f }, error: null };
        },
      };
      return chain;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", fn, args, filters: [] });
      const h = rpc[fn];
      if (!h) return { data: null, error: { message: `unexpected rpc ${fn}` } };
      const r = h(args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  // The provider-boundary gate (send_allowed) is asserted on its own where it matters.
  const rpcs = () => calls.filter((c) => c.kind === "rpc" && c.fn !== "fn_routing_v2_phone_action_send_allowed").map((c) => (c.fn === "fn_routing_v2_phone_action_reply" ? `reply:${c.args?.p_to}` : c.fn));
  return { db: db as never, calls, rpcs, setState: (s: string) => (state = s) };
}

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const P5 = "00000000-0000-4000-8000-000000000005";
const SEND = "11111111-1111-4111-8111-111111111111";
const ON = { questions_live: true, wrong_number_all: true, canary_percent: 100 };
const OFF = { questions_live: true, wrong_number_all: false, canary_percent: 100 };
const input = (over: Partial<Parameters<typeof runRoutingV2PhoneAction>[1]> = {}) => ({
  orgId: "org",
  inboundMessageId: "in-1",
  fromPhone: "(816) 555-0101",
  decision: jev("wrong_person", 0.9),
  wrongScope: "all" as const,
  expectedRevision: 7,
  ...over,
});
type SendFn = RoutingV2PhoneActionDeps["sendWrongNumberReply"];
const deps = (send?: SendFn) => {
  // A well-behaved template step: honors the send-boundary check.
  const fn = vi.fn<SendFn>(
    send ??
      (async (args) =>
        (await args.stillAllowed()) ? { sent: true, outboundMessageId: "out-1" } : { sent: false, reason: "not_allowed_at_send", reachedProvider: false }),
  );
  return { d: { sendWrongNumberReply: fn } as RoutingV2PhoneActionDeps, send: fn };
};

const applied = (over: Record<string, unknown> = {}) => () => ({
  data: { status: "applied", actionId: "a1", sendId: SEND, replyState: "pending", applied: [P1, P2], skipped: [{ propertyId: P5, reason: "other_phones_on_contact" }], propertyIds: [P1, P2, P5], ...over },
});
const replayed = (replyState: string, actionStatus = "applied") => () => ({
  data: { status: "replayed", actionId: "a1", actionStatus, sendId: SEND, replyState, propertyIds: [P1, P2, P5] },
});

describe("runRoutingV2PhoneAction", () => {
  it("flag-off parity: any flag shape other than questions_live + wrong_number_all = one config read, no RPC, no send", async () => {
    for (const flags of [undefined, null, {}, { wrong_number_all: true }, { questions_live: true }, { questions_live: true, wrong_number_all: "true" }, { questions_live: false, wrong_number_all: true }]) {
      const { db, calls } = fakeDb({ flags });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "flag_off" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: "from", table: "ai_responder_configs" });
      expect(send).not.toHaveBeenCalled();
    }
    const { db, calls } = fakeDb({ configError: true });
    expect(await runRoutingV2PhoneAction(db, input(), deps().d)).toEqual({ outcome: "flag_off" });
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("A then B: one atomic apply, then the existing approved reply keyed by the durable send id", async () => {
    const { db, calls, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: applied() } });
    const { d, send } = deps();
    const r = await runRoutingV2PhoneAction(db, input({ expectedRevision: 7 }), d);
    expect(r).toEqual({ outcome: "applied", kind: "wrong_number_all", actionId: "a1", applied: [P1, P2], skipped: [{ propertyId: P5, reason: "other_phones_on_contact" }], replyState: "sent" });
    expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "reply:sending", "reply:sent"]);
    expect(calls.find((c) => c.fn === "fn_routing_v2_phone_action_apply_all")?.args).toMatchObject({
      p_source_inbound_message_id: "in-1", p_action: "wrong_number_all", p_phone: "+18165550101", p_expected_revision: 7,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ templateKey: "wrong_number", requiredBody: APPROVED_REPLY_TEXTS.wrong_number, sendId: SEND });
    expect(calls.filter((c) => c.fn === "fn_routing_v2_phone_action_send_allowed")).toHaveLength(1); // provider-boundary gate consulted
    expect(calls.find((c) => c.args?.p_to === "sent")?.args).toMatchObject({ p_action_id: "a1", p_send_id: SEND, p_message_id: "out-1" });
  });

  describe("post-commit fence (applied + 10 s)", () => {
    it("A leaves the reply awaiting_fence: before fence_at nothing is sent", async () => {
      const { db, rpcs } = fakeDb({
        flags: ON,
        rpc: {
          fn_routing_v2_phone_action_apply_all: applied({ replyState: "awaiting_fence" }),
          fn_routing_v2_phone_action_release_fence: () => ({ data: { replyState: "awaiting_fence", retryAfterSeconds: 9 } }),
        },
      });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: "awaiting_fence" });
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "fn_routing_v2_phone_action_release_fence"]);
    });

    it("fence passed with no newer inbound → released to pending → sent once", async () => {
      const { db, rpcs } = fakeDb({
        flags: ON,
        rpc: {
          fn_routing_v2_phone_action_apply_all: replayed("awaiting_fence"),
          fn_routing_v2_phone_action_release_fence: () => ({ data: { replyState: "pending" } }),
        },
      });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "replayed", replyState: "sent" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "fn_routing_v2_phone_action_release_fence", "reply:sending", "reply:sent"]);
    });

    it("fence found a newer inbound → A auto-undone, reply skipped, nothing sent", async () => {
      const { db, rpcs } = fakeDb({
        flags: ON,
        rpc: {
          fn_routing_v2_phone_action_apply_all: replayed("awaiting_fence"),
          fn_routing_v2_phone_action_release_fence: () => ({ data: { replyState: "skipped", reason: "superseded_after_commit" } }),
        },
      });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "replayed", replyState: "skipped" });
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "fn_routing_v2_phone_action_release_fence"]);
    });
  });

  it("reuses the existing reply text byte-for-byte (no new seller-facing text)", () => {
    expect(WRONG_NUMBER_REPLY_KEY).toBe("wrong_number");
    expect(WRONG_NUMBER_REPLY_BODY).toBe(APPROVED_REPLY_TEXTS.wrong_number);
  });

  it("A returns superseded / not applicable → no reply, nothing else", async () => {
    for (const [status, reason] of [["superseded", "newer_inbound_from_phone"], ["not_applicable", "canary_excluded"], ["not_applicable", "phone_suppressed"], ["not_applicable", "flag_off"]]) {
      const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: () => ({ data: { status, reason } }) } });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: status, reason });
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
    }
  });

  it("global DNC registry: A says suppressed → nothing sent", async () => {
    const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: () => ({ data: { status: "suppressed", reason: "global_dnc_registry" } }) } });
    const { d, send } = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "suppressed", reason: "global_dnc_registry" });
    expect(send).not.toHaveBeenCalled();
    expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
  });

  it("provider-boundary gate refuses when the DB says the phone is suppressed / on the global DNC registry", async () => {
    const { db, calls, rpcs } = fakeDb({
      flags: ON,
      rpc: { fn_routing_v2_phone_action_apply_all: applied(), fn_routing_v2_phone_action_send_allowed: () => ({ data: false }) },
    });
    const { d } = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: "failed" });
    expect(calls.find((c) => c.fn === "fn_routing_v2_phone_action_send_allowed")?.args).toEqual({ p_action_id: "a1" });
    expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "reply:sending", "reply:failed"]);
  });

  it("settle window: A says not_settled → retryable, nothing sent", async () => {
    const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: () => ({ data: { status: "not_settled", reason: "inbound_settle_window", retryAfterSeconds: 12 } }) } });
    const { d, send } = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "not_settled", retryable: true, retryAfterSeconds: 12 });
    expect(send).not.toHaveBeenCalled();
    expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
  });

  it("E: flags/canary off after A committed → reply recorded skipped, nothing sent", async () => {
    for (const later of [OFF, { ...ON, canary_percent: 0 }, { ...ON, canary_property_ids: [P1, "bad"] }, { ...ON, canary_percent: "100" }]) {
      const { db, rpcs } = fakeDb({ flagSeq: [ON, later], rpc: { fn_routing_v2_phone_action_apply_all: applied() } });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: "skipped" });
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "reply:skipped"]);
    }
  });

  it("E at the provider boundary: off after `sending` → template step sends nothing → recorded failed (never reached provider)", async () => {
    const { db, rpcs } = fakeDb({ flagSeq: [ON, ON, OFF], rpc: { fn_routing_v2_phone_action_apply_all: applied() } });
    const { d, send } = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: "failed" });
    expect(await send.mock.results[0].value).toEqual({ sent: false, reason: "not_allowed_at_send", reachedProvider: false });
    expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "reply:sending", "reply:failed"]);
  });

  describe("crash at each boundary", () => {
    it("before / during A: the RPC errored and rolled back → apply_failed (retryable), nothing sent", async () => {
      const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: () => ({ error: { message: "deadlock detected" } }) } });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "apply_failed", retryable: true });
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
    });

    it("between A and the send (reply still pending): the duplicate webhook sends it exactly once", async () => {
      const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: replayed("pending") } });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "replayed", actionId: "a1", actionStatus: "applied", replyState: "sent" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].sendId).toBe(SEND);
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "reply:sending", "reply:sent"]);
    });

    it("during the send (reply `sending`): settled ONLY by send id, never re-sent", async () => {
      for (const found of ["sent", "unknown"]) {
        const { db, calls, rpcs } = fakeDb({
          flags: ON,
          rpc: { fn_routing_v2_phone_action_apply_all: replayed("sending"), fn_routing_v2_phone_action_recover_reply: () => ({ data: { replyState: found, sendId: SEND } }) },
        });
        const { d, send } = deps();
        expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "replayed", replyState: found });
        expect(send).not.toHaveBeenCalled();
        expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "fn_routing_v2_phone_action_recover_reply"]);
        expect(calls[calls.length - 1].args).toEqual({ p_action_id: "a1" });
      }
    });

    it("duplicate webhook inside the provider-timeout lease: recovery leaves it in flight, nothing sent", async () => {
      const { db, rpcs } = fakeDb({
        flags: ON,
        rpc: {
          fn_routing_v2_phone_action_apply_all: replayed("sending"),
          fn_routing_v2_phone_action_recover_reply: () => ({ data: { replyState: "sending", inFlight: true, retryAfterSeconds: 110 } }),
        },
      });
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "replayed", replyState: "sending" });
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "fn_routing_v2_phone_action_recover_reply"]);
    });

    it("the provider call throws: recorded unknown (cannot prove it never reached the provider), never re-sent", async () => {
      const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: applied() } });
      const { d, send } = deps(async () => {
        throw new Error("socket hang up");
      });
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: "unknown" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all", "reply:sending", "reply:unknown"]);
    });

    it("provider rejected after receiving it → unknown; refused before the provider → failed", async () => {
      for (const [reached, expected] of [[true, "unknown"], [false, "failed"]] as const) {
        const { db } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: applied() } });
        const { d } = deps(async () => ({ sent: false, reason: "x", reachedProvider: reached }));
        expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: expected });
      }
    });

    it("after the send (reply final): a duplicate webhook does nothing", async () => {
      for (const st of ["sent", "failed", "unknown", "skipped", "not_needed"]) {
        const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: replayed(st) } });
        const { d, send } = deps();
        expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "replayed", actionId: "a1", actionStatus: "applied", replyState: st });
        expect(send).not.toHaveBeenCalled();
        expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
      }
    });

    it("an undone action's replay never sends its pending reply", async () => {
      const { db, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: replayed("pending", "undone") } });
      const { d, send } = deps();
      expect((await runRoutingV2PhoneAction(db, input(), d)).outcome).toBe("replayed");
      expect(send).not.toHaveBeenCalled();
      expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
    });

    it("another worker already took `sending`: this one sends nothing", async () => {
      const { db, setState } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: applied() } });
      setState("sending");
      const { d, send } = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toMatchObject({ outcome: "applied", replyState: "sending" });
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("settler releases fenced replies, finishes pending ones once and settles sending ones by send id", async () => {
    const { db, rpcs } = fakeDb({
      flags: ON,
      action: { send_id: SEND, property_ids: [P1] },
      rpc: {
        fn_routing_v2_phone_action_unsettled_replies: () => ({
          data: [
            { action_id: "a0", org_id: "org", reply_state: "awaiting_fence" },
            { action_id: "a1", org_id: "org", reply_state: "pending" },
            { action_id: "a2", org_id: "org", reply_state: "sending" },
          ],
        }),
        fn_routing_v2_phone_action_release_fence: () => ({ data: { replyState: "skipped", reason: "superseded_after_commit" } }),
        fn_routing_v2_phone_action_recover_reply: () => ({ data: { replyState: "unknown" } }),
      },
    });
    const { d, send } = deps();
    expect(await settleUnsettledRoutingV2PhoneReplies(db, d)).toEqual([
      { actionId: "a0", replyState: "skipped" },
      { actionId: "a1", replyState: "sent" },
      { actionId: "a2", replyState: "unknown" },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rpcs()).toEqual([
      "fn_routing_v2_phone_action_unsettled_replies", "fn_routing_v2_phone_action_release_fence",
      "reply:sending", "reply:sent", "fn_routing_v2_phone_action_recover_reply",
    ]);
  });

  it("settler builds each row's transport from its own action when given a factory (cutover cron)", async () => {
    const { db } = fakeDb({
      flags: ON,
      action: { send_id: SEND, property_ids: [P1] },
      rpc: {
        fn_routing_v2_phone_action_unsettled_replies: () => ({ data: [{ action_id: "a1", org_id: "org", reply_state: "pending" }] }),
      },
    });
    const { d, send } = deps();
    const factory = vi.fn(async () => d);
    expect(await settleUnsettledRoutingV2PhoneReplies(db, factory)).toEqual([{ actionId: "a1", replyState: "sent" }]);
    expect(factory).toHaveBeenCalledExactlyOnceWith("a1");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("scope this_property never reaches the database", async () => {
    const { db, calls } = fakeDb({ flags: ON });
    expect(await runRoutingV2PhoneAction(db, input({ wrongScope: "this_property" }), deps().d)).toEqual({ outcome: "not_applicable", reason: "scope_not_all" });
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("bounce: bad_number, reply not needed, nothing sent", async () => {
    const { db, calls, rpcs } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_apply_all: applied({ replyState: "not_needed", applied: [P1], skipped: [], propertyIds: [P1] }) } });
    const { d, send } = deps();
    const r = await runRoutingV2PhoneAction(db, input({ decision: bounce, wrongScope: null }), d);
    expect(r).toMatchObject({ outcome: "applied", kind: "bad_number", applied: [P1], replyState: "not_needed" });
    expect(send).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === "fn_routing_v2_phone_action_apply_all")?.args).toMatchObject({ p_action: "bad_number" });
    expect(rpcs()).toEqual(["fn_routing_v2_phone_action_apply_all"]);
  });

  it("expectedRevision is required: missing / null / non-integer → not applicable, no RPC", async () => {
    for (const rev of [undefined, null, Number.NaN, 1.5, "7"]) {
      const { db, calls } = fakeDb({ flags: ON });
      expect(await runRoutingV2PhoneAction(db, input({ expectedRevision: rev as never }), deps().d)).toEqual({ outcome: "not_applicable", reason: "expected_revision_required" });
      expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
    }
  });

  it("unusable phone → not applicable, no RPC", async () => {
    const { db, calls } = fakeDb({ flags: ON });
    expect(await runRoutingV2PhoneAction(db, input({ fromPhone: "123" }), deps().d)).toEqual({ outcome: "not_applicable", reason: "phone_unusable" });
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });
});

describe("undoRoutingV2PhoneAction", () => {
  it("passes through the single undo RPC (restore + resume happen inside it)", async () => {
    const { db, rpcs } = fakeDb({
      rpc: { fn_undo_routing_v2_phone_action: () => ({ data: { status: "partial", restored: [P1], stateChanged: [P2], skipped: [{ propertyId: P2, reason: "held" }], resumed: 2, notResumed: [] } }) },
    });
    expect(await undoRoutingV2PhoneAction(db, "a1")).toEqual({
      ok: true, status: "partial", restored: [P1], stateChanged: [P2], skipped: [{ propertyId: P2, reason: "held" }], resumed: 2, notResumed: [],
    });
    expect(rpcs()).toEqual(["fn_undo_routing_v2_phone_action"]);
  });
  it("maps errors", async () => {
    for (const [m, code] of [["NOT_FOUND", "NOT_FOUND"], ["FORBIDDEN", "FORBIDDEN"], ["AUTHENTICATION_REQUIRED", "FORBIDDEN"], ["other", "FAILED"]] as const) {
      const { db } = fakeDb({ rpc: { fn_undo_routing_v2_phone_action: () => ({ error: { message: m } }) } });
      expect(await undoRoutingV2PhoneAction(db, "a1")).toMatchObject({ ok: false, code });
    }
    const { db } = fakeDb({ rpc: { fn_undo_routing_v2_phone_action: () => ({ data: { status: "busy" } }) } });
    expect(await undoRoutingV2PhoneAction(db, "a1")).toMatchObject({ ok: false, code: "BUSY" });
  });
});

describe("live wiring: only the routing v2 live hook", () => {
  it("only ai-responder/dispatch.ts (the flag-gated v2 live step) imports the PR-G hook", () => {
    const root = path.resolve(__dirname, "../../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/wrong-number-all\.ts$/.test(name) && readFileSync(p, "utf8").includes("wrong-number-all")) hits.push(p);
      }
    };
    walk(root);
    expect(hits.map((h) => path.relative(root, h))).toEqual([path.join("lib", "ai-responder", "dispatch.ts")]);
    const dispatch = readFileSync(path.join(root, "lib/ai-responder/dispatch.ts"), "utf8");
    // Called from exactly one place: the routing v2 phone-action branch.
    expect(dispatch.match(/runRoutingV2PhoneAction\(/g)).toHaveLength(1);
  });
});
