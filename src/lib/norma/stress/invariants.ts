import { EXPECTED_OUTCOME } from "./fake-bland";
import type { Harness } from "./harness";

/**
 * The eight stress-gate invariants (.planning/norma/PLAN.md section 9), checked
 * against the audit trail (every committed transition, written by trigger), the
 * final database state, the fake Bland's record of what it was asked, and the
 * in-process trace. Returns human-readable violations; empty means green.
 *
 * Expected values come from the written spec (EXPECTED_OUTCOME, the task rules
 * in the plan), not from the code under test.
 */
export type Violation = string;
export type CheckStats = {
  requests: number;
  byStatus: Record<string, number>;
  byOutcome: Record<string, number>;
  sends: number;
  webhooks: number;
  auditRows: number;
  /** DNC / not_interested writes that landed after the dispatch recheck began but before the send (the inherent check-then-act window). */
  windowRaces: number;
  slackPosts: number;
};

type Req = {
  id: string;
  property_id: string;
  phone_e164: string;
  status: string;
  outcome: string | null;
  bland_call_id: string | null;
  callback_assignee_id: string;
  callback_requested_for: string | null;
  completed_at: string | null;
  created_at: string;
};
type Audit = { seq: string; tbl: string; op: string; row_id: string; property_id: string | null; hold_open: boolean | null; old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null };

const OPEN = ["requested", "dispatching", "dispatched", "dispatch_unknown", "needs_review"];
const SETTLED = ["completed", "dispatch_rejected", "needs_review"];
const REPLY_REASONS = ["inbound_reply", "rep_sms_human_takeover"];
const STRONGER_DISPOS = ["dnc", "opted_out", "bad_number", "wrong_number"];
const RELEASE_BLOCK_DISPOS = ["wrong_number", "bad_number", "dnc", "opted_out", "not_interested", "nurture", "callback_requested", "booked_appointment"];

