import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CallKind } from "./fake-bland";
import { Harness, type LeadCtx } from "./harness";
import { checkInvariants } from "./invariants";
import { Barrier, Latch, rng, sleep } from "./trace";

/**
 * Named races from PLAN.md section 9, each FORCED with explicit barriers on
 * separate database connections (not left to luck): the hook holds a named
 * operation until the other party has reached its own. Every test ends by
 * asserting the end state; the file ends with the full invariant check over
 * everything these scenarios did.
 */
let h: Harness;
beforeAll(async () => {
  h = await Harness.create(rng(9));
});
afterAll(async () => {
  await h?.close();
});

const q = async (sql: string, params: unknown[] = []) => (await h.scratch.pool.query(sql, params)).rows;
const requestOf = async (property: string) =>
  (await q("select * from public.norma_call_requests where property_id = $1 order by created_at desc limit 1", [property]))[0];
const enrollment = async (id: string) => (await q("select status, pause_reason from public.sequence_enrollments where id = $1", [id]))[0];
const tasksOf = async (requestId: string) => q("select * from public.tasks where source_key = $1", [`norma_call:${requestId}`]);
const countOf = async (sql: string, params: unknown[]) => Number((await q(sql, params))[0].n);
const events = (requestId: string, type: string) =>
  countOf("select count(*) as n from public.lead_events where event_type = $1 and source_id = $2", [type, requestId]);
const notifications = (requestId: string) => countOf("select count(*) as n from public.norma_notifications where request_id = $1", [requestId]);

const arrive = (name: string, actors: string[], argKey?: string, argValue?: string) => (info: { actor: string; kind: string; name: string; args?: unknown }) =>
  info.kind === "rpc" && info.name === name && actors.includes(info.actor) &&
  (argKey === undefined || (info.args as Record<string, unknown> | undefined)?.[argKey] === argValue);

/**
 * Everything the CRM holds about one lead, for exact before/after comparison.
 * Timestamps are left out: the virtual clock shifts them and sweeps bump
 * bookkeeping times; what must not change is state, identity and content.
 */
async function crm(propertyId: string) {
  const T = "array['created_at','updated_at','next_check_at','completed_at','dispatched_at','dispatch_started_at','due_at','callback_requested_for','next_run_at','enrolled_at','released_at','next_attempt_at','snoozed_until']";
  // send_attempted_at is a stamp (shifted by the virtual clock), so its value is excluded, but whether it is set is state: a wrong null -> set on a refused path must show.
  const SEND = "jsonb_build_object('send_attempted_at_is_null', (to_jsonb(x) ->> 'send_attempted_at') is null)";
  const r = await q(
    `select (select coalesce(jsonb_agg((to_jsonb(x) - ${T} - 'send_attempted_at') || ${SEND} order by x.id), '[]') from public.norma_call_requests x where x.property_id = $1) as requests,
            (select coalesce(jsonb_agg(to_jsonb(x) - ${T} order by x.id), '[]') from public.tasks x where x.related_property_id = $1) as tasks,
            (select coalesce(jsonb_agg(to_jsonb(x) - ${T} order by x.id), '[]') from public.lead_events x where x.property_id = $1) as events,
            (select coalesce(jsonb_agg(to_jsonb(x) - ${T} order by x.id), '[]') from public.sequence_enrollments x where x.property_id = $1) as enrollments,
            (select to_jsonb(x) - ${T} from public.properties x where x.id = $1) as property,
            (select coalesce(jsonb_agg(to_jsonb(n) - ${T} order by n.id), '[]') from public.norma_notifications n join public.norma_call_requests x on x.id = n.request_id where x.property_id = $1) as notifications,
            (select coalesce(jsonb_agg(to_jsonb(p) - ${T} order by p.enrollment_id), '[]') from public.norma_enrollment_pauses p join public.norma_call_requests x on x.id = p.request_id where x.property_id = $1) as pauses`,
    [propertyId],
  );
  return JSON.stringify(r[0]);
}

const OUTCOME_KINDS: CallKind[] = ["callback", "reached", "not_interested", "wrong_number", "voicemail"];
const NEEDS_TASK = new Set<CallKind>(["callback", "reached", "wrong_number"]);

