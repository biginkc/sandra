import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drainNormaFollowupNotices } from "../followup-notice";
import type { NormaSlackPost } from "../slack-worker";
import { Harness, type LeadCtx } from "./harness";
import { rng } from "./trace";

/**
 * Follow-up reassignment notices (plan rule 6 / B11) against the REAL queue schema.
 *
 * 20261009010100 stores a task it could not create (42501 FORBIDDEN: the person it was assigned to has left) as a row in
 * norma_followup_reassignments and commits the call result. The notifier must announce each such row in Slack, exactly once,
 * and must never change a call, task or drip row. Calls come in through both real paths: the legacy button request and the
 * queue (enqueue, claim, create_request_v2, claim_dispatch_v2, bind, complete).
 */
const V_OPEN = "2030-01-07T17:00:00Z"; // Mon 11:00 Chicago, dialing window open
const ENV = { NEXT_PUBLIC_APP_URL: "https://sandra.stress.invalid" };

let h: Harness;
beforeEach(async () => {
  vi.stubEnv("NORMA_QUEUE_MAX_CONCURRENT", "1000");
  vi.stubEnv("NORMA_QUEUE_DAILY_CAP", "100000");
  vi.stubEnv("NORMA_QUEUE_CAP_TZ", "America/Chicago");
  h = await Harness.create(rng(404));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await h?.close();
});

const pool = () => h.scratch.pool;
const rows = async (sql: string, a: unknown[] = []) => (await pool().query(sql, a)).rows;

function poster(opts: { failFirst?: number } = {}) {
  const posts: { text: string; blocks: unknown[] }[] = [];
  let failures = opts.failFirst ?? 0;
  const post: NormaSlackPost = async (m) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("slack_post_failed:fake_outage");
    }
    posts.push({ text: m.text, blocks: m.blocks });
    return { ts: `1700000000.${String(posts.length).padStart(6, "0")}` };
  };
  return { post, posts };
}

const sweep = (post: NormaSlackPost | null, now = Date.now()) => drainNormaFollowupNotices({ client: h.client("followup"), post, now, env: ENV });
const reassignments = () => rows("select id, request_id, kind, status, payload from public.norma_followup_reassignments order by created_at, id");
const notice = (r: { payload: { slack_notice?: { state: string } } }) => r.payload.slack_notice?.state;

/**
 * The button path's actor is the requester when still active, else the env assignee, and the assignee owns the task: the shared
 * task function refuses (FORBIDDEN) only when neither can act, so both leave. A second owner comes first because the last owner
 * of an org cannot be revoked (FINAL_OWNER_GUARD).
 */
async function departCallbackAssignee() {
  const owner2 = randomUUID();
  await pool().query("insert into auth.users(id) values ($1)", [owner2]);
  await pool().query("insert into public.memberships(user_id, org_id, role, access_status) values ($1, $2, 'owner', 'active')", [owner2, h.world.org]);
  await pool().query("update public.memberships set access_status = 'revoked' where user_id = any($1::uuid[]) and org_id = $2", [[h.world.assignee, h.world.rep1], h.world.org]);
}

/** The button path: request created through the real action core (callback owner = the env assignee), sent later. */
async function buttonRequest(): Promise<{ ctx: LeadCtx; requestId: string }> {
  const ctx = await h.lead({ enrollments: ["active"] }, { kind: "callback", webhooksBeforeResponse: 0 });
  await h.requestCall(ctx, h.world.rep1, { crashBeforeDispatch: true });
  const requestId = (await rows("select id from public.norma_call_requests where property_id = $1", [ctx.lead.property]))[0].id as string;
  return { ctx, requestId };
}
const sendAndFinish = async (r: { ctx: LeadCtx; requestId: string }) => {
  await h.dispatch(r.requestId);
  await h.finish(r.ctx);
};

