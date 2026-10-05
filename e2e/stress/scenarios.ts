import { randomUUID } from "node:crypto";

import {
  addNote, awaitDialWindow, callIdFor, createAppointment, currentOpenTaskInChain, finalizeAttempt, pendingCallActivity,
  rescheduleAppointment, runCron, seedSellerReplyHistory, sendCallEvents, sleep, startDial, type CallState, type Ctx,
} from "./actions";
import { contractSend, logStalePendingOffer, reconcileSendUnknown, supersedeAndLog } from "./contract";
import { asRep, asService } from "./db";
import { expireIntent, backdateDispatch, makeReminderDue, runStaleSweep, scheduleReminders } from "./levers";
import type { QuickPickName, ScenarioId, Tick } from "./manifest";
import type { WorldLead } from "./world";
import { addLeadOnSharedContact } from "../support/my-leads-p2-fixture";

/** What a tick actually did, recorded for the oracle (which compares it to the schedule, not to itself). */
export type TickRecord = {
  tick: number;
  scenario: string;
  actor: string;
  leadSlot: number;
  leadId: string | null;
  leadPhone: string | null;
  startedAt: string;
  finishedAt: string;
  /** The instant the quick pick was computed from (appointment due = quickPickDueAt(pick, actionTime)). */
  actionTime: string | null;
  appointmentTaskId: string | null;
  callIds: string[];
  intentIds: string[];
  contractIntents: string[];
  rejections: Array<{ step: string; code: string }>;
  /** When the lever expired the first intent (double-click scenario): a second dial must come after this. */
  expiredAt: string | null;
  steps: string[];
  error: string | null;
};

type Impl = (ctx: Ctx, tick: Tick, lead: WorldLead, rec: TickRecord) => Promise<void>;

const marker = (tick: Tick) => tick.expected.noteMarker ?? null;

/**
 * Save the post-call prompt the way the prompt does: the attempt (outcome), then `savePostCallExtras`, whose note and
 * next step are keyed by the prompt's one `submissionId` (lead_notes.idempotency_key and the booking key). A second tab
 * has its OWN prompt instance, so every key is fresh.
 */
async function savePromptOnce(ctx: Ctx, tick: Tick, lead: WorldLead, rec: TickRecord, opts: { pick?: QuickPickName; tab?: number; occurredAt?: string } = {}): Promise<void> {
  const tab = opts.tab ?? 1;
  const activity = await pendingCallActivity(ctx, lead);
  if (!activity) throw new Error("no call activity to finalize (the webhook projection did not create an attempt)");
  const submissionId = randomUUID();
  const fin = await finalizeAttempt(ctx, lead, { callActivityId: activity, key: randomUUID(), occurredAt: opts.occurredAt ?? new Date().toISOString(), outcome: tick.expected.attemptOutcome ?? "reached", note: undefined });
  if (!fin.ok) rec.rejections.push({ step: `finalize_tab${tab}`, code: fin.code ?? "?" });
  else if (tab > 1) rec.steps.push(`tab${tab} finalize accepted (duplicate=${String(fin.duplicate)})`);
  const m = marker(tick);
  if (m) {
    // Fault wrong_lead_note: the note lands on the NEXT lead (a defect the oracle must catch).
    const target = tab === 1 && ctx.faults.take("wrong_lead_note") ? ctx.world.leads[(lead.slot + 1) % ctx.world.leads.length]!.propertyId : lead.propertyId;
    const n = await addNote(ctx, target, m, submissionId);
    if (!n.ok) rec.rejections.push({ step: `note_tab${tab}`, code: n.code ?? "?" });
  }
  const pick = opts.pick ?? tick.expected.appointment?.pick;
  if (pick) {
    rec.actionTime = new Date().toISOString();
    const a = await createAppointment(ctx, lead, { title: `Call ${lead.address}`, pick, now: new Date(rec.actionTime), key: submissionId });
    if (a.ok) rec.appointmentTaskId = rec.appointmentTaskId ?? a.taskId ?? null;
    else rec.rejections.push({ step: `next_step_tab${tab}`, code: a.code ?? "?" });
  }
}

const savePrompt = (ctx: Ctx, tick: Tick, lead: WorldLead, rec: TickRecord, opts: { pick?: QuickPickName } = {}) => savePromptOnce(ctx, tick, lead, rec, opts);