async function placeCall(kind: CallKind, opts: { enrollments?: ("active" | "paused:call_in_progress")[]; send?: "accept" | "accept_timeout" } = {}) {
  const ctx = await h.lead({ enrollments: opts.enrollments ?? ["active"] }, { kind, send: opts.send ?? "accept" });
  const res = await h.requestCall(ctx, h.world.rep1);
  return { ctx, res };
}

describe("webhook before the call id is stored", () => {
  it.each(OUTCOME_KINDS)("%s: webhook delivered inside the send-call request, before its response", async (kind) => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind, webhooksBeforeResponse: 1 });
    const res = await h.requestCall(ctx, h.world.rep1);
    expect(res).toMatchObject({ ok: true, code: "calling" });
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("completed");
    // A no-answer first call is retried once (the nested webhook of the second call completes it): the FINAL call is bound.
    expect(request.bland_call_id).toBe(h.bland.callsForNumber(ctx.lead.phone).at(-1)!.callId);
    expect(h.bland.sendsFor(request.id)).toHaveLength(kind === "voicemail" ? 2 : 1);
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await notifications(request.id)).toBe(1);
    expect((await tasksOf(request.id)).length).toBe(NEEDS_TASK.has(kind) ? 1 : 0);
  });

  it("webhook delivered many times before the response: still one effect", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", webhooksBeforeResponse: 4 });
    expect(await h.requestCall(ctx, h.world.rep1)).toMatchObject({ ok: true, code: "calling" });
    const request = await requestOf(ctx.lead.property);
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await tasksOf(request.id)).toHaveLength(1);
    expect(await notifications(request.id)).toBe(1);
  });

  it("barrier: the bind RPC is held until the webhook has fully completed the request", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "reached" });
    const gate = new Latch();
    const remove = h.holdOnce(
      (info) => info.kind === "rpc" && info.name === "fn_norma_bind_call_id",
      gate.promise,
      () => {
        void (async () => {
          const call = h.bland.callForNumber(ctx.lead.phone)!;
          const hook = await h.bland.webhook(call, "good");
          expect(hook.body.status).toBe("applied");
          gate.open();
        })();
      },
    );
    const res = await h.requestCall(ctx, h.world.rep1);
    remove();
    expect(res).toMatchObject({ ok: true, code: "calling" });
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("completed");
    expect(await tasksOf(request.id)).toHaveLength(1);
    expect(await events(request.id, "norma_call_completed")).toBe(1);
  });
});

describe("webhook vs reconciliation", () => {
  it.each(OUTCOME_KINDS.flatMap((k) => [k, k]))("%s: both reach fn_norma_complete_call together; exactly one applies", async (kind) => {
    const { ctx } = await placeCall(kind);
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("dispatched");
    await h.advance(4 * 60_000); // old enough for the sweep to ask Bland
    const barrier = new Barrier(2);
    const remove = h.addHook(async (info) => {
      if (arrive("fn_norma_complete_call", ["webhook", "reconcile-race"], "p_request_id", request.id)(info)) await barrier.wait();
    });
    const call = h.bland.callForNumber(ctx.lead.phone)!;
    const [hook] = await Promise.all([h.bland.webhook(call, "good"), h.reconcile({ actor: "reconcile-race" })]);
    remove();
    expect(hook.status).toBe(200);
    if (kind === "voicemail") {
      // Both reached the completion of attempt 1: exactly one scheduled (and dialled) the retry.
      const retrying = await requestOf(ctx.lead.property);
      expect(retrying.status).toBe("dispatched");
      expect(await events(request.id, "norma_call_attempt_no_answer")).toBe(1);
      expect(h.bland.sendsFor(request.id)).toHaveLength(2);
      expect(await events(request.id, "norma_call_completed")).toBe(0);
      await h.finish(ctx);
    }
    const after = await requestOf(ctx.lead.property);
    expect(after.status).toBe("completed");
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await notifications(request.id)).toBe(1);
    expect((await tasksOf(request.id)).length).toBe(NEEDS_TASK.has(kind) ? 1 : 0);
    expect(await countOf("select count(*) as n from public.lead_events where event_type = 'task_created' and property_id = $1", [ctx.lead.property])).toBe(NEEDS_TASK.has(kind) ? 1 : 0);
  });
});

