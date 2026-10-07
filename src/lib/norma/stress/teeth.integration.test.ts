import { describe, expect, it } from "vitest";

import { runRandomRun } from "./driver";
import { Harness } from "./harness";
import { checkInvariants } from "./invariants";
import { Latch, rng } from "./trace";

/**
 * The gate must have teeth: each mutant below re-creates one Norma function
 * with a deliberate bug, then a short randomised run must be reported as
 * violating the invariant that exists to catch it. If a mutant is NOT caught,
 * the gate is blind to that class of bug and this test fails.
 */
type Mutant = { name: string; invariant: string; apply: (q: (sql: string) => Promise<{ rows: Record<string, string>[] }>) => Promise<void> };

async function mutateFunction(q: (sql: string) => Promise<{ rows: Record<string, string>[] }>, signature: string, from: string, to: string) {
  const def = (await q(`select pg_get_functiondef('${signature}'::regprocedure) as d`)).rows[0]!.d as string;
  if (!def.includes(from)) throw new Error(`mutant anchor not found in ${signature}: ${from}`);
  await q(def.replace(from, to));
}

type DirectCompletionResult = { result?: string; status?: string; retry?: boolean; error?: string };

async function completeDirect(h: Harness, requestId: string, callId: string, outcome: string, payload: unknown): Promise<DirectCompletionResult> {
  try {
    const { rows } = await h.scratch.pool.query<{ result: DirectCompletionResult }>(
      "select public.fn_norma_complete_call($1, $2, $3, $4::jsonb) as result",
      [requestId, callId, outcome, JSON.stringify(payload)],
    );
    return rows[0]?.result ?? {};
  } catch (error) {
    return { error: String(error) };
  }
}

async function prepareBoundAttemptTwo(h: Harness) {
  const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail", secondKind: "callback" });
  await h.requestCall(ctx, h.world.rep1);
  const first = h.bland.callForNumber(ctx.lead.phone)!;
  h.skipRetryDispatchOnce = true;
  await h.bland.webhook(first, "good");
  const id = (await h.scratch.pool.query<{ id: string }>("select id from public.norma_call_requests where property_id = $1", [ctx.lead.property])).rows[0]!.id;
  const { claimNormaDispatch } = await import("../rpc");
  await claimNormaDispatch(h.client("claim"), id, 2);
  await h.scratch.pool.query("update public.norma_call_requests set status = 'dispatched', bland_call_id = 'call-2' where id = $1", [id]);
  return { ctx, id };
}

