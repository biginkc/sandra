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
  it("no SMS capabilities bounce (code check) → bad_number", () => {
    expect(phoneActionCandidate(bounce, null)).toEqual({ kind: "bad_number", signal: "code:bad_number", probability: null });
  });
});

type Call = { kind: "from" | "rpc"; table?: string; fn?: string; args?: unknown; op?: string; payload?: unknown; filters: unknown[] };

function fakeDb(opts: {
  flags?: unknown;
  configError?: boolean;
  rpc?: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>;
}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { kind: "from", table, filters: [] };
      calls.push(call);
      const chain = {
        select: () => {
          call.op = call.op ?? "select";
          return chain;
        },
        update: (payload: unknown) => {
          call.op = "update";
          call.payload = payload;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return chain;
        },
        is: (c: string, v: unknown) => {
          call.filters.push([c, v]);
          return chain;
        },
        maybeSingle: async () =>
          opts.configError ? { data: null, error: { message: "boom" } } : { data: opts.flags === undefined ? null : { routing_v2_flags: opts.flags }, error: null },
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      };
      return chain;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", fn, args, filters: [] });
      const h = opts.rpc?.[fn];
      if (!h) return { data: null, error: { message: `unexpected rpc ${fn}` } };
      const r = h(args);
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
  return { db: db as never, calls };
}

const ON = { questions_live: true, wrong_number_all: true, canary_percent: 100 };
const input = (over: Partial<Parameters<typeof runRoutingV2PhoneAction>[1]> = {}) => ({
  orgId: "org",
  inboundMessageId: "in-1",
  fromPhone: "(816) 555-0101",
  decision: jev("wrong_person", 0.9),
  wrongScope: "all" as const,
  ...over,
});
const deps = (over: Partial<RoutingV2PhoneActionDeps> = {}): RoutingV2PhoneActionDeps & { send: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> } => {
  const send = vi.fn(async () => ({ sent: true as const, outboundMessageId: "out-1" }));
  const pause = vi.fn(async (id: string) => (id === "p1" ? ["e1", "e2"] : []));
  return { sendWrongNumberReply: send, pauseEnrollments: pause, send, pause, ...over } as never;
};

const claimed = () => ({ data: { status: "claimed", actionId: "a1", propertyIds: ["p1", "p2", "p5"] } });
const appliedRpc = () => ({ data: { status: "applied", actionId: "a1", applied: ["p1", "p2"], skipped: [{ propertyId: "p5", reason: "other_phones_on_contact" }] } });