describe("close vs dispatch (expected-status)", () => {
  async function stranded() {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("requested");
    return { ctx, request };
  }

  it("forced order 1: the expiry close wins, then the late dispatch cannot claim", async () => {
    const { ctx, request } = await stranded();
    await h.advance(6 * 60_000);
    await h.reconcile();
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_rejected");
    expect(await h.dispatch(request.id)).toMatchObject({ status: "not_claimed" });
    expect(h.bland.sendsFor(request.id)).toHaveLength(0);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
  });

  it("forced order 2: the dispatch claims first, then the expiry close leaves the claimed row alone", async () => {
    const { ctx, request } = await stranded();
    await h.advance(6 * 60_000);
    const gate = new Latch();
    const claimed = new Latch();
    // Hold the sender right after its claim, mid-send, so the close arrives against `dispatching`.
    const remove = h.addHook(async (info) => {
      if (info.kind === "rpc" && info.name === "fn_norma_bind_call_id" && (info.args as { p_request_id?: string }).p_request_id === request.id) {
        claimed.open();
        await gate.promise;
      }
    });
    const dispatching = h.dispatch(request.id);
    await claimed.promise;
    await h.reconcile();
    gate.open();
    await dispatching;
    remove();
    const after = await requestOf(ctx.lead.property);
    expect(after.status).toBe("dispatched");
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
  });

  it.each(Array.from({ length: 12 }, (_, i) => i))("simultaneous (round %i): exactly one of {closed, dialled}", async () => {
    const { ctx, request } = await stranded();
    await h.advance(6 * 60_000);
    const barrier = new Barrier(2);
    const remove = h.addHook(async (info) => {
      if (
        info.kind === "rpc" &&
        ((info.name === "fn_norma_claim_dispatch_v2" && info.actor === "dispatch-race") ||
          (info.name === "fn_norma_mark_dispatch_rejected" && info.actor === "close-race")) &&
        (info.args as { p_request_id?: string }).p_request_id === request.id
      ) {
        await barrier.wait();
      }
    });
    await Promise.all([h.dispatch(request.id, "dispatch-race"), h.reconcile({ actor: "close-race" })]);
    remove();
    const after = await requestOf(ctx.lead.property);
    const sends = h.bland.sendsFor(request.id).length;
    if (sends === 1) {
      expect(["dispatched", "dispatching", "dispatch_unknown", "completed"]).toContain(after.status);
      expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
    } else {
      expect(sends).toBe(0);
      expect(after.status).toBe("dispatch_rejected");
      expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
    }
  });
});

describe("reply during a Norma hold", () => {
  type Seed = "active" | "paused:call_in_progress";
  const seeds: Seed[] = ["active", "paused:call_in_progress"];

  async function held(seed: Seed) {
    const { ctx } = await placeCall("voicemail", { enrollments: [seed] });
    // Call twice: the first call's no-answer schedules and places the retry; the
    // hold (and the pause) must survive it. The state under test is "second call in flight".
    await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("dispatched");
    expect(h.bland.callsForNumber(ctx.lead.phone)).toHaveLength(2);
    return { ctx, request };
  }
  /** The no-answer that ends the request: the SECOND call's webhook. */
  const finish = (ctx: LeadCtx) => h.bland.webhook(h.bland.callsForNumber(ctx.lead.phone)[1]!, "good");

  it.each(seeds)("reply fully before the no-answer (%s): stays paused as inbound_reply", async (seed) => {
    const { ctx } = await held(seed);
    await h.inboundReply(ctx);
    await finish(ctx);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
    await h.softphoneCleanup(ctx);
    await h.staleSweep();
    await h.advance(40 * 60_000);
    await h.staleSweep();
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });

  it.each(seeds)("takeover during the hold (%s): stays paused as rep_sms_human_takeover", async (seed) => {
    const { ctx } = await held(seed);
    await h.takeover(ctx);
    await finish(ctx);
    await h.softphoneCleanup(ctx);
    await h.advance(40 * 60_000);
    await h.staleSweep();
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "rep_sms_human_takeover" });
  });

  it("reply upgrade done, then the no-answer completes, then the reply's own pause step runs (barrier between them)", async () => {
    const { ctx } = await held("active");
    const gate = new Latch();
    const upgraded = new Latch();
    const remove = h.addHook(async (info) => {
      // The reply path's second step is held until the call has completed and released.
      if (info.actor === "inbound" && info.kind === "update" && info.name === "sequence_enrollments") {
        upgraded.open();
        await gate.promise;
      }
    });
    const reply = h.inboundReply(ctx);
    await upgraded.promise;
    await finish(ctx);
    gate.open();
    await reply;
    remove();
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });

  it("the no-answer completes first, the reply lands after (active lead): paused as inbound_reply, never active", async () => {
    const { ctx } = await held("active");
    await finish(ctx);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
    await h.inboundReply(ctx);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });

  it.each(seeds.flatMap((s) => Array.from({ length: 8 }, () => s)))("simultaneous start (%s): reply and completion race; reply always wins", async (seed) => {
    const { ctx, request } = await held(seed);
    const barrier = new Barrier(2);
    const remove = h.addHook(async (info) => {
      if (arrive("fn_norma_complete_call", ["webhook"], "p_request_id", request.id)(info) || arrive("fn_norma_upgrade_pauses_for_reply", ["inbound-race"])(info)) {
        await barrier.wait();
      }
    });
    await Promise.all([finish(ctx), h.inboundReply(ctx, "inbound-race")]);
    remove();
    const e = await enrollment(ctx.lead.enrollments[0]!);
    // call_in_progress + completion first + reply after is the pre-existing softphone gap (a reply
    // with no Norma hold does not touch a softphone pause); every other ordering must hold.
    if (seed === "active") expect(e).toEqual({ status: "paused", pause_reason: "inbound_reply" });
    else expect(["inbound_reply", "call_in_progress"]).toContain(e.pause_reason);
  });
});