/** The queue path through the same SQL the tick uses; returns the call id so the test completes it. */
async function queueCall(requester: string) {
  const l = await h.world.nextLead({ enrollments: ["active"] });
  const enq = (await rows("select * from public.fn_norma_queue_enqueue($1::uuid,$2::uuid,$3::uuid[],'followup test')", [h.world.org, requester, [l.property]]))[0];
  expect(enq.result).toBe("queued");
  await pool().query("update public.norma_queue_entries set created_at = created_at - interval '1 day', next_attempt_at = '2029-12-01T00:00:00Z' where id = $1", [enq.entry_id]);
  const claim = (await rows("select * from public.fn_norma_queue_claim($1::uuid,$2::timestamptz,true)", [enq.entry_id, V_OPEN]))[0];
  expect(claim.result).toBe("claimed");
  const req = (await rows("select * from public.fn_norma_create_request_v2($1::uuid,$2::uuid,$3::text,$4::uuid,'followup test',$4::uuid,$5::uuid,$6::uuid)", [l.property, l.contact, l.phone, requester, enq.entry_id, claim.lease_token]))[0];
  expect(req.outcome).toBe("created");
  const requestId = req.request_id as string;
  expect((await rows("select public.fn_norma_claim_dispatch_v2($1::uuid,1,$2::timestamptz,true,1000,100000,'America/Chicago') as r", [requestId, V_OPEN]))[0].r).toBe("claimed");
  await pool().query("update public.norma_call_requests set send_attempted_at = $2::timestamptz where id = $1", [requestId, V_OPEN]);
  const callId = `fu-${randomUUID()}`;
  expect((await rows("select public.fn_norma_bind_call_id($1::uuid,$2::text,1::integer) as b", [requestId, callId]))[0].b).toBe("bound");
  return { requestId, callId, property: l.property };
}
const completeQueue = (q: { requestId: string; callId: string }, outcome = "callback_requested") =>
  rows("select public.fn_norma_complete_call($1::uuid,$2::text,$3::text,$4::jsonb) as r", [q.requestId, q.callId, outcome, JSON.stringify({ attempt: 1 })]);

const requestState = async () =>
  JSON.stringify({
    requests: await rows("select * from public.norma_call_requests order by id"),
    tasks: await rows("select * from public.tasks where source_key like 'norma_call:%' order by id"),
    pauses: await rows("select * from public.norma_enrollment_pauses order by to_jsonb(norma_enrollment_pauses)::text"),
    enrollments: await rows("select * from public.sequence_enrollments order by id"),
    notifications: await rows("select * from public.norma_notifications order by id"),
  });

describe("departed requester: one notice per reassignment", () => {
  it("legacy button call: completion stores a callback_task reassignment and the sweep announces it once", async () => {
    const call = await buttonRequest();
    await departCallbackAssignee();
    await sendAndFinish(call);

    const stored = await reassignments();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ request_id: call.requestId, kind: "callback_task", status: "open" });
    expect((await rows("select status, outcome from public.norma_call_requests where id = $1", [call.requestId]))[0]).toMatchObject({ status: "completed", outcome: "callback_requested" });

    const slack = poster();
    expect(await sweep(slack.post)).toMatchObject({ sent: 1, failed: 0, tableAbsent: false });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toContain("Norma callback task needs a new owner");
    expect(JSON.stringify(slack.posts[0]!.blocks)).toContain(call.ctx.lead.address);
    expect(notice((await reassignments())[0] as never)).toBe("sent");
    expect(await sweep(slack.post, Date.now() + 3_600_000)).toMatchObject({ scanned: 0, sent: 0 });
    expect(slack.posts).toHaveLength(1);
  });

  it("queue call: a departed requester gets the same single notice", async () => {
    const q = await queueCall(h.world.rep2);
    await pool().query("update public.memberships set access_status = 'revoked' where user_id = $1 and org_id = $2", [h.world.rep2, h.world.org]);
    expect((await completeQueue(q))[0].r).toMatchObject({ result: "applied", outcome: "callback_requested", task_id: null });
    const stored = await reassignments();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ request_id: q.requestId, kind: "callback_task" });

    const slack = poster();
    expect(await sweep(slack.post)).toMatchObject({ sent: 1 });
    expect(await sweep(slack.post, Date.now() + 3_600_000)).toMatchObject({ sent: 0 });
    expect(slack.posts).toHaveLength(1);
  });

  it("ordinary calls get no extra notice", async () => {
    const call = await buttonRequest();
    await sendAndFinish(call);
    const q = await queueCall(h.world.rep1);
    await completeQueue(q);
    expect(await reassignments()).toEqual([]);
    const slack = poster();
    expect(await sweep(slack.post)).toMatchObject({ scanned: 0, sent: 0, tableAbsent: false });
    expect(slack.posts).toEqual([]);
  });
});

