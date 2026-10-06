import { quickPickDueAt } from "../../src/lib/my-leads/quick-picks";
import { asRep, type Db } from "./db";
import type { Tick } from "./manifest";
import type { TickRecord } from "./scenarios";
import type { StubServer } from "./stubs";
import type { World } from "./world";

/**
 * The oracle. Two tiers, both pure SQL + assertions over rows and the provider stub logs:
 *
 *   Safety invariants 1-10: checked every 30 s and at the end; they must ALWAYS hold.
 *   Expected outcomes 11-16: checked once after a bounded drain; they compare the SCHEDULE's expected
 *     column (never rows against rows) to what exists. Planned totals are asserted equal to observed
 *     totals, so nothing passes by doing nothing.
 *
 * Unresolved rules (offersSent with supersede, owner-mismatch, reassign target, motivation-required,
 * earnest money) are REPORTED by `pendingJarradObservations`, never asserted, never counted in PASS.
 */

export type Violation = Record<string, unknown>;
export type Check = {
  id: number;
  name: string;
  tier: "invariant" | "outcome";
  ok: boolean;
  violations: Violation[];
  /** Set when this check could not run in this scope (e.g. rendered parity needs the browser lane). Not a pass. */
  deferred?: string;
  detail?: string;
};

export type OracleInput = {
  db: Db;
  orgId: string;
  runTag: string;
  runStart: Date;
  /** The reminder job decides quiet hours from the real clock (08:00-21:00 in the lead's zone); false when the run left that window. */
  reminderWindowOpen?: boolean;
  world: World;
  stub: StubServer;
  schedule: readonly Tick[];
  records: readonly TickRecord[];
  /** Browser-lane ticks that were scheduled but not executed in this run (replay scope). */
  browserDeferred: boolean;
  /** Filled by the checks: findings that matched an allowlist entry (reported, not failed). */
};

const P = "(select id from public.properties where org_id=$1 and address like $2 || '%')";
const arg = (i: OracleInput) => [i.orgId, i.runTag];
const rows = async (i: OracleInput, sql: string, extra: unknown[] = []) => (await i.db.query(sql, [...arg(i), ...extra])).rows as Violation[];

const mk = (id: number, name: string, tier: Check["tier"], violations: Violation[], extra: Partial<Check> = {}): Check => ({ id, name, tier, ok: violations.length === 0 && !extra.deferred, violations, ...extra });

// ------------------------------------------------------------------------------------------------
// Safety invariants