describe("[I1] softphone cleanup race", () => {
  it("cleanup selected the pause, a reply upgrades it, Norma no-answer completes, then the cleanup RPC runs: refused", async () => {
    const { ctx } = await placeCall("voicemail", { enrollments: ["paused:call_in_progress"] });
    const gate = new Latch();
    const selected = new Latch();
    const remove = h.addHook(async (info) => {
      if (info.actor === "cleanup" && info.kind === "rpc" && info.name === "resume_sequence_enrollment") {
        selected.open();
        await gate.promise;
      }
    });
    const cleanup = h.softphoneCleanup(ctx, "cleanup");
    await selected.promise;
    await h.inboundReply(ctx);
    await h.finish(ctx);
    expect((await requestOf(ctx.lead.property)).status).toBe("completed");
    gate.open();
    await cleanup;
    remove();
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "inbound_reply" });
  });

  it("without a reply the same interleaving does resume (the expected reason is unchanged and the hold is gone)", async () => {
    const { ctx } = await placeCall("voicemail", { enrollments: ["paused:call_in_progress"] });
    const gate = new Latch();
    const selected = new Latch();
    const remove = h.addHook(async (info) => {
      if (info.actor === "cleanup2" && info.kind === "rpc" && info.name === "resume_sequence_enrollment") {
        selected.open();
        await gate.promise;
      }
    });
    const cleanup = h.softphoneCleanup(ctx, "cleanup2");
    await selected.promise;
    await h.finish(ctx);
    gate.open();
    await cleanup;
    remove();
    expect((await enrollment(ctx.lead.enrollments[0]!)).status).toBe("active");
  });

  it("existing softphone pause -> Norma dispatch -> cleanup (no resume) -> no-answer (sweep resumes) -> reached stays paused", async () => {
    const a = await placeCall("voicemail", { enrollments: ["paused:call_in_progress"] });
    await h.softphoneCleanup(a.ctx);
    expect(await enrollment(a.ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "call_in_progress" });
    await h.finish(a.ctx);
    await h.advance(40 * 60_000);
    await h.staleSweep();
    expect((await enrollment(a.ctx.lead.enrollments[0]!)).status).toBe("active");

    const b = await placeCall("reached", { enrollments: ["paused:call_in_progress"] });
    await h.bland.webhook(h.bland.callForNumber(b.ctx.lead.phone)!, "good");
    await h.advance(40 * 60_000);
    await h.staleSweep();
    expect(await enrollment(b.ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
  });
});