const MUTANTS: Mutant[] = [
  {
    name: "the stale-call sweep ignores an open Norma hold",
    invariant: "5",
    apply: (q) =>
      mutateFunction(q, "public.sweep_resume_call_in_progress(uuid[], timestamptz)", "if public.fn_norma_hold_active(e.property_id) then", "if false then"),
  },
  {
    name: "Retry ignores an open Norma hold (a provider_failed drip restarts mid-call)",
    invariant: "5",
    apply: (q) =>
      mutateFunction(q, "public.retry_sequence_step(uuid, uuid)", "if public.fn_norma_hold_active(e.property_id) then", "if false then"),
  },
  {
    name: "the one-open-request index is gone (a second request can open)",
    invariant: "1",
    apply: async (q) => {
      await q("drop index public.norma_call_requests_one_open_per_property_idx");
    },
  },
  {
    name: "a not_interested completion also creates a task",
    invariant: "3",
    apply: (q) =>
      mutateFunction(q, "public.fn_norma_complete_call(uuid, text, text, jsonb)", "if p_outcome in ('callback_requested', 'reached_no_callback', 'wrong_number') then", "if p_outcome in ('callback_requested', 'reached_no_callback', 'wrong_number', 'not_interested') then"),
  },
  {
    name: "call twice retries a first call that reached a person (not only a confirmed non-connect)",
    invariant: "1",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')\n     and (v_payload ->> 'attempt') = '1'",
        "if p_outcome <> 'unknown' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')\n     and (v_payload ->> 'attempt') = '1'",
      ),
  },
  {
    name: "call twice never retries (a confirmed no_answer completes at once)",
    invariant: "3",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')\n     and (v_payload ->> 'attempt') = '1'",
        "if false",
      ),
  },
  {
    name: "a completion forgets its Slack outbox row",
    invariant: "8",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "insert into public.norma_notifications (request_id, kind)\n  values (r.id, 'call_completed')\n  on conflict (request_id, kind) do nothing;",
        "null;",
      ),
  },
  {
    name: "marking a call reviewed also resumes the lead's drip",
    invariant: "9",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_mark_reviewed(uuid, uuid, uuid)",
        "select count(*)::integer into v_kept",
        "update public.sequence_enrollments set status = 'active', pause_reason = null where property_id = r.property_id and status = 'paused' and pause_reason = 'norma_call';\n  select count(*)::integer into v_kept",
      ),
  },
  {
    name: "marking a call reviewed does not check that the caller belongs to the org",
    invariant: "9",
    apply: (q) =>
      mutateFunction(q, "public.fn_norma_mark_reviewed(uuid, uuid, uuid)", "if not exists (\n    select 1 from public.memberships m\n     where m.user_id = p_user_id", "if false and not exists (\n    select 1 from public.memberships m\n     where m.user_id = p_user_id"),
  },
  {
    name: "marking a call reviewed leaves its review task open",
    invariant: "9",
    apply: (q) =>
      mutateFunction(q, "public.fn_norma_mark_reviewed(uuid, uuid, uuid)", "and status in ('open', 'snoozed')\n    returning id into v_task;", "and false\n    returning id into v_task;"),
  },
  {
    name: "eligibility never blocks (DNC / not_interested leads get dialled)",
    invariant: "2",
    apply: async (q) => {
      await q("alter function public.fn_norma_eligibility(uuid, uuid, text) rename to fn_norma_eligibility_orig");
      await q(`create function public.fn_norma_eligibility(p_property_id uuid, p_contact_id uuid, p_phone_e164 text)
               returns table (eligible boolean, block_reason text) language sql security definer set search_path = public as $$ select true, null::text $$`);
      await q("grant execute on function public.fn_norma_eligibility(uuid, uuid, text) to service_role");
    },
  },
];

/**
 * Mutants the random invariants cannot see (the harness always opts a DNC lead's
 * drips out before the release runs, and a replay changes only the result
 * string), so each is proven by a deterministic scene instead.
 */
type SceneMutant = { name: string; apply: Mutant["apply"]; scene: (h: Harness) => Promise<string[]> };