export async function checkInvariants(h: Harness, opts: { settled?: boolean; allowWebhook500?: boolean } = {}): Promise<{ violations: Violation[]; stats: CheckStats }> {
  const pool = h.scratch.pool;
  const org = h.world.org;
  const out: Violation[] = [];
  const v = (id: string, msg: string) => out.push(`[${id}] ${msg}`);

  const requests = (await pool.query<Req>("select * from public.norma_call_requests where org_id = $1 order by created_at", [org])).rows;
  const audit = (
    await pool.query<Audit>(
      "select * from stress.audit where property_id in (select id from public.properties where org_id = $1) order by seq",
      [org],
    )
  ).rows;
  const tasks = (await pool.query("select * from public.tasks where org_id = $1 and source_key like 'norma_call:%'", [org])).rows;
  const events = (
    await pool.query(
      "select event_type, source_type, source_id, property_id, payload from public.lead_events where org_id = $1 and (event_type like 'norma_%' or source_type like 'norma%' or source_type = 'tasks.created' or event_type = 'dispo_set')",
      [org],
    )
  ).rows;
  const notifications = (
    await pool.query(
      "select n.*, r.property_id from public.norma_notifications n join public.norma_call_requests r on r.id = n.request_id where r.org_id = $1",
      [org],
    )
  ).rows;
  const pauses = (
    await pool.query(
      "select np.*, r.property_id, r.status as request_status, r.outcome as request_outcome from public.norma_enrollment_pauses np join public.norma_call_requests r on r.id = np.request_id where r.org_id = $1",
      [org],
    )
  ).rows;
  const enrollments = (await pool.query("select id, property_id, status, pause_reason from public.sequence_enrollments where org_id = $1", [org])).rows;
  const properties = new Map(
    (await pool.query("select id, is_dnc_locked, outreach_dispo, homeowner_contact_id from public.properties where org_id = $1", [org])).rows.map((r) => [r.id as string, r]),
  );
  const contacts = new Map(
    (await pool.query("select id, do_not_contact, sms_opted_out from public.contacts where org_id = $1", [org])).rows.map((r) => [r.id as string, r]),
  );

  const stats: CheckStats = {
    requests: requests.length,
    byStatus: {},
    byOutcome: {},
    sends: h.bland.sends.length,
    webhooks: h.bland.webhooks.length,
    auditRows: audit.length,
    windowRaces: 0,
    slackPosts: h.slack.posts.length,
  };
  for (const r of requests) {
    stats.byStatus[r.status] = (stats.byStatus[r.status] ?? 0) + 1;
    if (r.outcome) stats.byOutcome[r.outcome] = (stats.byOutcome[r.outcome] ?? 0) + 1;
  }
  const ctxOf = (propertyId: string) => h.leads.get(propertyId);
  // A do-not-contact lead's tasks are read-only by design (and nobody should ring it back):
  // for such a lead "no task" is the correct outcome, so a task is allowed but never required.
  const dncLocked = (propertyId: string) => {
    const prop = properties.get(propertyId);
    return Boolean(prop?.is_dnc_locked || contacts.get(prop?.homeowner_contact_id as string)?.do_not_contact);
  };
  const reqsByProperty = new Map<string, Req[]>();
  for (const r of requests) reqsByProperty.set(r.property_id, [...(reqsByProperty.get(r.property_id) ?? []), r]);

  // ===== [1] one call per request, one open request per lead =================
  const openByProperty = new Map<string, Set<string>>();
  for (const a of audit.filter((x) => x.tbl === "norma_call_requests")) {
    const set = openByProperty.get(a.property_id!) ?? new Set<string>();
    const status = a.new_row?.status as string | undefined;
    if (status && OPEN.includes(status)) {
      if (a.op === "INSERT" && set.size > 0) v("1", `property ${a.property_id}: a second request was opened while ${[...set].join(",")} was still open`);
      set.add(a.row_id);
    } else set.delete(a.row_id);
    openByProperty.set(a.property_id!, set);
  }
  for (const r of requests) {
    const sends = h.bland.sendsFor(r.id);
    const placed = h.bland.callsFor(r.id);
    if (sends.length > 1) v("1", `request ${r.id}: ${sends.length} send-call requests were issued (at most one allowed)`);
    if (placed.length > 1) v("1", `request ${r.id}: ${placed.length} Bland calls were created`);
    if (r.status === "dispatch_rejected" && placed.length > 0) v("1", `request ${r.id}: dispatch_rejected although Bland placed a call (a redial would now be possible)`);
    if (r.bland_call_id && !placed.some((c) => c.callId === r.bland_call_id)) v("1", `request ${r.id}: bound call id ${r.bland_call_id} is not a call Bland placed for it`);
  }
  for (const [property, list] of reqsByProperty) {
    const withCalls = list.filter((r) => h.bland.callsFor(r.id).length > 0);
    for (const earlier of withCalls.slice(0, -1)) {
      if (earlier.status !== "completed") v("1", `property ${property}: a later request placed a call while request ${earlier.id} was ${earlier.status} (redial fence broken)`);
    }
  }

  // ===== [2] no dispatch to a DNC / not_interested lead or a closed gate =====
  for (const send of h.bland.sends) {
    const request = requests.find((r) => r.id === send.requestId);
    if (!request) {
      v("2", `send-call for unknown request ${send.requestId}`);
      continue;
    }
    const ctx = ctxOf(request.property_id);
    const evals = h.dispatchEvals.filter((e) => e.requestId === request.id && e.tick < send.tick);
    if (evals.length === 0) v("2", `request ${request.id}: send-call without any dispatch gate evaluation`);
    else if (!evals.some((e) => e.open)) v("2", `request ${request.id}: send-call although every dispatch saw a closed gate`);
    const recheck = [...h.trace.events]
      .reverse()
      .find((e) => e.phase === "start" && e.what === "rpc:fn_norma_eligibility" && e.tick < send.tick && (e.detail?.args as Record<string, unknown> | undefined)?.p_phone_e164 === send.number);
    if (!recheck) {
      v("2", `request ${request.id}: send-call without a dial-time eligibility recheck`);
      continue;
    }
    for (const w of ctx?.writes ?? []) {
      if (w.doneTick < recheck.tick) v("2", `request ${request.id}: dialled although a ${w.kind} write had committed before the dial-time recheck`);
      else if (w.doneTick < send.tick && w.startTick < send.tick) stats.windowRaces += 1;
    }
  }

  // ===== [3] outcome-specific effects, exactly once ==========================
  const tasksByKey = new Map<string, Record<string, unknown>[]>();
  for (const t of tasks) tasksByKey.set(t.source_key, [...(tasksByKey.get(t.source_key) ?? []), t]);
  for (const r of requests) {
    const ctx = ctxOf(r.property_id);
    const ev = events.filter((e) => e.source_id === r.id || e.payload?.request_id === r.id);
    const completedEvents = ev.filter((e) => e.event_type === "norma_call_completed");
    const requestedEvents = ev.filter((e) => e.event_type === "norma_call_requested");
    const rowsForTask = tasksByKey.get(`norma_call:${r.id}`) ?? [];
    const everReviewed = audit.some((a) => a.tbl === "norma_call_requests" && a.row_id === r.id && a.new_row?.status === "needs_review");
    if (requestedEvents.length !== 1) v("3", `request ${r.id}: ${requestedEvents.length} norma_call_requested events (expected 1)`);
    if (completedEvents.length !== (r.status === "completed" ? 1 : 0)) {
      v("3", `request ${r.id} (${r.status}): ${completedEvents.length} norma_call_completed events`);
    }

    if (r.status === "completed") {
      if (!r.completed_at) v("3", `request ${r.id}: completed without completed_at`);
      if (ctx && r.outcome !== EXPECTED_OUTCOME[ctx.plan.kind]) {
        v("3", `request ${r.id}: outcome ${r.outcome} but the call was a ${ctx.plan.kind} (expected ${EXPECTED_OUTCOME[ctx.plan.kind]})`);
      }
      const calls = h.bland.callsFor(r.id);
      if (calls.length !== 1 || r.bland_call_id !== calls[0]?.callId) v("3", `request ${r.id}: completed with call id ${r.bland_call_id}, Bland placed ${calls.map((c) => c.callId).join(",") || "none"}`);
      if (r.outcome && ["callback_requested", "reached_no_callback", "wrong_number"].includes(r.outcome)) {
        if (rowsForTask.length > 1 || (rowsForTask.length === 0 && !dncLocked(r.property_id))) {
          v("3", `request ${r.id} (${r.outcome}): ${rowsForTask.length} tasks (expected exactly 1)`);
        }
        const t = rowsForTask[0];
        if (t) {
          if (t.status !== "open") v("3", `request ${r.id}: its follow-up task is ${t.status}, not open`);
          if (t.assignee_id !== r.callback_assignee_id || t.assignee_id !== h.world.assignee) v("3", `request ${r.id}: task assignee ${t.assignee_id}`);
          const title = String(t.title);
          const wantTitle = r.outcome === "callback_requested" ? /time unconfirmed/ : r.outcome === "reached_no_callback" ? /no callback time given/ : /wrong number/;
          if (!wantTitle.test(title)) v("3", `request ${r.id} (${r.outcome}): unexpected task title "${title}"`);
          if (t.type !== (r.outcome === "wrong_number" ? "custom" : "callback")) v("3", `request ${r.id}: task type ${t.type}`);
          const wantDue = r.outcome === "callback_requested" && r.callback_requested_for ? r.callback_requested_for : r.completed_at;
          if (wantDue && Date.parse(String(t.due_at)) !== Date.parse(wantDue)) v("3", `request ${r.id}: task due ${t.due_at}, expected ${wantDue}`);
        }
      } else if (r.outcome === "no_answer" || r.outcome === "not_interested") {
        if (rowsForTask.some((t) => t.status === "open" || t.status === "snoozed")) v("3", `request ${r.id} (${r.outcome}): a task is open but this outcome needs none`);
        if (!everReviewed && rowsForTask.length > 0) v("3", `request ${r.id} (${r.outcome}): a task exists but none was ever wanted`);
      }
      // Dispositions and wrong-number.
      const prop = properties.get(r.property_id);
      const dispoEvents = events.filter((e) => e.source_type === "norma_call_requests.dispo" && e.source_id === r.id);
      if (r.outcome === "not_interested") {
        const contact = contacts.get(prop?.homeowner_contact_id as string);
        const blocked = prop?.is_dnc_locked || contact?.do_not_contact;
        if (!blocked && !["not_interested", ...STRONGER_DISPOS].includes(String(prop?.outreach_dispo))) v("3", `request ${r.id}: not_interested completion left the lead at ${prop?.outreach_dispo}`);
        if (dispoEvents.length > 1) v("3", `request ${r.id}: ${dispoEvents.length} dispo events`);
      } else {
        if (dispoEvents.length > 0) v("3", `request ${r.id} (${r.outcome}): wrote a disposition event`);
        // The only dispositions the driver ever writes are not_interested and dnc.
        const wroteNI = (ctx?.writes ?? []).some((w) => w.kind === "not_interested");
        const wroteDnc = (ctx?.writes ?? []).some((w) => w.kind === "dnc");
        if (prop?.outreach_dispo === "not_interested" && !wroteNI) v("3", `request ${r.id} (${r.outcome}): lead became not_interested without that outcome or write`);
        if (r.outcome === "wrong_number" && prop?.outreach_dispo === "wrong_number") v("3", `request ${r.id}: wrong_number must not set a property disposition`);
        if (prop?.outreach_dispo === "dnc" && !wroteDnc) v("3", `request ${r.id}: lead became dnc without a DNC write`);
      }
    } else if (r.status === "needs_review") {
      const open = rowsForTask.filter((t) => t.status === "open");
      const none = rowsForTask.length === 0 && dncLocked(r.property_id);
      if (!none && (rowsForTask.length !== 1 || open.length !== 1)) v("3", `request ${r.id} (needs_review): ${rowsForTask.length} tasks / ${open.length} open (expected exactly one open review task)`);
      else if (!none && !/needs review/i.test(String(open[0]!.title))) v("3", `request ${r.id}: review task title "${open[0]!.title}"`);
    } else if (r.status === "dispatch_rejected") {
      if (rowsForTask.some((t) => t.status === "open" || t.status === "snoozed")) v("3", `request ${r.id}: dispatch_rejected but a task is still open`);
    } else if (rowsForTask.length > 0) {
      v("3", `request ${r.id} (${r.status}): has a task before any outcome`);
    }
  }
  const taskEvents = events.filter((e) => e.source_type === "tasks.created");
  if (taskEvents.length !== tasks.length) v("3", `${tasks.length} Norma tasks but ${taskEvents.length} task_created events`);

  // ===== [4] webhook hostility: right status codes, no effect on the request ==
  for (const w of h.bland.webhooks) {
    const wantStatus: Record<string, number | undefined> = { bad_signature: 401, missing_signature: 401, tampered_body: 401, malformed_json: 400, not_object: 400 };
    const want = wantStatus[w.flavor];
    if (want !== undefined && w.status !== want) v("4", `webhook ${w.flavor} answered ${w.status}, expected ${want}`);
    if (["no_metadata", "mismatch_request_id", "mismatch_key", "mismatch_number"].includes(w.flavor) && w.status !== 200) v("4", `webhook ${w.flavor} answered ${w.status}, expected an ignored 200`);
    if (w.status === 500 && !opts.allowWebhook500) v("4", `webhook ${w.flavor} for ${w.requestId} answered 500 (infrastructure failure with no fault injected)`);
  }

  // ===== [5] pause ownership and preservation (every transition) =============
  for (const a of audit.filter((x) => x.tbl === "sequence_enrollments")) {
    const o = a.old_row;
    const n = a.new_row;
    if (!n) continue;
    if (a.op === "INSERT") {
      if (n.status === "active" && a.hold_open) v("5", `enrollment ${a.row_id} was created active while a Norma hold was open`);
      continue;
    }
    if (!o) continue;
    if (o.status === "paused" && n.status === "active" && a.hold_open) v("5", `enrollment ${a.row_id} resumed (was ${o.pause_reason}) while a Norma hold was open`);
    if (REPLY_REASONS.includes(String(o.pause_reason)) && o.status === "paused" && n.status === "active") v("5", `enrollment ${a.row_id}: ${o.pause_reason} pause was resumed`);
    if (o.status === "opted_out" && n.status !== "opted_out") v("5", `enrollment ${a.row_id}: opted_out was reopened (${n.status})`);
    if (REPLY_REASONS.includes(String(o.pause_reason)) && ["norma_call", "call_in_progress"].includes(String(n.pause_reason)) && n.status === "paused") {
      v("5", `enrollment ${a.row_id}: ${o.pause_reason} was downgraded to ${n.pause_reason}`);
    }
  }
  for (const p of pauses) {
    const request = requests.find((r) => r.id === p.request_id)!;
    if (["no_answer"].includes(String(request.outcome)) || request.status === "dispatch_rejected") {
      if (!p.released_at) {
        v("5", `request ${request.id} (${request.status}/${request.outcome}): owned pause on ${p.enrollment_id} was never released`);
        continue;
      }
      const prop = properties.get(p.property_id);
      const contact = contacts.get(prop?.homeowner_contact_id as string);
      const changed = audit.some(
        (a) =>
          a.tbl === "sequence_enrollments" && a.row_id === p.enrollment_id && a.op === "UPDATE" &&
          a.old_row?.pause_reason === "norma_call" && (a.new_row?.pause_reason !== "norma_call" || a.new_row?.status !== "paused") &&
          a.new_row?.pause_reason !== null,
      );
      const ineligible =
        prop?.is_dnc_locked || RELEASE_BLOCK_DISPOS.includes(String(prop?.outreach_dispo)) || contact?.do_not_contact || contact?.sms_opted_out;
      if (p.release_result === "resumed") continue;
      if (p.release_result === "reason_changed" && changed) continue;
      if (p.release_result === "not_eligible" && ineligible) continue;
      v("5", `request ${request.id}: owned pause on ${p.enrollment_id} released as "${p.release_result}" without justification (eligible lead, unchanged pause)`);
    }
  }
  // A held lead must not end up stuck: no softphone pause may remain once nothing holds the lead.
  const openProps = new Set(requests.filter((r) => OPEN.includes(r.status)).map((r) => r.property_id));
  if (opts.settled) {
    for (const e of enrollments) {
      if (e.status === "paused" && e.pause_reason === "call_in_progress" && !openProps.has(e.property_id)) {
        v("5", `enrollment ${e.id}: still paused as call_in_progress with no hold and the stale sweep running (stuck forever)`);
      }
      if (e.status === "paused" && e.pause_reason === "norma_call" && !openProps.has(e.property_id)) {
        const rs = reqsByProperty.get(e.property_id) ?? [];
        const keeps = rs.some((r) => r.status === "completed" && r.outcome !== "no_answer");
        const prop = properties.get(e.property_id);
        const ineligible = prop?.is_dnc_locked || RELEASE_BLOCK_DISPOS.includes(String(prop?.outreach_dispo));
        if (!keeps && !ineligible) v("5", `enrollment ${e.id}: left paused as norma_call after the call ended without keeping the drip paused`);
      }
    }
    for (const r of requests) {
      if (r.status === "completed" && r.outcome !== "no_answer" && reqsByProperty.get(r.property_id)!.length === 1) {
        for (const e of enrollments.filter((x) => x.property_id === r.property_id && x.status === "active")) {
          v("5", `request ${r.id} (${r.outcome}) kept no hold but enrollment ${e.id} is active (the drip must stay paused)`);
        }
      }
    }
  }

  // ===== [6] ambiguity keeps the fence; completed never regresses ============
  for (const r of requests) {
    const rows = audit.filter((a) => a.tbl === "norma_call_requests" && a.row_id === r.id && a.op === "UPDATE");
    let completed: Record<string, unknown> | null = null;
    for (const a of rows) {
      if (completed) {
        const n = a.new_row!;
        if (n.status !== "completed" || n.outcome !== completed.outcome || n.completed_at !== completed.completed_at || n.bland_call_id !== completed.bland_call_id) {
          v("6", `request ${r.id}: a completed request changed (${completed.status}/${completed.outcome} -> ${n.status}/${n.outcome})`);
        }
      } else if (a.new_row?.status === "completed") completed = a.new_row;
    }
  }
  const notificationCount = new Map<string, number>();
  for (const n of notifications) notificationCount.set(n.request_id, (notificationCount.get(n.request_id) ?? 0) + 1);

  // ===== [7] terminal reachability within the horizon ========================
  if (opts.settled) {
    for (const r of requests) {
      if (!SETTLED.includes(r.status)) v("7", `request ${r.id} is still ${r.status} after the virtual horizon with recovery workers running`);
    }
  }

  // ===== [8] Slack ===========================================================
  const notificationsByRequest = new Map(notifications.map((n) => [n.request_id as string, n]));
  for (const r of requests) {
    const want = r.status === "completed" ? 1 : 0;
    const got = notificationCount.get(r.id) ?? 0;
    if (got !== want) v("8", `request ${r.id} (${r.status}): ${got} outbox rows (expected ${want})`);
    if (opts.settled && want === 1) {
      const n = notificationsByRequest.get(r.id);
      if (n?.status !== "sent") v("8", `request ${r.id}: outbox row is ${n?.status} after the horizon (Slack should eventually succeed)`);
    }
  }
  // Posts are keyed by lead (the message carries the lead link): one accepted
  // post per COMPLETED request on that lead, none otherwise.
  if (opts.settled) {
    for (const [property, list] of reqsByProperty) {
      const want = list.filter((r) => r.status === "completed").length;
      const got = h.slack.postsFor(property).length;
      if (got !== want) v("8", `property ${property}: ${got} Slack posts accepted for ${want} completed requests (no ambiguous acceptance in this run)`);
    }
  }
  for (const e of h.trace.events.filter((x) => x.actor === "slack" && x.phase === "start")) {
    const ok = e.what.startsWith("select:") || e.what === "update:norma_notifications";
    if (!ok) v("8", `the Slack worker issued ${e.what}; it may only read and update the outbox`);
  }
  return { violations: out, stats };
}

/** Background snapshot poller: no active enrollment while a Norma hold is open. */
export function startHoldPoller(h: Harness) {
  const violations: string[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { rows } = await h.scratch.pool.query(
        `select e.id as enrollment, r.id as request, r.status
           from public.sequence_enrollments e join public.norma_call_requests r on r.property_id = e.property_id
          where r.org_id = $1 and e.status = 'active' and r.status in ('requested','dispatching','dispatched','dispatch_unknown','needs_review')`,
        [h.world.org],
      );
      for (const row of rows) violations.push(`[5] snapshot: enrollment ${row.enrollment} is active while request ${row.request} (${row.status}) holds the lead`);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  })();
  return {
    violations,
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}