/** One complete dial: intent -> authorize -> provider dispatch -> signed events. Returns the call id. */
async function dialAndEvents(ctx: Ctx, tick: Tick, lead: WorldLead, rec: TickRecord, opts: { order?: readonly CallState[]; dupes?: number; n?: number; delayMs?: number; durationMs?: number } = {}): Promise<{ callId: string; customData: string; intentId: string }> {
  const started = await startDial(ctx, lead);
  const intent = started.intent!;
  rec.intentIds.push(intent.intentId);
  rec.steps.push(`dispatch:${started.dispatch!.status}`);
  const callId = callIdFor(ctx.cfg, tick.tick, opts.n ?? 1);
  rec.callIds.push(callId);
  const ev = await sendCallEvents(ctx, lead, { callId, customData: intent.customData, order: opts.order, dupes: opts.dupes, delayMs: opts.delayMs, durationMs: opts.durationMs });
  rec.steps.push(`events:${ev.join(",")}`);
  return { callId, customData: intent.customData, intentId: intent.intentId };
}

const cleanCall: Impl = async (ctx, tick, lead, rec) => {
  await dialAndEvents(ctx, tick, lead, rec, { delayMs: Number(tick.args.delayMs ?? 0), durationMs: Number(tick.args.durationMs ?? 3000) });
  await savePrompt(ctx, tick, lead, rec);
};

const duplicateWebhooks: Impl = async (ctx, tick, lead, rec) => {
  await dialAndEvents(ctx, tick, lead, rec, { dupes: Number(tick.args.duplicates ?? 2), delayMs: Number(tick.args.delayMs ?? 0) });
  await savePrompt(ctx, tick, lead, rec);
};

const outOfOrder: Impl = async (ctx, tick, lead, rec) => {
  await dialAndEvents(ctx, tick, lead, rec, { order: (tick.args.order as CallState[]) ?? ["hangup", "connected", "calling"] });
  await savePrompt(ctx, tick, lead, rec);
};

const lateHangupAfterExpiry: Impl = async (ctx, tick, lead, rec) => {
  const started = await startDial(ctx, lead);
  const intent = started.intent!;
  rec.intentIds.push(intent.intentId);
  rec.steps.push(`dispatch:${started.dispatch!.status}`);
  // Lever: authorized long ago, no provider event yet -> the stale sweep marks it failed (a marker, not a verdict).
  await backdateDispatch(ctx.db, intent.intentId, 150);
  rec.expiredAt = new Date().toISOString();
  const swept = await runStaleSweep(ctx.db, 30);
  rec.steps.push(`stale_sweep:${swept}`);
  // The hangup arrives late and must still match, creating exactly one attempt.
  const callId = callIdFor(ctx.cfg, tick.tick);
  rec.callIds.push(callId);
  rec.steps.push(`events:${(await sendCallEvents(ctx, lead, { callId, customData: intent.customData, order: ["hangup", "connected", "calling"] })).join(",")}`);
  await savePrompt(ctx, tick, lead, rec);
};

const doubleClickDial: Impl = async (ctx, tick, lead, rec) => {
  await awaitDialWindow(ctx, lead);
  // One logical Call clicked twice with ONE key, concurrently. The guards are not atomic (accepted race), so both may pass;
  // the intent key and the single authorization keep it to one dial either way.
  const key = randomUUID();
  const [a, b] = await Promise.all([startDial(ctx, lead, { key, wait: false }), startDial(ctx, lead, { key, wait: false })]);
  const first = a.intent ?? b.intent;
  if (!first) throw new Error(`double click produced no intent (${a.refused}, ${b.refused})`);
  if (a.intent && b.intent && a.intent.intentId !== b.intent.intentId) rec.rejections.push({ step: "same_key_two_intents", code: "SPLIT" });
  rec.intentIds.push(first.intentId);
  rec.steps.push(`double_click:${a.dispatch?.status ?? a.refused}+${b.dispatch?.status ?? b.refused}`);
  // Fresh-key retry while the first is still in flight: the app must refuse (call_in_flight / prior_call_unresolved), never dial.
  const inflight = await startDial(ctx, lead, { key: randomUUID(), wait: false });
  if (inflight.refused) rec.rejections.push({ step: "fresh_key_in_flight", code: inflight.refused });
  else {
    rec.intentIds.push(inflight.intent!.intentId);
    if (inflight.dispatch?.dialed) rec.rejections.push({ step: "second_dial_in_flight", code: "DIALED_TWICE" });
  }
  // No provider event arrives; the intent expires (lever); the retry with a fresh key dials once.
  await expireIntent(ctx.db, first.intentId);
  rec.expiredAt = new Date().toISOString();
  const retry = await startDial(ctx, lead, { key: randomUUID() });
  rec.intentIds.push(retry.intent!.intentId);
  rec.steps.push(`retry_dispatch:${retry.dispatch!.status}`);
  const callId = callIdFor(ctx.cfg, tick.tick);
  rec.callIds.push(callId);
  rec.steps.push(`events:${(await sendCallEvents(ctx, lead, { callId, customData: retry.intent!.customData })).join(",")}`);
  await savePrompt(ctx, tick, lead, rec);
};