describe("button hammer", () => {
  it.each([
    ["one user", false],
    ["two users", true],
  ])("20 simultaneous requests for one lead (%s), call held open: exactly one request and one dispatch", async (_label, twoUsers) => {
    const hold = new Latch();
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", hold: hold.promise });
    const presses = Array.from({ length: 20 }, (_, i) =>
      h.requestCall(ctx, twoUsers && i % 2 ? h.world.rep2 : h.world.rep1, { actor: `hammer-${twoUsers ? "2" : "1"}-${i}` }),
    );
    // The winner is parked inside send-call; wait until Bland has seen it, then settle the 19 losers.
    for (let i = 0; i < 400 && h.bland.sends.filter((s) => s.number === ctx.lead.phone).length === 0; i += 1) await sleep(5);
    await sleep(150);
    expect(await countOf("select count(*) as n from public.norma_call_requests where property_id = $1", [ctx.lead.property])).toBe(1);
    expect(h.bland.sends.filter((s) => s.number === ctx.lead.phone)).toHaveLength(1);
    hold.open();
    const results = await Promise.all(presses);
    expect(results.filter((r) => r.ok && r.code === "calling")).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "in_flight")).toHaveLength(19);
    const request = await requestOf(ctx.lead.property);
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
    expect(h.bland.callsFor(request.id)).toHaveLength(1);
    expect(request.status).toBe("dispatched");
    // A completed call legitimately allows a new request (once the 10 s same-number spacing of claim_dispatch_v2 [C9] has passed).
    await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    await h.advance(15_000); // > 10 s number spacing [C9] with margin for host↔DB clock drift on long-lived stacks
    expect(await h.requestCall(ctx, h.world.rep1)).toMatchObject({ ok: true });
  });

  it("20 simultaneous dispatches of one requested row: one claim, one send", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
    const request = await requestOf(ctx.lead.property);
    const barrier = new Barrier(20);
    const remove = h.addHook(async (info) => {
      if (info.kind === "rpc" && info.name === "fn_norma_claim_dispatch_v2" && info.actor.startsWith("d20-")) await barrier.wait();
    });
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => h.dispatch(request.id, `d20-${i}`)));
    remove();
    expect(out.filter((r) => r.status === "dispatched")).toHaveLength(1);
    expect(out.filter((r) => r.status === "not_claimed")).toHaveLength(19);
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);
  });
});

describe("a database failure during completion rolls everything back", () => {
  const cases: { kind: CallKind; table: "norma_notifications" | "tasks" }[] = [
    { kind: "callback", table: "norma_notifications" },
    { kind: "callback", table: "tasks" },
    { kind: "reached", table: "norma_notifications" },
    { kind: "wrong_number", table: "tasks" },
    { kind: "not_interested", table: "norma_notifications" },
    { kind: "voicemail", table: "norma_notifications" },
  ];
  it.each(cases)("$kind, failure on $table: no partial effect, then the replay applies exactly once", async ({ kind, table }) => {
    const { ctx } = await placeCall(kind);
    // A no-answer first call only schedules the retry; the completion (and so the
    // outbox / task writes the fault hits) is the second call's webhook.
    if (kind === "voicemail") await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    const target = h.bland.callsForNumber(ctx.lead.phone).at(-1)!;
    const request = await requestOf(ctx.lead.property);
    const before = await crm(ctx.lead.property);
    await q("insert into stress.fault(property_id, tbl) values ($1, $2)", [ctx.lead.property, table]);
    const failed = await h.bland.webhook(target, "good");
    expect(failed.status).toBe(500);
    expect(await crm(ctx.lead.property)).toBe(before);
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatched");
    await q("delete from stress.fault where property_id = $1", [ctx.lead.property]);
    const ok = await h.bland.webhook(target, "good");
    expect(ok.body.status).toBe("applied");
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await notifications(request.id)).toBe(1);
    expect((await tasksOf(request.id)).length).toBe(NEEDS_TASK.has(kind) ? 1 : 0);
    const again = await h.bland.webhook(target, "good");
    expect(again.body.status).toBe("replayed");
    expect(await events(request.id, "norma_call_completed")).toBe(1);
  });
});