export async function safetyInvariants(i: OracleInput): Promise<Check[]> {
  const out: Check[] = [];

  // 1. One dial per intent key (stub log grouped by intent token; intents grouped by idempotency_key).
  const perKey = new Map<string, number>();
  for (const d of i.stub.dials()) if (d.key) perKey.set(d.key, (perKey.get(d.key) ?? 0) + 1);
  const v1: Violation[] = [...perKey.entries()].filter(([, n]) => n > 1).map(([key, n]) => ({ source: "stub", intentToken: key.slice(0, 24), dials: n }));
  v1.push(...(await rows(i, `select 'db' as source, idempotency_key, count(*)::int as intents from public.dialpad_call_intents where org_id=$1 and property_id in ${P} group by org_id, idempotency_key having count(*)>1`)));
  out.push(mk(1, "one dial per intent key", "invariant", v1));

  // 2. One attempt per Dialpad call.
  out.push(mk(2, "one attempt per Dialpad call", "invariant", [
    ...(await rows(i, `select 'call_activities' as source, provider_call_id, count(*)::int as n from public.call_activities where org_id=$1 and provider='dialpad' and property_id in ${P} and provider_call_id is not null group by provider_call_id having count(*)>1`)),
    ...(await rows(i, `select 'attempts' as source, call_activity_id, count(*)::int as n from public.acquisition_attempts where org_id=$1 and property_id in ${P} and source='dialpad' and call_activity_id is not null group by call_activity_id having count(*)>1`)),
  ]));

  // 3. Right lead dialled: schedule -> stub -> row (not row -> row).
  const v3: Violation[] = [];
  // From the schedule and the world (not from finished tick records): a dial may be in flight when this runs.
  const scheduledPhones = new Set(i.schedule.filter((t) => t.leadSlot >= 0 && t.expected.dials > 0).map((t) => i.world.leads[t.leadSlot]!.phoneE164));
  for (const d of i.stub.dials()) if (d.phone && !scheduledPhones.has(d.phone)) v3.push({ source: "stub", dialledPhone: d.phone, reason: "no scheduled dial for this number" });
  for (const r of i.records) {
    if (!r.leadId || !r.leadPhone) continue;
    for (const intentId of r.intentIds) {
      const it = (await i.db.query<{ custom_data: string }>("select custom_data from public.dialpad_call_intents where id=$1", [intentId])).rows[0];
      if (!it) continue;
      for (const d of i.stub.dials()) if (d.key === it.custom_data && d.phone !== r.leadPhone) v3.push({ tick: r.tick, scheduledPhone: r.leadPhone, stubPhone: d.phone });
    }
    for (const callId of r.callIds) {
      const a = (await i.db.query<{ property_id: string }>("select a.property_id from public.call_activities c join public.acquisition_attempts a on a.call_activity_id=c.id where c.org_id=$1 and c.provider_call_id=$2", [i.orgId, callId])).rows;
      for (const x of a) if (x.property_id !== r.leadId) v3.push({ tick: r.tick, callId, scheduledLead: r.leadId, attemptOn: x.property_id });
    }
  }
  out.push(mk(3, "right lead dialled", "invariant", v3));

  // 4. At most one open contract per property; logical contracts per property bounded by the schedule's revision count.
  const v4 = await rows(i, `select property_id, count(*)::int as open_projections from public.acquisition_offer_projections where org_id=$1 and property_id in ${P} and state in ('awaiting_send','pending','conflict') group by property_id having count(*)>1`);
  for (const r of i.records) {
    if (!r.leadId) continue;
    const allowed = i.schedule.find((t) => t.tick === r.tick)?.expected.contracts ?? 0;
    const n = (await i.db.query<{ n: number }>("select count(*)::int n from public.esign_requests where property_id=$1", [r.leadId])).rows[0]!.n;
    if (n > allowed) v4.push({ tick: r.tick, lead: r.leadId, esignRequests: n, allowed });
  }
  out.push(mk(4, "open contracts <= 1; logical contracts <= schedule", "invariant", v4));

  // 5. Offers per esign_request = 1; pending offers per property <= 1; an offer is logged only once the stub shows `sent`.
  const v5 = [
    ...(await rows(i, `select 'projections_per_request' as rule, esign_request_id, count(*)::int n from public.acquisition_offer_projections where org_id=$1 and property_id in ${P} and esign_request_id is not null group by esign_request_id having count(*)>1`)),
    ...(await rows(i, `select 'pending_offers' as rule, property_id, count(*)::int n from public.acquisition_offers where org_id=$1 and property_id in ${P} and outcome='pending' group by property_id having count(*)>1`)),
  ];
  const logged = (await i.db.query<{ id: string; esign_request_id: string; sign_request_id: string | null }>(
    `select p.id, p.esign_request_id, r.sign_request_id from public.acquisition_offer_projections p join public.esign_requests r on r.id=p.esign_request_id where p.org_id=$1 and p.property_id in ${P} and p.state='logged'`, arg(i))).rows;
  for (const l of logged) if (!l.sign_request_id || !i.stub.sends().some((s) => s.key === l.esign_request_id)) v5.push({ rule: "logged_without_sent", projection: l.id, request: l.esign_request_id });
  out.push(mk(5, "one offer per request; offer only after sent", "invariant", v5));

  // 6. Reminders: one send per chain per Chicago day; mock outbound per contact per Chicago day <= 1.
  out.push(mk(6, "reminders: one per chain per day", "invariant", [
    ...(await rows(i, `select calendar_chain_id, send_local_date, count(*)::int n from public.seller_appointment_reminders where org_id=$1 and property_id in ${P} and status in ('claimed','sent','uncertain') group by 1,2 having count(*)>1`)),
    ...(await rows(i, `select contact_id, ((sent_at at time zone 'America/Chicago')::date) as day, count(*)::int n from public.messages where org_id=$1 and direction='outbound' and provider='mock' and property_id in ${P} and idempotency_key in (select send_key from public.seller_appointment_reminders) group by 1,2 having count(*)>1`)),
  ]));

  // 7. Resend detection via receipts: outbound messages per send_key <= 1; an `uncertain` reminder adds no further message.
  out.push(mk(7, "no resend (provider receipts); no non-mock outbound", "invariant", [
    // N5: the run is stub/test only. Any outbound message from a provider other than the mock is a live send and turns the run red.
    ...(await rows(i, `select id, provider from public.messages where org_id=$1 and $2::text is not null and direction='outbound' and provider <> 'mock' and created_at >= $3`, [i.runStart])),
    ...(await rows(i, `select idempotency_key, count(*)::int n from public.messages where org_id=$1 and direction='outbound' and property_id in ${P} and idempotency_key is not null group by idempotency_key having count(*)>1`)),
    ...(await rows(i, `select r.id, count(m.id)::int messages from public.seller_appointment_reminders r join public.messages m on m.idempotency_key=r.send_key where r.org_id=$1 and r.property_id in ${P} and r.status='uncertain' group by r.id having count(m.id)>1`)),
    ...[...(function* () { const per = new Map<string, number>(); for (const s of i.stub.sends()) if (s.key) per.set(s.key, (per.get(s.key) ?? 0) + 1); for (const [k, n] of per) if (n > 1) yield { source: "stub_contract_send", request: k, sends: n }; })()],
  ]));

  // 8. No retired task types created during the run.
  out.push(mk(8, "no retired task types", "invariant", await rows(i, `select id, type from public.tasks where org_id=$1 and related_property_id in ${P} and type in ('follow_up','callback') and created_at >= $3`, [i.runStart])));

  // 9. No orphans.
  out.push(mk(9, "no orphans", "invariant", [
    ...(await rows(i, `select 'reminder_task' as rule, r.id from public.seller_appointment_reminders r where r.org_id=$1 and r.property_id in ${P} and not exists (select 1 from public.tasks t where t.id=r.task_id)`)),
    ...(await rows(i, `select 'projection_request' as rule, p.id from public.acquisition_offer_projections p where p.org_id=$1 and p.property_id in ${P} and p.esign_request_id is not null and not exists (select 1 from public.esign_requests e where e.id=p.esign_request_id)`)),
    ...(await rows(i, `select 'call_without_event' as rule, c.provider_call_id from public.call_activities c where c.org_id=$1 and c.provider='dialpad' and c.property_id in ${P} and c.provider_call_id is not null and not exists (select 1 from public.dialpad_call_events e where e.org_id=c.org_id and e.provider_call_id=c.provider_call_id)`)),
    ...(await rows(i, `select 'offer_chain' as rule, o.id from public.acquisition_offers o where o.org_id=$1 and o.property_id in ${P} and o.follow_up_calendar_chain_id is not null and not exists (select 1 from public.tasks t where t.calendar_chain_id=o.follow_up_calendar_chain_id)`)),
  ]));

  // 10. Strip sanity.
  const v10: Violation[] = [];
  try {
    const strip = await asRep(i.db, i.world.repUserId, (c) => c.query<{ v: { rows: Array<{ propertyId: string; tier: number }> } }>("select public.fn_get_my_leads_call_next($1,$2,25) as v", [i.orgId, i.world.repUserId]));
    const list = strip.rows[0]!.v.rows;
    const seen = new Set<string>();
    for (const r of list) {
      if (seen.has(r.propertyId)) v10.push({ rule: "duplicate_property", propertyId: r.propertyId });
      seen.add(r.propertyId);
      const callable = (await i.db.query<{ n: number }>("select count(*)::int n from public.properties p join public.contacts c on c.id=p.homeowner_contact_id where p.id=$1 and coalesce(c.phone_1,c.phone_2,c.phone_3) is not null and not coalesce(c.do_not_contact,false) and not coalesce(p.is_dnc_locked,false)", [r.propertyId])).rows[0]!.n;
      if (callable === 0) v10.push({ rule: "no_callable_phone", propertyId: r.propertyId });
      if (r.tier === 1) {
        const due = (await i.db.query<{ n: number }>("select count(*)::int n from public.tasks where related_property_id=$1 and type='appointment' and status='open' and due_at <= now()", [r.propertyId])).rows[0]!.n;
        if (due === 0) v10.push({ rule: "tier1_without_due_appointment", propertyId: r.propertyId });
      }
    }
  } catch (e) {
    v10.push({ rule: "strip_rpc_failed", error: (e as Error).message });
  }
  out.push(mk(10, "strip sanity", "invariant", v10));
  return out;
}