describe("escalation then callback", () => {
  const escalate = (requestId: string) => rows("select public.fn_norma_mark_needs_review($1::uuid, 'followup test escalation', 1) as r", [requestId]);

  it("review notice already sent, then the callback supersedes it: the callback gets its own notice, one current row", async () => {
    const call = await buttonRequest();
    await h.dispatch(call.requestId);
    await departCallbackAssignee();
    expect((await escalate(call.requestId))[0].r).toBe("needs_review");
    let stored = await reassignments();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "review_task" });

    const slack = poster();
    expect(await sweep(slack.post)).toMatchObject({ sent: 1 });
    expect(slack.posts[0]!.text).toContain("review task");

    await h.finish(call.ctx);
    stored = await reassignments();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "callback_task", status: "open" });
    expect(notice(stored[0] as never)).toBeUndefined();

    expect(await sweep(slack.post, Date.now() + 1000)).toMatchObject({ sent: 1 });
    expect(slack.posts).toHaveLength(2);
    expect(slack.posts[1]!.text).toContain("callback task");
    expect(notice((await reassignments())[0] as never)).toBe("sent");
    expect(await sweep(slack.post, Date.now() + 3_600_000)).toMatchObject({ scanned: 0 });
    expect(slack.posts).toHaveLength(2);
  });

  it("callback supersedes before the review notice went out: exactly one notice, the callback's", async () => {
    const call = await buttonRequest();
    await h.dispatch(call.requestId);
    await departCallbackAssignee();
    await escalate(call.requestId);
    await h.finish(call.ctx);
    expect((await reassignments())[0]).toMatchObject({ kind: "callback_task" });
    const slack = poster();
    expect(await sweep(slack.post)).toMatchObject({ sent: 1 });
    expect(await sweep(slack.post, Date.now() + 3_600_000)).toMatchObject({ sent: 0 });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toContain("callback task");
  });
});

describe("failure and concurrency", () => {
  it("a Slack failure retries with backoff and never touches the call, task, drip or notification rows", async () => {
    const call = await buttonRequest();
    await departCallbackAssignee();
    await sendAndFinish(call);
    const before = await requestState();

    const slack = poster({ failFirst: 1 });
    const t0 = Date.now();
    expect(await sweep(slack.post, t0)).toMatchObject({ failed: 1, sent: 0 });
    expect(slack.posts).toHaveLength(0);
    expect(await requestState()).toBe(before);
    const [row] = await reassignments();
    expect(notice(row as never)).toBe("pending");

    expect(await sweep(slack.post, t0 + 10_000)).toMatchObject({ scanned: 0 });
    expect(await sweep(slack.post, t0 + 61_000)).toMatchObject({ sent: 1 });
    expect(slack.posts).toHaveLength(1);
    expect(await requestState()).toBe(before);
    expect((await rows("select status, outcome from public.norma_call_requests where id = $1", [call.requestId]))[0]).toMatchObject({ status: "completed", outcome: "callback_requested" });
  });

  it("overlapping sweeps (real concurrent connections) post each row once", async () => {
    const calls = [];
    for (let i = 0; i < 4; i += 1) calls.push(await buttonRequest());
    await departCallbackAssignee();
    for (const c of calls) await sendAndFinish(c);
    expect(await reassignments()).toHaveLength(4);

    const slack = poster();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => drainNormaFollowupNotices({ client: h.client(`sweep-${i}`), post: slack.post, now: Date.now(), env: ENV })));
    expect(slack.posts).toHaveLength(4);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(4);
    expect((await reassignments()).map((r) => notice(r as never))).toEqual(["sent", "sent", "sent", "sent"]);
  });

  it("with Slack unconfigured the rows are left exactly as they are", async () => {
    const call = await buttonRequest();
    await departCallbackAssignee();
    await sendAndFinish(call);
    const before = JSON.stringify(await reassignments());
    expect(await sweep(null)).toMatchObject({ configured: false, sent: 0 });
    expect(JSON.stringify(await reassignments())).toBe(before);
  });
});