const nativeAssign: Impl = async (ctx, tick, lead, rec) => {
  // Two leads on one contact -> an ambiguous native call (no intent) -> Assign to lead.
  const other = await addLeadOnSharedContact(ctx.db, { orgId: ctx.cfg.orgId, repUserId: ctx.world.repUserId, contactId: lead.contactId, runTag: ctx.cfg.runTag });
  rec.steps.push(`second_lead:${other.slice(0, 8)}`);
  const callId = callIdFor(ctx.cfg, tick.tick);
  rec.callIds.push(callId);
  rec.steps.push(`events:${(await sendCallEvents(ctx, lead, { callId, direction: "outbound" })).join(",")}`);
  const amb = await ctx.db.query("select count(*)::int n from public.dialpad_call_events where provider_call_id=$1 and disposition <> 'matched'", [callId]);
  rec.steps.push(`quarantined_events:${amb.rows[0]!.n}`);
  const assign = await asRep(ctx.db, ctx.world.repUserId, (c) => c.query("select public.fn_assign_native_call_to_lead($1,$2,$3) as v", [ctx.cfg.orgId, callId, lead.propertyId])).catch((e: { code?: string; message: string }) => {
    rec.rejections.push({ step: "assign", code: e.code ?? e.message });
    return null;
  });
  if (assign) rec.steps.push("assigned");
  await savePrompt(ctx, tick, lead, rec);
};

const lostResponse: Impl = async (ctx, tick, lead, rec) => {
  const variant = String(tick.args.variant);
  if (variant === "contract") {
    const gate = ctx.stub.gates.arm("provider_accepted", { source: "dropbox_sign" });
    const sending = contractSend(ctx, lead, { loseResponse: true });
    await ctx.stub.gates.waitReached(gate, ctx.cfg.tickDeadlineMs);
    ctx.stub.gates.release(gate);
    const result = await sending;
    rec.contractIntents.push(result.intent);
    rec.steps.push(`contract:${result.state}`);
    // Reconcile: the provider has the request; the local row is recovered from it, never resent.
    rec.steps.push(`reconcile:${await reconcileSendUnknown(ctx, result)}`);
    await runCron(ctx, "offer-projection-sweep");
    return;
  }
  // dial: provider accepted, the caller's response is lost; the retry of the SAME intent must not dial again.
  await awaitDialWindow(ctx, lead);
  const gate = ctx.stub.gates.arm("provider_accepted", { source: "dialpad" });
  const key = randomUUID();
  const first = startDial(ctx, lead, { key, wait: false, abortAfterMs: 400 });
  await ctx.stub.gates.waitReached(gate, ctx.cfg.tickDeadlineMs);
  await sleep(500); // the caller has aborted by now
  ctx.stub.gates.release(gate);
  const f = await first;
  const intent = f.intent!;
  rec.intentIds.push(intent.intentId);
  rec.steps.push(`first_dispatch:${f.dispatch?.status ?? f.refused}`);
  // The retry of the same logical call: the guards (own intent still in flight) or authorize (already_dispatched) stop it.
  const retry = await startDial(ctx, lead, { key, wait: false });
  if (retry.refused) rec.rejections.push({ step: "retry_same_key", code: retry.refused });
  else rec.rejections.push({ step: "retry_same_key", code: retry.dispatch?.status ?? "?" });
  rec.steps.push(`retry_same_key:${retry.refused ?? retry.dispatch?.status}`);
  const callId = callIdFor(ctx.cfg, tick.tick);
  rec.callIds.push(callId);
  rec.steps.push(`events:${(await sendCallEvents(ctx, lead, { callId, customData: intent.customData })).join(",")}`);
  await runCron(ctx, "dialpad-call-events-sweep");
  await savePrompt(ctx, tick, lead, rec);
};