// ------------------------------------------------------------------------------------------------
// Expected outcomes (after drain)

const finalPick = (t: Tick) => t.expected.appointment?.reschedulePick ?? t.expected.appointment?.pick;

export type ReminderRow = { id: string; status: string; task_status: string | null; messages: number };

export async function fetchReminderRows(db: Pick<OracleInput, "db">["db"], leadId: string): Promise<ReminderRow[]> {
  return (await db.query<ReminderRow>(
    `select r.id, r.status, t.status as task_status,
            (select count(*)::int from public.messages m where m.idempotency_key = r.send_key and m.direction='outbound') as messages
       from public.seller_appointment_reminders r left join public.tasks t on t.id = r.task_id where r.property_id = $1`, [leadId])).rows;
}

/**
 * Seller reminders as exact counts, not upper bounds. `expected` is the schedule's `reminderSent` (1 sent, 0 sent, or undefined for the race, which
 * may send once or not at all). The messages are counted by the reminder's send key, so a row marked sent without a message, or a message without
 * a sent row, both fail. A slot whose appointment was replaced or cancelled never gets a text, and the plain "reschedule" variant must show the
 * old slot's reminder as cancelled.
 */
export function reminderProblems(rows: readonly ReminderRow[], expected: number | undefined, variant: string, windowOpen = true): Violation[] {
  const out: Violation[] = [];
  // The reminder job decides quiet hours from the REAL clock (08:00-21:00 in the lead's zone; E2E_QUIET_HOURS_NOW is not honored there). Outside
  // the window nothing may be sent at all; the send path is then not exercised, and the run says so (decide: reduced, never PASS).
  if (!windowOpen) expected = 0;
  const sent = rows.filter((r) => r.status === "sent").length;
  const msgs = rows.reduce((n, r) => n + r.messages, 0);
  if (expected !== undefined) {
    if (sent !== expected) out.push({ rule: "reminder_sent_rows", expected, observed: sent });
    if (msgs !== expected) out.push({ rule: "reminder_messages", expected, observed: msgs });
  } else {
    if (sent > 1) out.push({ rule: "reminder_sent_rows_race", max: 1, observed: sent });
    if (msgs !== sent) out.push({ rule: "reminder_messages_match_sent_rows", sentRows: sent, messages: msgs });
  }
  for (const r of rows) {
    const slotGone = r.task_status !== null && !["open", "snoozed"].includes(r.task_status);
    if ((slotGone || r.status === "cancelled") && r.messages > 0) out.push({ rule: "message_for_cancelled_slot", reminder: r.id, messages: r.messages });
    if (r.messages > 0 && r.status !== "sent" && r.status !== "uncertain") out.push({ rule: "message_without_sent_row", reminder: r.id, status: r.status });
  }
  if (variant === "reschedule" && !rows.some((r) => r.status === "cancelled")) out.push({ rule: "old_slot_reminder_not_cancelled" });
  return out;
}