describe("runRoutingV2PhoneAction", () => {
  it("flag-off parity: any flag shape other than questions_live + wrong_number_all = one config read, no RPC, no send, no pause", async () => {
    for (const flags of [undefined, null, {}, { wrong_number_all: true }, { questions_live: true }, { questions_live: true, wrong_number_all: "true" }, { questions_live: false, wrong_number_all: true }]) {
      const { db, calls } = fakeDb({ flags });
      const d = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "flag_off" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: "from", table: "ai_responder_configs", op: "select" });
      expect(d.send).not.toHaveBeenCalled();
      expect(d.pause).not.toHaveBeenCalled();
    }
    const { db, calls } = fakeDb({ configError: true });
    expect(await runRoutingV2PhoneAction(db, input(), deps())).toEqual({ outcome: "flag_off" });
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("applies: claim → the existing approved wrong-number reply → apply → pause drips on applied properties only", async () => {
    const { db, calls } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_claim: claimed, fn_routing_v2_phone_action_apply: appliedRpc } });
    const d = deps();
    const r = await runRoutingV2PhoneAction(db, input(), d);
    expect(r).toEqual({ outcome: "applied", kind: "wrong_number_all", actionId: "a1", applied: ["p1", "p2"], skipped: [{ propertyId: "p5", reason: "other_phones_on_contact" }] });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith({ templateKey: "wrong_number", requiredBody: APPROVED_REPLY_TEXTS.wrong_number });
    const claimCall = calls.find((c) => c.fn === "fn_routing_v2_phone_action_claim");
    expect(claimCall?.args).toMatchObject({ p_source_inbound_message_id: "in-1", p_action: "wrong_number_all", p_phone: "+18165550101" });
    expect(calls.find((c) => c.fn === "fn_routing_v2_phone_action_apply")?.args).toEqual({ p_action_id: "a1", p_reply_message_id: "out-1" });
    // Order: claim, send, apply.
    const order = calls.filter((c) => c.kind === "rpc").map((c) => c.fn);
    expect(order).toEqual(["fn_routing_v2_phone_action_claim", "fn_routing_v2_phone_action_apply"]);
    expect(d.pause.mock.calls.map((c) => c[0])).toEqual(["p1", "p2"]); // never p5 (skipped)
    const pauseWrites = calls.filter((c) => c.table === "routing_v2_phone_action_properties");
    expect(pauseWrites).toHaveLength(1);
    expect(pauseWrites[0]).toMatchObject({ op: "update", payload: { paused_enrollment_ids: ["e1", "e2"] } });
    expect(pauseWrites[0].filters).toEqual([["action_id", "a1"], ["property_id", "p1"], ["undone_at", null]]);
  });

  it("reuses the existing reply text byte-for-byte (no new seller-facing text)", () => {
    expect(WRONG_NUMBER_REPLY_KEY).toBe("wrong_number");
    expect(WRONG_NUMBER_REPLY_BODY).toBe(APPROVED_REPLY_TEXTS.wrong_number);
  });

  it("duplicate webhook: a replayed claim sends nothing and applies nothing", async () => {
    const { db, calls } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_claim: () => ({ data: { status: "replayed", actionId: "a1", actionStatus: "applied" } }) } });
    const d = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "replayed", actionId: "a1", actionStatus: "applied" });
    expect(d.send).not.toHaveBeenCalled();
    expect(calls.some((c) => c.fn === "fn_routing_v2_phone_action_apply")).toBe(false);
  });

  it("duplicate apply after a crash between send and apply is a replay, not a second effect", async () => {
    const { db } = fakeDb({
      flags: ON,
      rpc: { fn_routing_v2_phone_action_claim: claimed, fn_routing_v2_phone_action_apply: () => ({ data: { status: "replayed", actionStatus: "applied" } }) },
    });
    const d = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "replayed", actionId: "a1", actionStatus: "applied" });
    expect(d.pause).not.toHaveBeenCalled();
  });

  it("DB says not applicable (canary, suppressed, held, flag flipped) → no send, today's path", async () => {
    for (const reason of ["canary_excluded", "phone_suppressed", "source_held", "flag_off"]) {
      const { db } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_claim: () => ({ data: { status: "not_applicable", reason } }) } });
      const d = deps();
      expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "not_applicable", reason });
      expect(d.send).not.toHaveBeenCalled();
    }
  });

  it("reply not accepted → the claim is closed as not_applied and nothing is closed", async () => {
    const { db, calls } = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_claim: claimed } });
    const d = deps({ sendWrongNumberReply: vi.fn(async () => ({ sent: false as const, reason: "suppressed" })) });
    expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "reply_not_sent", actionId: "a1", reason: "suppressed" });
    expect(calls.some((c) => c.fn === "fn_routing_v2_phone_action_apply")).toBe(false);
    const close = calls.find((c) => c.table === "routing_v2_phone_actions");
    expect(close).toMatchObject({ op: "update", payload: { status: "not_applied", not_applied_reason: "reply_not_sent:suppressed" } });
    expect(close?.filters).toEqual([["id", "a1"], ["status", "claimed"]]);
  });

  it("apply re-check fails (newer text, set changed) → not_applied, no pause", async () => {
    const { db } = fakeDb({
      flags: ON,
      rpc: { fn_routing_v2_phone_action_claim: claimed, fn_routing_v2_phone_action_apply: () => ({ data: { status: "not_applied", reason: "superseded_by_newer_inbound" } }) },
    });
    const d = deps();
    expect(await runRoutingV2PhoneAction(db, input(), d)).toEqual({ outcome: "not_applied", actionId: "a1", reason: "superseded_by_newer_inbound" });
    expect(d.pause).not.toHaveBeenCalled();
  });

  it("scope this_property never reaches the database", async () => {
    const { db, calls } = fakeDb({ flags: ON });
    expect(await runRoutingV2PhoneAction(db, input({ wrongScope: "this_property" }), deps())).toEqual({ outcome: "not_applicable", reason: "scope_not_all" });
    expect(calls.filter((c) => c.kind === "rpc")).toHaveLength(0);
  });

  it("bounce: bad_number with no reply and no drip pause", async () => {
    const { db, calls } = fakeDb({
      flags: ON,
      rpc: { fn_routing_v2_phone_action_claim: claimed, fn_routing_v2_phone_action_apply: () => ({ data: { status: "applied", applied: ["p1"], skipped: [] } }) },
    });
    const d = deps();
    const r = await runRoutingV2PhoneAction(db, input({ decision: bounce, wrongScope: null }), d);
    expect(r).toMatchObject({ outcome: "applied", kind: "bad_number", applied: ["p1"] });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.pause).not.toHaveBeenCalled();
    expect(calls.find((c) => c.fn === "fn_routing_v2_phone_action_claim")?.args).toMatchObject({ p_action: "bad_number" });
    expect(calls.find((c) => c.fn === "fn_routing_v2_phone_action_apply")?.args).toEqual({ p_action_id: "a1", p_reply_message_id: null });
  });

  it("unusable phone or claim error → not applicable, no send", async () => {
    const { db } = fakeDb({ flags: ON });
    expect(await runRoutingV2PhoneAction(db, input({ fromPhone: "123" }), deps())).toEqual({ outcome: "not_applicable", reason: "phone_unusable" });
    const e = fakeDb({ flags: ON, rpc: { fn_routing_v2_phone_action_claim: () => ({ error: { message: "x" } }) } });
    const d = deps();
    expect(await runRoutingV2PhoneAction(e.db, input(), d)).toEqual({ outcome: "not_applicable", reason: "claim_failed" });
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe("undoRoutingV2PhoneAction", () => {
  it("restores via the RPC, then resumes only the drips this action paused (pause reason re-checked)", async () => {
    const { db, calls } = fakeDb({
      rpc: {
        fn_undo_routing_v2_phone_action: () => ({ data: { status: "undone", restored: ["p1", "p2"], stateChanged: [], enrollmentIds: ["e1", "e2"] } }),
        resume_sequence_enrollment: (a) => ({ data: [{ outcome: a.p_enrollment_id === "e1" ? "resumed" : "skipped" }] }),
      },
    });
    expect(await undoRoutingV2PhoneAction(db, "a1")).toEqual({ ok: true, status: "undone", restored: ["p1", "p2"], stateChanged: [], resumed: 1, resumeFailed: 0 });
    const resumes = calls.filter((c) => c.fn === "resume_sequence_enrollment").map((c) => c.args);
    expect(resumes).toEqual([
      { p_enrollment_id: "e1", p_expected_pause_reason: "inbound_reply" },
      { p_enrollment_id: "e2", p_expected_pause_reason: "inbound_reply" },
    ]);
  });
  it("partial undo reports the properties a person changed", async () => {
    const { db } = fakeDb({ rpc: { fn_undo_routing_v2_phone_action: () => ({ data: { status: "partial", restored: ["p1"], stateChanged: ["p2"], enrollmentIds: [] } }) } });
    expect(await undoRoutingV2PhoneAction(db, "a1")).toMatchObject({ ok: true, status: "partial", stateChanged: ["p2"] });
  });
  it("maps errors", async () => {
    for (const [m, code] of [["NOT_FOUND", "NOT_FOUND"], ["FORBIDDEN", "FORBIDDEN"], ["AUTHENTICATION_REQUIRED", "FORBIDDEN"], ["other", "FAILED"]] as const) {
      const { db } = fakeDb({ rpc: { fn_undo_routing_v2_phone_action: () => ({ error: { message: m } }) } });
      expect(await undoRoutingV2PhoneAction(db, "a1")).toMatchObject({ ok: false, code });
    }
  });
});

describe("live parity: not wired", () => {
  it("no live module imports the PR-G hook (cutover PR wires it)", () => {
    const root = path.resolve(__dirname, "../../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/wrong-number-all(\.test)?\.ts$/.test(name) && readFileSync(p, "utf8").includes("wrong-number-all")) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