const secondTabRetry: Impl = async (ctx, tick, lead, rec) => {
  if (String(tick.args.variant) === "contract_send") {
    const first = await contractSend(ctx, lead);
    rec.contractIntents.push(first.intent);
    rec.steps.push(`first:${first.state}`);
    const second = await contractSend(ctx, lead); // fresh intent id from a second tab
    rec.contractIntents.push(second.intent);
    if (!second.ok) rec.rejections.push({ step: "second_tab_send", code: second.code ?? "?" });
    rec.steps.push(`second:${second.state}`);
    return;
  }
  await dialAndEvents(ctx, tick, lead, rec);
  await savePromptOnce(ctx, tick, lead, rec, { tab: 1, occurredAt: new Date().toISOString() });
  // Second tab: its own prompt instance, so a fresh key for every write.
  await savePromptOnce(ctx, tick, lead, rec, { tab: 2, occurredAt: new Date().toISOString() });
};

const reminderReschedule: Impl = async (ctx, tick, lead, rec) => {
  const variant = String(tick.args.variant);
  await seedSellerReplyHistory(ctx, lead); // a reminder to a seller with no thread is an "opening" SMS and is skipped (reported)
  rec.actionTime = new Date().toISOString();
  const appt = await createAppointment(ctx, lead, { title: `${ctx.cfg.runTag} t${tick.tick}`, pick: tick.expected.appointment!.pick, now: new Date(rec.actionTime) });
  if (!appt.ok) throw new Error(`appointment: ${appt.code}`);
  rec.appointmentTaskId = appt.taskId ?? null;
  await scheduleReminders(ctx.db, ctx.cfg.orgId);
  const due = await makeReminderDue(ctx.db, [appt.taskId!]);
  rec.steps.push(`reminder_due:${due}`);
  const reschedulePick = tick.expected.appointment?.reschedulePick;
  if (variant === "plain") {
    rec.steps.push(`cron:${(await runCron(ctx, "seller-appointment-reminders")).status}`);
  } else if (variant === "reschedule") {
    const r = await rescheduleAppointment(ctx, appt.taskId!, reschedulePick!, new Date());
    if (!r.ok) rec.rejections.push({ step: "reschedule", code: r.code ?? "?" });
    rec.appointmentTaskId = r.taskId ?? appt.taskId!;
    rec.actionTime = new Date().toISOString();
    rec.steps.push(`cron:${(await runCron(ctx, "seller-appointment-reminders")).status}`);
  } else {
    // race: the cron claims and sends while the appointment is being moved.
    const [r, cron] = await Promise.all([rescheduleAppointment(ctx, appt.taskId!, reschedulePick!, new Date()), runCron(ctx, "seller-appointment-reminders")]);
    if (!r.ok) rec.rejections.push({ step: "reschedule", code: r.code ?? "?" });
    rec.appointmentTaskId = r.taskId ?? appt.taskId!;
    rec.actionTime = new Date().toISOString();
    rec.steps.push(`race_cron:${cron.status}`);
  }
};

const contract: Impl = async (ctx, tick, lead, rec) => {
  const variant = String(tick.args.variant);
  if (variant === "double_click") {
    const intent = randomUUID();
    const [a, b] = await Promise.all([contractSend(ctx, lead, { intent }), contractSend(ctx, lead, { intent })]);
    rec.contractIntents.push(intent);
    rec.steps.push(`double_click:${a.state}+${b.state}`);
    return;
  }
  if (variant === "send_unknown") {
    const r = await contractSend(ctx, lead, { loseResponse: true });
    rec.contractIntents.push(r.intent);
    rec.steps.push(`send:${r.state}`);
    // "reconcile" here is only the projection sweep: nothing may resend or log an offer for an unknown send.
    await runCron(ctx, "offer-projection-sweep");
    await runCron(ctx, "offer-projection-sweep");
    return;
  }
  const r = await contractSend(ctx, lead);
  rec.contractIntents.push(r.intent);
  rec.steps.push(`send:${r.state}`);
};