const SCENE_MUTANTS: SceneMutant[] = [
  {
    name: "the final pre-send fence is removed (reviewed dispatch still dials)",
    apply: (q) => mutateFunction(q, "public.fn_norma_presend_fence(uuid, integer)", "return v_n = 1;", "return true;"),
    scene: async (h) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback" });
      await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
      const id = (await h.scratch.pool.query<{ id: string }>("select id from public.norma_call_requests where property_id = $1", [ctx.lead.property])).rows[0]!.id;
      const gate = new Latch();
      const reached = new Latch();
      const remove = h.holdOnce(
        (info) => info.kind === "rpc" && info.name === "fn_norma_presend_fence" && info.actor === "fence-mutant",
        gate.promise,
        () => reached.open(),
      );
      try {
        const dispatching = h.dispatch(id, "fence-mutant");
        await reached.promise;
        const parked = (await h.scratch.pool.query("select public.fn_norma_mark_needs_review($1, $2, $3) as result", [id, "fence-mutant", 1])).rows[0]?.result;
        if (parked !== "needs_review") return [`mutant setup returned ${parked}`];
        const reviewed = await h.markReviewed(ctx, h.world.rep1);
        if (!reviewed?.ok) return [`review failed during mutant scene: ${JSON.stringify(reviewed)}`];
        gate.open();
        await dispatching;
      } finally {
        remove();
        gate.open();
      }
      return h.bland.sendsFor(id).length === 0 ? [] : ["removed pre-send fence still allowed a provider send after review committed"];
    },
  },
  {
    name: "missing or non-numeric completion metadata settles attempt 2",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "if not (v_payload ? 'attempt' and (v_payload ->> 'attempt') ~ '^[0-9]+$')\n     and r.attempt <> 1 then",
        "if false then",
      ),
    scene: async (h) => {
      const { id } = await prepareBoundAttemptTwo(h);
      const result = await completeDirect(h, id, "call-2", "callback_requested", {});
      return result.result === "stale_attempt" ? [] : [`legacy completion returned ${JSON.stringify(result)}`];
    },
  },
  {
    name: "out of-range numeric completion metadata reaches the integer cast",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "if v_payload ? 'attempt' and (v_payload ->> 'attempt') not in ('1', '2') then",
        "if false then",
      ),
    scene: async (h) => {
      const { id } = await prepareBoundAttemptTwo(h);
      const result = await completeDirect(h, id, "call-2", "unknown", { attempt: "12345678901234567890" });
      return result.result === "stale_attempt" ? [] : [`invalid numeric attempt returned ${JSON.stringify(result)}`];
    },
  },
  {
    name: "attempt-1 no-answer without metadata schedules the retry",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')\n     and (v_payload ->> 'attempt') = '1'",
        "if p_outcome = 'no_answer' and r.attempt = 1 and r.status in ('dispatching', 'dispatched')",
      ),
    scene: async (h) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail" });
      await h.requestCall(ctx, h.world.rep1);
      const call = h.bland.callForNumber(ctx.lead.phone)!;
      const id = (await h.scratch.pool.query<{ id: string }>("select id from public.norma_call_requests where property_id = $1", [ctx.lead.property])).rows[0]!.id;
      const result = await completeDirect(h, id, call.callId, "no_answer", {});
      return result.result === "applied" && result.status === "completed" && !result.retry ? [] : [`metadata-free attempt-1 completion returned ${JSON.stringify(result)}`];
    },
  },
  {
    name: "releasing a request's pauses ignores do-not-contact (a DNC lead is resumed)",
    apply: async (q) => {
      await mutateFunction(q, "public.fn_norma_release_pauses(uuid)", "if coalesce(v_prop.is_dnc_locked, true)", "if false");
      await mutateFunction(q, "public.fn_norma_release_pauses(uuid)", "or coalesce(v_contact.do_not_contact, false)", "or false");
    },
    scene: async (h) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "no_answer_status" });
      await h.requestCall(ctx, h.world.rep1);
      // Do-not-contact lands on the contact only, leaving the enrollment paused as norma_call.
      await h.scratch.pool.query("update public.contacts set do_not_contact = true where id = $1", [ctx.lead.contact]);
      // Call twice: the retry's dial-time recheck refuses a do-not-contact contact, and that
      // rejection releases the request's pauses (the code under mutation).
      const hook = (await h.finish(ctx)).at(-1)!;
      const enrollment = (await h.scratch.pool.query("select status from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]])).rows[0];
      const request = (await h.scratch.pool.query("select status from public.norma_call_requests where property_id = $1", [ctx.lead.property])).rows[0];
      const problems: string[] = [];
      if (hook.status !== 200 || !["completed", "dispatch_rejected"].includes(String(request?.status))) problems.push(`the completion failed (${hook.status}, request ${request?.status})`);
      if (enrollment?.status !== "paused") problems.push(`a do-not-contact lead's drip was ${enrollment?.status} after the call ended`);
      return problems;
    },
  },
  {
    name: "releasing a request's pauses ignores why the pause is held (a reply pause is released like our own)",
    apply: (q) =>
      mutateFunction(q, "public.fn_norma_release_pauses(uuid)", "elsif e.status <> 'paused' or e.pause_reason is distinct from 'norma_call' then", "elsif e.status <> 'paused' then"),
    scene: async (h) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "no_answer_status" });
      await h.requestCall(ctx, h.world.rep1);
      await h.inboundReply(ctx);
      const hook = (await h.finish(ctx)).at(-1)!;
      const pause = (await h.scratch.pool.query("select release_result from public.norma_enrollment_pauses where enrollment_id = $1", [ctx.lead.enrollments[0]])).rows[0];
      const enrollment = (await h.scratch.pool.query("select status, pause_reason from public.sequence_enrollments where id = $1", [ctx.lead.enrollments[0]])).rows[0];
      const problems: string[] = [];
      if (hook.status !== 200) problems.push(`the completion answered ${hook.status}`);
      if (pause?.release_result !== "reason_changed") problems.push(`release_result was ${pause?.release_result}, expected reason_changed`);
      if (enrollment?.status !== "paused" || enrollment?.pause_reason !== "inbound_reply") problems.push(`the reply pause became ${enrollment?.status}/${enrollment?.pause_reason}`);
      return problems;
    },
  },
  {
    name: "a stale or forged attempt-1 call id can complete an unbound attempt 2",
    apply: (q) =>
      mutateFunction(
        q,
        "public.fn_norma_complete_call(uuid, text, text, jsonb)",
        "if v_payload ? 'attempt'\n     and coalesce(case when (v_payload ->> 'attempt') ~ '^[0-9]+$' then (v_payload ->> 'attempt')::integer end, 0) <> r.attempt then",
        "if false then",
      ),
    scene: async (h) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "voicemail", secondKind: "callback" });
      await h.requestCall(ctx, h.world.rep1);
      const first = h.bland.callForNumber(ctx.lead.phone)!;
      h.skipRetryDispatchOnce = true;
      await h.bland.webhook(first, "good");
      const id = (await h.scratch.pool.query("select id from public.norma_call_requests where property_id = $1", [ctx.lead.property])).rows[0].id;
      const { claimNormaDispatch } = await import("../rpc");
      await claimNormaDispatch(h.client("claim"), id, 2);
      await h.bland.webhook(first, "mismatch_call_id");
      const row = (await h.scratch.pool.query("select status from public.norma_call_requests where id = $1", [id])).rows[0];
      return row?.status === "dispatching" ? [] : [`a forged attempt-1 call id moved the request to ${row?.status}`];
    },
  },
  {
    name: "a replayed completion is not short-circuited",
    apply: (q) =>
      mutateFunction(q, "public.fn_norma_complete_call(uuid, text, text, jsonb)", "if r.status = 'completed' then", "if false then"),
    scene: async (h) => {
      const ctx = await h.lead({ enrollments: ["active"] }, { kind: "reached" });
      await h.requestCall(ctx, h.world.rep1);
      const call = h.bland.callForNumber(ctx.lead.phone)!;
      await h.bland.webhook(call, "good");
      const again = await h.bland.webhook(call, "good");
      return again.status === 200 && again.body.status === "replayed" ? [] : [`second delivery answered ${again.status} ${JSON.stringify(again.body)}, expected a replay`];
    },
  },
];

describe("the stress gate has teeth (deterministic scenes)", () => {
  it.each(SCENE_MUTANTS)("catches: $name", async ({ apply, scene }) => {
    const h = await Harness.create(rng(78));
    try {
      const clean = await scene(h);
      expect(clean, "the scene must pass on the unmutated functions").toEqual([]);
    } finally {
      await h.close();
    }
    const m = await Harness.create(rng(78));
    try {
      await apply((sql) => m.scratch.pool.query(sql) as never);
      expect((await scene(m)).length, "mutant not caught by its scene").toBeGreaterThan(0);
    } finally {
      await m.close();
    }
  });
});

describe("the stress gate has teeth", () => {
  it.each(MUTANTS)("catches: $name", async ({ invariant, apply }) => {
    const h = await Harness.create(rng(77));
    try {
      await apply((sql) => h.scratch.pool.query(sql) as never);
      await runRandomRun(h, 77, 70);
      const { violations } = await checkInvariants(h, { settled: true });
      expect(violations.filter((v) => v.startsWith(`[${invariant}]`)).length, `no [${invariant}] violation among: ${violations.slice(0, 5).join(" | ")}`).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });
});