export type Receipt = { phone: string | null; key: string | null; at?: string };
export type AuthorizedIntent = { custom_data: string; destination_e164: string };

/**
 * Dial verdict for one lead from PROVIDER receipts (the stub server's record of what was actually sent): the count must equal the schedule's,
 * and every receipt must carry a distinct intent key that was authorized for THIS lead whose recorded destination is the number the provider was
 * asked to ring. Authorization rows alone never count as a dial. Pure, so each case (zero, duplicate, wrong number) is unit-tested.
 */
export function dialProblems(receipts: readonly Receipt[], intents: readonly AuthorizedIntent[], leadPhone: string, expectedDials: number): Violation[] {
  const mine = receipts.filter((d) => d.phone === leadPhone);
  const out: Violation[] = [];
  if (mine.length !== expectedDials) out.push({ rule: "dials", expected: expectedDials, observed: mine.length });
  const byKey = new Map(intents.map((x) => [x.custom_data, x.destination_e164]));
  const seen = new Set<string>();
  for (const d of mine) {
    if (!d.key || !byKey.has(d.key)) { out.push({ rule: "receipt_without_authorized_intent", key: d.key, phone: d.phone }); continue; }
    if (seen.has(d.key)) out.push({ rule: "duplicate_receipt_for_intent", key: d.key });
    seen.add(d.key);
    if (byKey.get(d.key) !== d.phone) out.push({ rule: "receipt_destination_differs_from_intent", key: d.key, intent: byKey.get(d.key), receipt: d.phone });
  }
  // A receipt for a destination that is NOT this lead's number but carries one of this lead's intent keys is a wrong-number call.
  for (const d of receipts) if (d.phone !== leadPhone && d.key && byKey.has(d.key)) out.push({ rule: "wrong_number_for_intent", key: d.key, ringed: d.phone, intended: byKey.get(d.key) });
  return out;
}