const supersede: Impl = async (ctx, tick, lead, rec) => {
  // The projection exists first, then a stale pending offer is logged, then the contract lands: a conflict the rep resolves.
  const intent = randomUUID();
  const closing = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const proj = await asService(ctx.db, (c) =>
    c.query<{ id: string }>("select public.fn_create_offer_projection($1,$2,$3,$4,$5,'s1',$6::jsonb,25000000,$7::date,'no_motivation',null,null) as id", [ctx.cfg.orgId, lead.propertyId, ctx.world.repUserId, intent, `h-${intent}`, JSON.stringify({ offer_price: "$250,000.00" }), closing]),
  );
  await logStalePendingOffer(ctx, lead, 3);
  // Re-run the contract path on the same intent so the request row + provider send happen after the stale offer.
  const r = await contractSend(ctx, lead, { intent }).catch(() => null);
  rec.contractIntents.push(intent);
  rec.steps.push(`send:${r?.state ?? "n/a"}`);
  const rr = await asService(ctx.db, (c) => c.query("select state, conflict_code from public.acquisition_offer_projections where id=$1", [proj.rows[0]!.id]));
  rec.steps.push(`projection:${rr.rows[0]?.state}/${rr.rows[0]?.conflict_code ?? "-"}`);
  const s = await supersedeAndLog(ctx, proj.rows[0]!.id);
  if (!s.ok) rec.rejections.push({ step: "supersede", code: s.code ?? "?" });
};

const twoTabsEdits: Impl = async (ctx, tick, lead, rec) => {
  const m = marker(tick)!;
  // Two tabs, distinct notes at once; both must survive with full text, on this lead.
  const [n1, n2] = await Promise.all([addNote(ctx, lead.propertyId, m), addNote(ctx, lead.propertyId, `${m} (tab two)`)]);
  if (!n1.ok) rec.rejections.push({ step: "note_tab1", code: n1.code ?? "?" });
  if (!n2.ok) rec.rejections.push({ step: "note_tab2", code: n2.code ?? "?" });
  // One appointment exists; tab one moves it, then tab two (its own idempotency key) moves it again. One appointment, the later edit.
  const created = await createAppointment(ctx, lead, { title: `Call ${lead.address}`, pick: "tomorrow", now: new Date() });
  if (!created.ok) throw new Error(`appointment: ${created.code}`);
  rec.appointmentTaskId = created.taskId ?? null;
  const a = await rescheduleAppointment(ctx, created.taskId!, "next_week", new Date());
  if (!a.ok) rec.rejections.push({ step: "edit_tab1", code: a.code ?? "?" });
  await sleep(50);
  // Tab two still holds the OLD task id (a reschedule replaces the row): the app must refuse the stale edit...
  const stale = await rescheduleAppointment(ctx, created.taskId!, "three_days", new Date());
  if (!stale.ok) rec.rejections.push({ step: "edit_tab2_stale", code: stale.code ?? "?" });
  // ...and once tab two refreshes (reads the chain's current open task) its edit lands: one appointment, the later edit.
  const fresh = (await currentOpenTaskInChain(ctx, created.taskId!)) ?? created.taskId!;
  rec.actionTime = new Date().toISOString();
  const b = await rescheduleAppointment(ctx, fresh, "three_days", new Date(rec.actionTime));
  if (!b.ok) rec.rejections.push({ step: "edit_tab2", code: b.code ?? "?" });
  rec.appointmentTaskId = b.taskId ?? fresh;
  rec.steps.push(`edits:${a.ok ? "ok" : a.code}/stale:${stale.ok ? "accepted" : stale.code}/${b.ok ? "ok" : b.code}`);
};

const offlineSend: Impl = async (ctx, tick, lead, rec) => {
  // Offline during Send, then back online: the client replays the SAME intent. One provider request.
  const intent = randomUUID();
  const first = await contractSend(ctx, lead, { intent });
  const replay = await contractSend(ctx, lead, { intent });
  rec.contractIntents.push(intent);
  rec.steps.push(`first:${first.state} replay:${replay.state}`);
};

export const IMPLS: Record<ScenarioId, Impl> = {
  clean_call: cleanCall,
  duplicate_webhooks: duplicateWebhooks,
  out_of_order: outOfOrder,
  late_hangup_after_expiry: lateHangupAfterExpiry,
  double_click_dial: doubleClickDial,
  native_assign: nativeAssign,
  lost_response: lostResponse,
  second_tab_retry: secondTabRetry,
  reminder_reschedule: reminderReschedule,
  contract,
  supersede,
  two_tabs_edits: twoTabsEdits,
  offline_send: offlineSend,
};

export function newRecord(tick: Tick, lead: WorldLead | null): TickRecord {
  return {
    tick: tick.tick, scenario: tick.scenario, actor: tick.actor, leadSlot: tick.leadSlot, leadId: lead?.propertyId ?? null, leadPhone: lead?.phoneE164 ?? null,
    startedAt: new Date().toISOString(), finishedAt: "", actionTime: null, appointmentTaskId: null, callIds: [], intentIds: [], contractIntents: [],
    rejections: [], expiredAt: null, steps: [], error: null,
  };
}