describe("hostile and malformed webhooks have zero CRM effect", () => {
  const flavors = ["bad_signature", "missing_signature", "tampered_body", "malformed_json", "not_object", "no_metadata", "mismatch_request_id", "mismatch_key", "mismatch_number", "mismatch_call_id"] as const;
  it.each(flavors)("%s", async (flavor) => {
    const { ctx } = await placeCall("callback");
    const call = h.bland.callForNumber(ctx.lead.phone)!;
    const before = await crm(ctx.lead.property);
    const res = await h.bland.webhook(call, flavor);
    expect(await crm(ctx.lead.property)).toBe(before);
    if (["bad_signature", "missing_signature", "tampered_body"].includes(flavor)) expect(res.status).toBe(401);
    else if (["malformed_json", "not_object"].includes(flavor)) expect(res.status).toBe(400);
    else expect(res.status).toBe(200);
    expect((await requestOf(ctx.lead.property)).status).toBe("dispatched");
    // A genuine webhook still works afterwards.
    expect((await h.bland.webhook(call, "good")).body.status).toBe("applied");
  });

  it("a payload for another lead's request cannot touch this one", async () => {
    const a = await placeCall("callback");
    const b = await placeCall("not_interested");
    const callA = h.bland.callForNumber(a.ctx.lead.phone)!;
    const before = await crm(b.ctx.lead.property);
    // Call A's webhook with request B's id: key/number/call id do not line up, so nothing happens.
    const forged = await h.bland.webhook({ ...callA, requestId: requestIdFor(b.ctx) }, "good");
    expect(forged.body.status).toBe("ignored");
    expect(await crm(b.ctx.lead.property)).toBe(before);
  });
  function requestIdFor(ctx: LeadCtx) {
    return h.bland.sends.find((s) => s.number === ctx.lead.phone)!.requestId;
  }

  it("an unmapped or incomplete payload parks the request for review and never completes it; the real result then completes it", async () => {
    for (const flavor of ["unmapped_token", "incomplete"] as const) {
      const { ctx } = await placeCall("reached");
      const call = h.bland.callForNumber(ctx.lead.phone)!;
      await h.bland.webhook(call, flavor);
      const parked = await requestOf(ctx.lead.property);
      expect(parked.status).toBe("needs_review");
      expect(await tasksOf(parked.id)).toHaveLength(1);
      expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "paused", pause_reason: "norma_call" });
      await h.bland.webhook(call, "good");
      const done = await requestOf(ctx.lead.property);
      expect(done.status).toBe("completed");
      const tasks = await tasksOf(done.id);
      expect(tasks).toHaveLength(1);
      expect(String(tasks[0].title)).toMatch(/no callback time given/);
    }
  });
});