export async function expectedOutcomes(i: OracleInput): Promise<Check[]> {
  const out: Check[] = [];
  const executed = i.records.filter((r) => r.actor !== "noise");
  const byTick = new Map(i.schedule.map((t) => [t.tick, t]));
  const plannedExecutable = i.schedule.filter((t) => t.actor === "replay" || (t.actor === "browser" && !i.browserDeferred));
  const missing = plannedExecutable.filter((t) => !executed.some((r) => r.tick === t.tick && !r.error));

  // 11. Every scheduled dial -> exactly one attempt with the expected outcome on the expected lead; totals.
  const v11: Violation[] = [];
  let plannedAttempts = 0;
  let plannedDials = 0;
  for (const r of executed) {
    const t = byTick.get(r.tick)!;
    if (!r.leadId || !r.leadPhone) continue;
    plannedAttempts += t.expected.attempts;
    plannedDials += t.expected.dials;
    // Dials are counted from the PROVIDER's receipts: the stub server holds one per request the app (or the replay engine) actually sent, with the
    // destination and the intent key. Authorization rows are never the evidence of a dial: a zero, duplicate or wrong-number call must not pass.
    const authorized = (await i.db.query<AuthorizedIntent>("select custom_data, destination_e164 from public.dialpad_call_intents where property_id=$1 and dispatch_authorized_at is not null", [r.leadId])).rows;
    const dials = i.stub.dials().filter((d) => d.phone === r.leadPhone);
    for (const v of dialProblems(i.stub.dials(), authorized, r.leadPhone, t.expected.dials)) v11.push({ tick: r.tick, scenario: t.scenario, ...v });
    if (t.scenario === "double_click_dial" && r.actor === "replay" && r.expiredAt && dials.length === 2 && new Date((dials[1] as { at: string }).at) < new Date(r.expiredAt)) v11.push({ tick: r.tick, rule: "second_dial_before_expiry" });
    const att = (await i.db.query<{ outcome: string | null }>("select outcome from public.acquisition_attempts where property_id=$1 and source='dialpad'", [r.leadId])).rows;
    if (att.length !== t.expected.attempts) v11.push({ tick: r.tick, scenario: t.scenario, rule: "attempts", expected: t.expected.attempts, observed: att.length });
    if (t.expected.attemptOutcome && att.some((a) => a.outcome !== t.expected.attemptOutcome)) v11.push({ tick: r.tick, rule: "outcome", expected: t.expected.attemptOutcome, observed: att.map((a) => a.outcome) });
    if (t.expected.intentFailedMarker) {
      const failed = (await i.db.query<{ n: number }>("select count(*)::int n from public.dialpad_call_intents where id = any($1::uuid[]) and failed_at is not null", [r.intentIds])).rows[0]!.n;
      if (failed < 1) v11.push({ tick: r.tick, rule: "failed_marker_missing" });
    }
    if (t.expected.quarantineResolved) {
      if (r.steps.includes("assigned") === false) v11.push({ tick: r.tick, rule: "assign_not_performed" });
      const elsewhere = (await i.db.query<{ n: number }>("select count(*)::int n from public.acquisition_attempts a join public.call_activities c on c.id=a.call_activity_id where c.provider_call_id = any($1::text[]) and a.property_id <> $2", [r.callIds, r.leadId])).rows[0]!.n;
      if (elsewhere > 0) v11.push({ tick: r.tick, rule: "attempt_on_other_lead" });
    }
    const alts = (t.expected.conflictCode ?? "").split("|").filter(Boolean);
    for (const rej of r.rejections) {
      // A documented conflict is expected here: the schedule names the codes, or the step is the stale/second tab's own write.
      const allowed = alts.some((a) => rej.code.includes(a)) || /_tab2(_stale)?$/.test(rej.step) || rej.step === "save_tab_two" || rej.step === "second_tab_send";
      if (!allowed) v11.push({ tick: r.tick, rule: "unexpected_rejection", step: rej.step, code: rej.code });
    }
    if (r.error) v11.push({ tick: r.tick, rule: "tick_error", error: r.error });
  }
  const observedAttempts = (await i.db.query<{ n: number }>(`select count(*)::int n from public.acquisition_attempts where org_id=$1 and property_id in ${P} and source='dialpad'`, arg(i))).rows[0]!.n;
  if (observedAttempts !== plannedAttempts) v11.push({ rule: "total_attempts", planned: plannedAttempts, observed: observedAttempts });
  if (i.stub.dials().length !== plannedDials) v11.push({ rule: "total_dials", planned: plannedDials, observed: i.stub.dials().length });
  for (const t of missing) v11.push({ tick: t.tick, scenario: t.scenario, rule: "scheduled_tick_not_executed" });
  out.push(mk(11, "every scheduled dial -> one attempt on the right lead", "outcome", v11, { detail: `planned attempts ${plannedAttempts}, dials ${plannedDials}` }));

  // 12. Notes: full text, exactly once, on the scheduled lead; none on any other lead.
  const v12: Violation[] = [];
  let plannedNotes = 0;
  for (const r of executed) {
    const t = byTick.get(r.tick)!;
    const m = t.expected.noteMarker;
    if (!m || !r.leadId) continue;
    const bodies = t.scenario === "two_tabs_edits" ? [m, `${m} (tab two)`] : [m];
    for (const body of bodies) {
      plannedNotes += 1;
      const onLead = (await i.db.query<{ n: number }>("select count(*)::int n from public.lead_notes where property_id=$1 and body=$2", [r.leadId, body])).rows[0]!.n;
      const elsewhere = (await i.db.query<{ n: number }>("select count(*)::int n from public.lead_notes where property_id<>$1 and body=$2", [r.leadId, body])).rows[0]!.n;
      if (onLead !== 1) v12.push({ tick: r.tick, rule: "note_on_lead", body, observed: onLead });
      if (elsewhere > 0) v12.push({ tick: r.tick, rule: "note_on_wrong_lead", body, rows: elsewhere });
    }
  }
  const observedNotes = (await i.db.query<{ n: number }>(`select count(*)::int n from public.lead_notes where org_id=$1 and property_id in ${P} and body like $3 || '%'`, [...arg(i), `${i.runTag} note`])).rows[0]!.n;
  if (observedNotes !== plannedNotes) v12.push({ rule: "total_notes", planned: plannedNotes, observed: observedNotes });
  out.push(mk(12, "every note exactly once, full text, right lead", "outcome", v12, { detail: `planned notes ${plannedNotes}` }));

  // 13. Appointments: one open appointment at the scheduled time after all reschedules; cancelled slots cancelled.
  const v13: Violation[] = [];
  for (const r of executed) {
    const t = byTick.get(r.tick)!;
    if (!r.leadId) continue;
    if (t.scenario === "reminder_reschedule") {
      const rem = await fetchReminderRows(i.db, r.leadId);
      for (const v of reminderProblems(rem, t.expected.reminderSent, String(t.args.variant), i.reminderWindowOpen !== false)) v13.push({ tick: r.tick, scenario: t.scenario, ...v });
    }
    // Offer follow-ups are appointments too (created by the logged offer); they are checked separately below.
    const open = (await i.db.query<{ id: string; due_at: Date }>("select t.id, t.due_at from public.tasks t where t.related_property_id=$1 and t.type='appointment' and t.status in ('open','snoozed') and not exists (select 1 from public.acquisition_offers o where o.follow_up_calendar_chain_id = t.calendar_chain_id) order by t.created_at", [r.leadId])).rows;
    const wantFollowUps = t.expected.offers ?? 0;
    const haveFollowUps = (await i.db.query<{ n: number }>("select count(distinct t.calendar_chain_id)::int n from public.tasks t join public.acquisition_offers o on o.follow_up_calendar_chain_id=t.calendar_chain_id where t.related_property_id=$1 and t.type='appointment' and t.status in ('open','snoozed') and o.outcome='pending'", [r.leadId])).rows[0]!.n;
    if (haveFollowUps !== wantFollowUps) v13.push({ tick: r.tick, scenario: t.scenario, rule: "offer_follow_up_appointments", expected: wantFollowUps, observed: haveFollowUps });
    const pick = finalPick(t);
    if (!pick) {
      if (open.length > 0) v13.push({ tick: r.tick, rule: "unexpected_appointment", count: open.length });
      continue;
    }
    if (open.length !== 1) { v13.push({ tick: r.tick, scenario: t.scenario, rule: "open_appointments", expected: 1, observed: open.length }); continue; }
    const base = r.actionTime ? new Date(r.actionTime) : new Date();
    const expectedDue = quickPickDueAt(pick, base).toISOString();
    if (new Date(open[0]!.due_at).toISOString() !== expectedDue) v13.push({ tick: r.tick, scenario: t.scenario, rule: "appointment_time", expected: expectedDue, observed: new Date(open[0]!.due_at).toISOString() });
    if (r.appointmentTaskId && open[0]!.id !== r.appointmentTaskId) {
      const same = (await i.db.query<{ n: number }>("select count(*)::int n from public.tasks a join public.tasks b on b.calendar_chain_id=a.calendar_chain_id where a.id=$1 and b.id=$2", [r.appointmentTaskId, open[0]!.id])).rows[0]!.n;
      if (!same) v13.push({ tick: r.tick, rule: "open_appointment_not_the_scheduled_chain" });
    }
  }
  out.push(mk(13, "every appointment on the right lead at the right time", "outcome", v13));

  // 14. Contracts / offers.
  const v14: Violation[] = [];
  let plannedOffers = 0;
  for (const r of executed) {
    const t = byTick.get(r.tick)!;
    if (!r.leadId) continue;
    const reqs = (await i.db.query<{ id: string }>("select id from public.esign_requests where property_id=$1", [r.leadId])).rows;
    if (reqs.length !== (t.expected.contracts ?? 0)) v14.push({ tick: r.tick, scenario: t.scenario, rule: "contracts", expected: t.expected.contracts ?? 0, observed: reqs.length });
    for (const q of reqs) {
      const sends = i.stub.sends().filter((s) => s.key === q.id).length;
      if (sends !== 1) v14.push({ tick: r.tick, rule: "provider_sends_per_request", request: q.id, observed: sends });
    }
    const loggedProj = (await i.db.query<{ n: number }>("select count(*)::int n from public.acquisition_offer_projections where property_id=$1 and state='logged'", [r.leadId])).rows[0]!.n;
    const totalOffers = (await i.db.query<{ n: number }>("select count(*)::int n from public.acquisition_offers where property_id=$1", [r.leadId])).rows[0]!.n;
    const wantOffers = t.expected.offers ?? 0;
    plannedOffers += wantOffers;
    if (loggedProj !== wantOffers) v14.push({ tick: r.tick, scenario: t.scenario, rule: "offers_logged", expected: wantOffers, observed: loggedProj });
    if (totalOffers !== wantOffers + (t.expected.supersededStale ?? 0)) v14.push({ tick: r.tick, rule: "offer_rows", expected: wantOffers + (t.expected.supersededStale ?? 0), observed: totalOffers });
    if (t.expected.supersededStale) {
      const sup = (await i.db.query<{ n: number }>("select count(*)::int n from public.acquisition_offers where property_id=$1 and outcome='superseded'", [r.leadId])).rows[0]!.n;
      if (sup !== t.expected.supersededStale) v14.push({ tick: r.tick, rule: "superseded", expected: t.expected.supersededStale, observed: sup });
    }
    if (t.expected.contractSendUnknown) {
      const unknown = (await i.db.query<{ n: number }>("select count(*)::int n from public.esign_requests where property_id=$1 and delivery_state='send_unknown'", [r.leadId])).rows[0]!.n;
      if (unknown !== 1) v14.push({ tick: r.tick, rule: "send_unknown_state", observed: unknown });
    }
  }
  out.push(mk(14, "every contract: one request, one offer, sent once", "outcome", v14, { detail: `planned offers ${plannedOffers}` }));

  // 15. KPI parity: every KPI key is classified (kpi-rules) and the closed-window keys equal the schedule's totals.
  const v15: Violation[] = [];
  try {
    const rules = (await import("../../scripts/my-leads-close/kpi-rules.mjs")) as { RULES: Record<string, string>; EQUAL_IN_CLOSED_WINDOWS: string };
    const owner = (await i.db.query<{ user_id: string }>("select user_id from public.memberships where org_id=$1 and role='owner' limit 1", [i.orgId])).rows[0]!.user_id;
    const start = new Date(i.runStart.getTime() - 60_000).toISOString();
    const end = new Date(Date.now() + 60_000).toISOString();
    const kpi = (await asRep(i.db, owner, (c) => c.query<{ k: Record<string, unknown> }>("select public.fn_get_acquisition_kpis($1,$2,$3::timestamptz,$4::timestamptz) as k", [i.orgId, i.world.repUserId, start, end]))).rows[0]!.k;
    for (const key of Object.keys(kpi)) if (!(key in rules.RULES)) v15.push({ rule: "unclassified_kpi_key", key });
    const reachedPlanned = executed.reduce((n, r) => n + (byTick.get(r.tick)!.expected.attemptOutcome === "reached" ? byTick.get(r.tick)!.expected.attempts : 0), 0);
    const expectedTotals: Record<string, number> = { attempts: plannedAttempts, reached: reachedPlanned, offersSent: plannedOffers };
    for (const [key, want] of Object.entries(expectedTotals)) {
      if (rules.RULES[key] !== rules.EQUAL_IN_CLOSED_WINDOWS) continue;
      if (Number(kpi[key]) !== want) v15.push({ rule: "kpi_total", key, planned: want, observed: kpi[key] });
    }
  } catch (e) {
    v15.push({ rule: "kpi_check_failed", error: (e as Error).message });
  }
  out.push(mk(15, "KPI parity", "outcome", v15));

  // 16. Rendered parity needs the browser lane (a real page after reload). Not a pass in a replay-scope run.
  out.push(mk(16, "rendered parity after reload", "outcome", [], { deferred: i.browserDeferred ? "browser lane (rendered rows after reload) not executed in this scope" : undefined, ok: !i.browserDeferred }));
  return out;
}

/** Observed behaviour for the rules still waiting on Jarrad. Printed in the report under "pending Jarrad"; asserts nothing. */
export async function pendingJarradObservations(i: OracleInput): Promise<string[]> {
  const notes: string[] = [];
  const sup = (await i.db.query<{ n: number }>(`select count(*)::int n from public.acquisition_offers where org_id=$1 and property_id in ${P} and outcome='superseded'`, arg(i))).rows[0]!.n;
  notes.push(`offersSent with supersede: ${sup} superseded offer row(s) exist; whether the KPI should count the superseded offer is undecided (no assertion).`);
  notes.push("owner-mismatch block vs warn: not exercised (no scheduled scenario); no default assumed.");
  notes.push("reassign target: not exercised; no default assumed.");
  notes.push("motivation-required: contracts were sent with motivation kind no_motivation; the rule is unresolved and not asserted.");
  notes.push("earnest money: not asserted.");
  const skipped = (await i.db.query<{ n: number }>(`select count(*)::int n from public.seller_appointment_reminders where org_id=$1 and property_id in ${P} and skip_reason='opening_identity_required'`, arg(i))).rows[0]!.n;
  if (skipped > 0) notes.push(`seller reminders skipped as opening_identity_required: ${skipped} (a seller with no prior SMS thread never gets the approved reminder copy).`);
  return notes;
}