describe("late completion after needs_review", () => {
  it.each(OUTCOME_KINDS)("%s: the real outcome applies once, the review task is retitled or closed, replay changes nothing", async (kind) => {
    const { ctx, res } = await placeCall(kind, { send: "accept_timeout" });
    expect(res).toMatchObject({ ok: true, code: "dispatch_unknown" });
    const request = await requestOf(ctx.lead.property);
    // Unresolved and nobody can query Bland by metadata: the redial fence holds, then it escalates.
    expect(await h.requestCall(ctx, h.world.rep2)).toMatchObject({ ok: false, code: "in_flight" });
    await h.advance(11 * 60_000);
    await h.reconcile();
    expect((await requestOf(ctx.lead.property)).status).toBe("needs_review");
    expect(await h.requestCall(ctx, h.world.rep2)).toMatchObject({ ok: false, code: "in_flight" });
    const review = await tasksOf(request.id);
    expect(review).toHaveLength(1);
    expect(h.bland.sendsFor(request.id)).toHaveLength(1);

    const late = await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    expect(late.body.status).toBe("applied");
    const done = await requestOf(ctx.lead.property);
    expect(done.status).toBe("completed");
    const tasks = await tasksOf(request.id);
    if (NEEDS_TASK.has(kind)) {
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(review[0].id);
      expect(tasks[0].status).toBe("open");
      expect(String(tasks[0].title)).not.toMatch(/needs review/i);
    } else {
      expect(tasks.filter((t) => t.status === "open")).toHaveLength(0);
    }
    const snapshot = await crm(ctx.lead.property);
    expect((await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good")).body.status).toBe("replayed");
    await h.advance(3 * 3600_000);
    await h.reconcile({ includeNeedsReview: true });
    expect(await crm(ctx.lead.property)).toBe(snapshot);
    expect(await events(request.id, "norma_call_completed")).toBe(1);
    expect(await notifications(request.id)).toBe(1);
  });
});

describe("dial-time checks", () => {
  it("a DNC write that commits after the request but before the dial stops the dial", async () => {
    for (const how of ["lock", "registry", "contact"] as const) {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
      await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
      await h.dnc(ctx, how);
      const request = await requestOf(ctx.lead.property);
      expect(await h.dispatch(request.id)).toMatchObject({ status: "rejected" });
      expect(h.bland.sendsFor(request.id)).toHaveLength(0);
      expect((await requestOf(ctx.lead.property)).status).toBe("dispatch_rejected");
    }
  });

  it("a not_interested write after the request stops the dial", async () => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
    await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
    await h.notInterested(ctx);
    const request = await requestOf(ctx.lead.property);
    expect(await h.dispatch(request.id)).toMatchObject({ status: "rejected" });
    expect(h.bland.sendsFor(request.id)).toHaveLength(0);
  });

  it.each(["disabled", "not_allowed"] as const)("a closed gate (%s) at dispatch time never dials", async (mode) => {
    const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" }, { request: "open", dispatch: mode });
    await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
    const request = await requestOf(ctx.lead.property);
    expect(await h.dispatch(request.id)).toMatchObject({ status: "rejected" });
    expect(h.bland.sendsFor(request.id)).toHaveLength(0);
    expect(await enrollment(ctx.lead.enrollments[0]!)).toEqual({ status: "active", pause_reason: null });
  });
});

describe("Slack", () => {
  /** The worker takes 10 rows per run; earlier scenarios left outbox rows behind. */
  const flush = async () => {
    for (let i = 0; i < 30; i += 1) if ((await h.slackDrain()).scanned === 0) return;
  };
  it("failures never touch CRM state, retries are durable, and delivery eventually succeeds exactly once", async () => {
    await flush();
    const { ctx } = await placeCall("callback", { send: "accept" });
    await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    const request = await requestOf(ctx.lead.property);
    h.slack.failNext.set(ctx.lead.property, 3);
    const before = await crm(ctx.lead.property);
    const notificationRow = async () => (await q("select status, attempts from public.norma_notifications where request_id = $1", [request.id]))[0];
    const strip = (snapshot: string) => {
      const parsed = JSON.parse(snapshot);
      delete parsed.notifications;
      return JSON.stringify(parsed);
    };
    for (let i = 0; i < 3; i += 1) {
      await h.slackDrain();
      expect(await notificationRow()).toMatchObject({ status: "pending", attempts: i + 1 });
      expect(strip(await crm(ctx.lead.property))).toBe(strip(before));
      await h.advance(61 * 60_000);
    }
    await h.slackDrain();
    expect(await notificationRow()).toMatchObject({ status: "sent" });
    expect(h.slack.postsFor(ctx.lead.property)).toHaveLength(1);
    expect(strip(await crm(ctx.lead.property))).toBe(strip(before));
    await h.advance(61 * 60_000);
    await h.slackDrain();
    expect(h.slack.postsFor(ctx.lead.property)).toHaveLength(1);
  });

  it("ambiguous acceptance (Slack took the post, the response was lost): one duplicate on retry, accepted", async () => {
    await flush();
    const { ctx } = await placeCall("reached");
    await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    h.slack.lostAcks.add(ctx.lead.property);
    await h.slackDrain();
    expect(h.slack.postsFor(ctx.lead.property)).toHaveLength(1);
    await h.advance(61 * 60_000);
    await h.slackDrain();
    expect(h.slack.postsFor(ctx.lead.property)).toHaveLength(2);
    await h.advance(61 * 60_000);
    await h.slackDrain();
    expect(h.slack.postsFor(ctx.lead.property)).toHaveLength(2);
    const request = await requestOf(ctx.lead.property);
    expect((await q("select status from public.norma_notifications where request_id = $1", [request.id]))[0].status).toBe("sent");
  });

  it("no outbox row for unknown or needs_review", async () => {
    const { ctx } = await placeCall("unknown_token");
    await h.bland.webhook(h.bland.callForNumber(ctx.lead.phone)!, "good");
    const request = await requestOf(ctx.lead.property);
    expect(request.status).toBe("needs_review");
    expect(await notifications(request.id)).toBe(0);
  });
});

describe("whole-file invariants", () => {
  it("every invariant holds over everything the scenarios above did", async () => {
    const { violations, stats } = await checkInvariants(h, { settled: false, allowWebhook500: true });
    // eslint-disable-next-line no-console
    console.log(`[norma-stress] races ${JSON.stringify(stats)}`);
    expect(violations).toEqual([]);
  });
});
