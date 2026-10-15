import { DAY, HOUR, MIN, type Appointment, type Lead, type LeadEvent, type Msg, type Obligation } from "./model";

/**
 * Independent oracle for the My Leads unified work queue. Pure TypeScript, derived ONLY from the design text
 * (UNIFIED-QUEUE-DESIGN-2026-10, v9 incl. section 17): 1.1 placement table, 2/2.1 reasons and Broken inventory, 3.1 healthy
 * automation, 5 handled-reply rule, 16 amendments. It must not import, read or mirror the SQL; where the design
 * text and the SQL disagree the oracle follows the text and the lead is tagged with a SPEC_QUESTION so the
 * report separates "SQL is wrong" from "the spec needs a decision".
 */

export type Place = "your_move" | "their_move" | "neither";
export type Reason =
  | "under_contract" | "call_today" | "new_lead" | "due" | "new_reply" | "broken" | "nothing_planned" | "offer" | "gone_quiet"
  | "in_drip" | "callback_booked" | "offer_out" | "texted_last";
export type BrokenAction = "fix_drip" | "send_text" | "resend" | "review" | "check_status" | "open_campaign";

export type Placement = {
  row: string;
  place: Place;
  reason: Reason;
  inBadge: boolean;
  /** Per-row discriminator compared against the SQL headline (design 4 / 2 bold lines). */
  headline: Record<string, string | number | boolean>;
  /** Distinct Broken fix actions that are unresolved on the lead (design 2.1), sorted. */
  brokenActions: BrokenAction[];
  /** Rule 2 badge fact: on a lead whose latest inbound is a contact-only text, how many leads have that person as homeowner. */
  homeownerPropertyCount?: number;
  /** Within-chip order key from design 2 / 3 (ascending), where the design names one: pins newest first, due by time, replies newest
   * first, Waiting by next event. Undefined where the design's key needs facts this model does not hold (last touch, failure time). */
  sortAt?: number;
};

/** Places where the design text and the A1 SQL disagree. Registered so the report can group mismatches. */
export const SPEC_QUESTIONS: Readonly<Record<string, string>> = {
  SQ5: "Resolved 2026-10-15 by Jarrad's approved rule (oracle follows it; gating): \"A text Sandra can tie to one lead goes to that lead. A text Sandra cannot tie to one lead shows on every lead where that person is the homeowner, each with a note that they own more than one house. Answering it on any of those leads counts as answered on all of them.\"",
  SQ2: "v9 17: ledger/obligation 'unknown' younger than 15 min is in flight, not Broken (oracle follows this). The A1 SQL still marks it Broken; fix routed to PR #876 migration 20261015020200.",
};

/** Spec questions whose SQL fix is in flight elsewhere: their mismatches are reported but do not fail the run until that PR lands. */
/** Confirmed SQL bugs whose fix is in flight. Labelled in the report but NOT excused: they keep failing the run until fixed. */
export const FIX_PENDING: Readonly<Record<string, string>> = {};

export const EXPECTED_UNTIL: Readonly<Record<string, string>> = { SQ2: "#876" };

// ---------- America/Chicago wall-clock arithmetic (business days, "7 Chicago days") ----------
const chicagoFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
type Local = { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number; dow: number };
const DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function chicagoLocal(ms: number): Local {
  const parts: Record<string, string> = {};
  for (const p of chicagoFmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { y: +parts.year!, mo: +parts.month!, d: +parts.day!, h: +parts.hour!, mi: +parts.minute!, s: +parts.second!, ms: ((ms % 1000) + 1000) % 1000, dow: DOW[parts.weekday!]! };
}

/** The instant whose Chicago wall clock reads `l` (daytime wall-clock; DST edge hours are never used by the seeders). */
export function fromChicagoLocal(l: Omit<Local, "dow">): number {
  const naive = Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s, l.ms);
  let guess = naive;
  for (let i = 0; i < 3; i += 1) {
    const c = chicagoLocal(guess);
    const shown = Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi, c.s, l.ms);
    guess += naive - shown;
  }
  return guess;
}

function shiftLocalDays(l: Local, days: number): Omit<Local, "dow"> {
  const t = new Date(Date.UTC(l.y, l.mo - 1, l.d + days, l.h, l.mi, l.s, l.ms));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), ms: t.getUTCMilliseconds() };
}

/** 3 business days = Mon-Fri in America/Chicago, wall clock preserved (design 1.1 row 13). */
export function addBusinessDays(ms: number, n: number): number {
  let local = chicagoLocal(ms);
  let done = 0;
  while (done < n) {
    const next = shiftLocalDays(local, 1);
    local = chicagoLocal(fromChicagoLocal(next));
    if (local.dow < 6) done += 1;
  }
  return fromChicagoLocal(local);
}

/** `ms` minus N calendar days on the Chicago wall clock ("older than 7 days" is counted in Chicago days). */
export function minusChicagoDays(ms: number, days: number): number {
  return fromChicagoLocal(shiftLocalDays(chicagoLocal(ms), -days));
}

// ---------- fact helpers ----------
const HUMAN_CLASS = new Set(["human", "approved_draft"]);
const AI_CLASS = new Set(["ai_template", "ai_written"]);

const isOutbound = (m: Msg) => m.dir === "outbound";
const sendTime = (m: Msg) => m.sentAt ?? m.at; // design 16.1: effective send time

/** Provider accepted it. Acceptance is durable: a later delivery failure never un-accepts (design 5, B4). */
const accepted = (m: Msg) =>
  m.outcome === "sent" || m.outcome === "delivered" || m.outcome === "accepted_then_failed"
  || m.ledger?.state === "accepted" || m.ledger?.state === "delivered" || m.ledger?.state === "delivery_failed";

const isReplyText = (m: Msg) =>
  isOutbound(m) && m.source !== "drip" && m.source !== "campaign" && (HUMAN_CLASS.has(m.source!) || AI_CLASS.has(m.source!));

function activeAppt(a: Appointment) { return a.status === "open" || a.status === "snoozed"; }
/** Design 1.1 commitment predicate: effective time = greatest(due, snoozed_until). */
const effTime = (a: Appointment) => Math.max(a.due, a.snoozedUntil ?? a.due);

type Inbound = { at: number; ref: string | null; kind: "text" | "call"; contactOnly?: boolean };

/** Approved 2026-10-15 (Jarrad, verbatim): "A text Sandra can tie to one lead goes to that lead. A text Sandra cannot tie to one
 * lead shows on every lead where that person is the homeowner, each with a note that they own more than one house. Answering it on
 * any of those leads counts as answered on all of them." `group` = the other leads whose homeowner is the same person. */
function latestInbound(lead: Lead, group: readonly Lead[] = []): Inbound | null {
  const items: Inbound[] = [];
  for (const m of lead.messages) if (m.dir === "inbound") items.push({ at: m.at, ref: m.ref, kind: "text", contactOnly: !!m.contactOnly });
  for (const g of group) for (const m of g.messages) if (m.dir === "inbound" && m.contactOnly) items.push({ at: m.at, ref: m.ref, kind: "text", contactOnly: true });
  for (const c of lead.missedCalls) items.push({ at: c, ref: null, kind: "call" });
  if (items.length === 0) return null;
  // newest by time; a text beats a call at the same instant (ties never occur in generated worlds)
  items.sort((a, b) => b.at - a.at || (b.ref ?? "").localeCompare(a.ref ?? ""));
  return items[0]!;
}

// The one acknowledged non-text input: the my_leads_workflow operation allowlist is the existing SQL allowlist (design 5 "the existing
// allowlist", migration 20260930035000) minus log_acquisition_attempt per v9 17 (SQ4). Everything else here comes from the design text.
const handlesEvent = (e: LeadEvent) =>
  e.actor === "user" && (
    e.type === "dispo_set"
    || (e.type === "my_leads_workflow" && ["ready_acquisition_offer", "log_acquisition_offer", "record_acquisition_contract", "decline_acquisition_offer", "handoff_acquisition_lead"].includes(e.operation ?? ""))
    || e.type === "appointment_booked" || e.type === "task_created");

/** Design section 5. A contact-only text is answered when any lead of its homeowner answers it (approved rule above). */
export function isHandled(lead: Lead, inbound: Inbound, group: readonly Lead[] = []): boolean {
  if (inbound.kind === "text" && inbound.contactOnly) return [lead, ...group].some((l) => handledOn(l, inbound, [lead, ...group]));
  return handledOn(lead, inbound, []);
}

function handledOn(lead: Lead, inbound: Inbound, family: readonly Lead[]): boolean {
  const refOrder = (ref: string | null) => ref ?? "";
  for (const m of lead.messages) {
    if (!isReplyText(m) || !accepted(m)) continue;
    const t = sendTime(m);
    if (!(t > inbound.at || (t === inbound.at && m.ref > refOrder(inbound.ref)))) continue;
    if (m.stamp?.kind === "unresolved") continue; // 16.2: handles nothing
    if (inbound.kind === "text" && m.stamp?.kind === "inbound") {
      const st = m.stamp as { ref: string; lead?: string };
      // a stamp naming another lead's message resolves only to a contact-only text of the same homeowner
      const s = st.lead === undefined || st.lead === lead.key
        ? lead.messages.find((x) => x.ref === st.ref && x.dir === "inbound")
        : family.find((l) => l.key === st.lead)?.messages.find((x) => x.ref === st.ref && x.dir === "inbound" && x.contactOnly);
      // a text stamped with an inbound older than this one does not answer it (5, reply-to stamp)
      if (s && (s.at < inbound.at || (s.at === inbound.at && s.ref < refOrder(inbound.ref)))) continue;
    }
    return true;
  }
  if (lead.attempts.some((a) => (a.outcome === "reached" || a.outcome === "voicemail") && a.at > inbound.at)) return true;
  if (lead.events.some((e) => handlesEvent(e) && e.at > inbound.at)) return true;
  const en = lead.enrollment;
  if (en && en.enrolledBy === "rep" && en.enrolledAt > inbound.at) return true;
  return false;
}

// ---------- Broken inventory (2.1) ----------
type BrokenItem = { kind: string; action: BrokenAction; at: number; ref: string | null; failure: boolean };

const DRIP_FIX_REASONS = new Set(["provider_failed", "reconciliation_required", "template_missing", "step_misconfigured", "no_phone", "no_approved_sender", "consent_unavailable"]);

function dripHealthy(lead: Lead, now: number): boolean {
  const en = lead.enrollment;
  if (!en) return false;
  if (en.status === "active") return en.nextRunAt !== null && en.nextRunAt >= now - 60 * MIN && !(en.claimAt !== undefined && en.claimAt < now - 15 * MIN);
  if (en.status === "paused" && en.pause === "call_in_progress") return en.updatedAt >= now - 30 * MIN;
  return false;
}

/** `preV9Unknown`: the A1 SQL's reading before PR #876 (an 'unknown' ledger/obligation is Broken at once). Used ONLY to recognise the
 * known SQ2 disagreement precisely; the expected answer always comes from the v9 rule. */
export type OracleOptions = { preV9Unknown?: boolean; group?: readonly Lead[] };

function brokenItems(lead: Lead, now: number, opts: OracleOptions = {}): BrokenItem[] {
  const out: BrokenItem[] = [];
  const en = lead.enrollment;
  if (en) {
    if (en.status === "paused" && en.pause && DRIP_FIX_REASONS.has(en.pause)) out.push({ kind: "drip_paused", action: "fix_drip", at: en.updatedAt, ref: "enrollment", failure: false });
    const stuck = (en.status === "active" && ((en.claimAt !== undefined && en.claimAt < now - 15 * MIN) || (en.nextRunAt !== null && en.nextRunAt < now - 60 * MIN)))
      || (en.status === "paused" && en.pause === "call_in_progress" && en.updatedAt < now - 30 * MIN);
    if (stuck) out.push({ kind: "drip_stuck", action: "fix_drip", at: en.claimAt ?? en.nextRunAt ?? en.updatedAt, ref: "enrollment", failure: false });
  }
  for (const o of lead.obligations) {
    const stale = (o.state === "claimed" || o.state === "sending") && (o.leaseExpiresAt ?? o.updatedAt) < now;
    // v9 17 (SQ2): an 'unknown' obligation gets the same 15-minute in-flight grace as reserved/sending
    const unknownStale = o.state === "unknown" && (opts.preV9Unknown || o.updatedAt < now - 15 * MIN);
    if (!(["required", "draft", "failed_not_dispatched", "delivery_failed", "blocked"].includes(o.state) || unknownStale || stale)) continue;
    const action: BrokenAction = o.state === "delivery_failed" ? "resend" : o.state === "blocked" ? "review" : o.state === "unknown" || stale ? "check_status" : "send_text";
    out.push({ kind: `obligation_${o.state}`, action, at: o.updatedAt, ref: o.ref, failure: ["failed_not_dispatched", "delivery_failed", "blocked"].includes(o.state) });
  }
  const ledgers = [
    ...lead.ledgers.map((l) => ({ ref: l.ref, state: l.state, updatedAt: l.updatedAt })),
    ...lead.messages.filter((m) => m.ledger).map((m) => ({ ref: `ledger:${m.ref}`, state: m.ledger!.state, updatedAt: m.ledger!.updatedAt })),
  ];
  for (const l of ledgers) {
    const failure = l.state === "failed_not_dispatched" || l.state === "delivery_failed" || l.state === "blocked";
    // Literal 2.1: unknown / reserved / sending count only once older than 15 minutes (SQ2).
    const unverified = ((l.state === "unknown" || l.state === "reserved" || l.state === "sending") && l.updatedAt < now - 15 * MIN) || (l.state === "unknown" && !!opts.preV9Unknown);
    if (!failure && !unverified) continue;
    const action: BrokenAction = l.state === "blocked" ? "review" : failure ? "resend" : "check_status";
    out.push({ kind: `ledger_${l.state}`, action, at: l.updatedAt, ref: l.ref, failure });
  }
  for (const m of lead.messages) {
    if (!isOutbound(m) || !HUMAN_CLASS.has(m.source!) || m.ledger) continue;
    if (!(m.at > now - 7 * DAY)) continue;
    const failed = m.outcome === "failed" || m.outcome === "accepted_then_failed" || m.outcome === "failed_unknown";
    const stalePending = m.outcome === "pending" && m.at < now - 15 * MIN;
    if (!failed && !stalePending) continue;
    const definitive = m.outcome === "failed" || m.outcome === "accepted_then_failed";
    out.push({ kind: definitive ? "text_not_sent" : "text_status_unknown", action: definitive ? "resend" : "check_status", at: m.failedAt ?? m.at, ref: m.ref, failure: definitive });
  }
  for (const m of lead.messages) {
    if (isOutbound(m) && m.outcome === "queued" && m.scheduledFor !== undefined && m.source === "campaign" && m.scheduledFor < now - 30 * MIN)
      out.push({ kind: "scheduled_text_overdue", action: "open_campaign", at: m.scheduledFor, ref: m.ref, failure: false });
  }
  if (lead.aiDeadLetter !== undefined) out.push({ kind: "ai_reply_failed", action: "review", at: lead.aiDeadLetter, ref: "deadletter", failure: false });
  // v9 17 (SQ3): a pending AI draft is a label ("AI draft waiting for your OK"), never Broken; only a dead letter is.
  if (lead.normaNeedsReview) out.push({ kind: "norma_needs_review", action: "review", at: now, ref: "norma", failure: false });
  return out;
}

/** Supersession (2.1): a definitive failure is Broken only while unresolved. Dismissal removes any item. */
function unresolvedBroken(lead: Lead, now: number, opts: OracleOptions = {}): BrokenItem[] {
  return brokenItems(lead, now, opts).filter((b) => {
    if (lead.events.some((e) => e.type === "rep_sms_failure_dismissed" && e.actor === "user" && e.dismisses === b.ref)) return false;
    if (!b.failure) return true;
    const laterReply = lead.messages.some((m) => isOutbound(m) && HUMAN_CLASS.has(m.source!) && accepted(m) && sendTime(m) > b.at);
    const laterEvent = lead.events.some((e) => handlesEvent(e) && e.at > b.at);
    const laterDrip = lead.enrollment?.enrolledBy === "rep" && lead.enrollment.enrolledAt > b.at;
    return !(laterReply || laterEvent || laterDrip);
  });
}

// ---------- the placement table (1.1) ----------
const SOON = 15 * MIN;

export function place(lead: Lead, now: number, opts: OracleOptions = {}): Placement {
  const appts = lead.appointments.filter(activeAppt);
  const offer = lead.offer;
  const offerPending = offer?.outcome === "pending";
  const chainTasks = appts.filter((a) => a.offerChain && offerPending && offer?.hasChain);
  const normal = appts.filter((a) => !chainTasks.includes(a));
  const cutoff = minusChicagoDays(now, 7);
  const dueSet = normal.filter((a) => effTime(a) <= now + SOON && effTime(a) >= cutoff);
  const missedSet = normal.filter((a) => effTime(a) < cutoff);
  const futureSet = normal.filter((a) => effTime(a) > now + SOON);
  const min = (xs: Appointment[]) => (xs.length ? Math.min(...xs.map(effTime)) : null);
  const dueAt = min(dueSet), missedAt = min(missedSet), futureAt = min(futureSet);
  // Approved 2026-10-15 (Jarrad, verbatim): "An offer follow-up that the rep snoozed is due at its snooze time, not its original
  // time. Until the snooze time passes, the lead stays in Waiting on them · Offer out." So the chain task's time is its effective
  // time greatest(due, snoozed_until), as for every other commitment.
  const chainEff = chainTasks.length ? Math.min(...chainTasks.map(effTime)) : null;
  // Ruling relayed 2026-10-15 with Jarrad's authority: exactly as written, so a SNOOZED chain task (its snooze time is its effective
  // time) has no 15-minute early window: due once the snooze time is reached. Unsnoozed follow-ups keep the window.
  const firstChain = [...chainTasks].sort((a, b) => effTime(a) - effTime(b) || a.ref.localeCompare(b.ref))[0];
  const chainSnoozed = !!firstChain && firstChain.status === "snoozed" && firstChain.snoozedUntil !== undefined && firstChain.snoozedUntil >= firstChain.due;

  const group = opts.group ?? [];
  const inbound = latestInbound(lead, group);
  const unhandled = inbound ? !isHandled(lead, inbound, group) : false;
  const homeownerPropertyCount = inbound?.kind === "text" && inbound.contactOnly ? 1 + group.length : undefined;
  const broken = unresolvedBroken(lead, now, opts);
  const brokenActions = [...new Set(broken.map((b) => b.action))].sort() as BrokenAction[];
  const manualQueued = lead.messages.some((m) => isOutbound(m) && m.outcome === "queued" && m.scheduledFor === undefined && m.source !== "campaign" && m.source !== "drip");
  const campHealthy = lead.messages.some((m) => isOutbound(m) && m.outcome === "queued" && m.source === "campaign" && m.scheduledFor !== undefined && m.scheduledFor >= now - 30 * MIN);
  const automationOk = dripHealthy(lead, now) || campHealthy;

  const pinned = !!lead.pin && (lead.pin.until === null || lead.pin.until > now) && !lead.attempts.some((a) => a.at > lead.pin!.pinnedAt);

  const offerEff = offerPending && lead.stage === "offer_sent"
    ? (chainEff ?? (offer!.hasChain ? null : offer!.followUpAt))
    : null;

  // Rows 13/14 "last seller-facing outbound" = the latest ACCEPTED outbound: a failed, queued or pending text is not a seller-facing
  // touch (design v9 17, Fable ruling).
  const acceptedOut = lead.messages.filter((m) => isOutbound(m) && accepted(m)).sort((a, b) => sendTime(b) - sendTime(a) || (b.ref > a.ref ? 1 : -1));
  const lo = acceptedOut[0] ?? null;
  const inboundAfterLo = !!(inbound && lo && inbound.at > sendTime(lo));
  const textedOk = !!lo && ["human", "approved_draft", "ai_template", "ai_written", "campaign"].includes(lo.source!) && !inboundAfterLo;
  const loDeadline = lo ? addBusinessDays(sendTime(lo), 3) : null;
  const loFinal = !!lo && lo.source === "drip" && !!lo.dripFinal && lead.enrollment?.status === "completed" && !inboundAfterLo;

  const offerDue = offerEff !== null && offerEff <= now + (chainEff !== null && chainSnoozed ? 0 : SOON);
  const mk = (row: string, placeOf: Place, reason: Reason, headline: Placement["headline"] = {}, sortAt?: number): Placement =>
    ({ row, place: placeOf, reason, inBadge: ["4", "9", "5", "6"].includes(row), headline, brokenActions, sortAt, ...(homeownerPropertyCount === undefined ? {} : { homeownerPropertyCount }) });
  const onlyDrip = dripHealthy(lead, now) && !campHealthy && lead.enrollment?.status === "active" ? lead.enrollment.nextRunAt ?? undefined : undefined;

  // v9 17 (SQ1): Neither only with no active appointment at all; any active one flows through Due / Callback booked.
  if (lead.stage === "under_contract" && appts.length === 0) return mk("1", "neither", "under_contract");
  if (pinned) return mk("2", "your_move", "call_today", {}, -lead.pin!.pinnedAt);
  if (lead.stage === "not_contacted" && lead.attempts.length === 0) return mk("3", "your_move", "new_lead");
  if (dueAt !== null) return mk("4", "your_move", "due", { soon: dueAt > now }, dueAt);
  if (unhandled) return mk("5", "your_move", "new_reply", { kind: inbound!.kind }, -inbound!.at);
  if (broken.length > 0) return mk("6", "your_move", "broken");
  if (manualQueued) return mk("6a", "your_move", "nothing_planned", { variant: "text_waiting" });
  if (lead.stage === "needs_offer" && !offerPending) return mk("7", "your_move", "offer", { kind: "ready" });
  if (lead.stage === "offer_sent" && offerPending && ((offer!.hasChain && chainEff === null) || offerDue))
    return mk("8", "your_move", "offer", { kind: offer!.hasChain && chainEff === null ? "follow_up_missing" : "follow_up_due" });
  if (missedAt !== null) return mk("9", "your_move", "due", { overdueDays: Math.floor((now - missedAt) / DAY) }, missedAt);
  if (automationOk) return mk("10", "their_move", "in_drip", {}, onlyDrip);
  if (futureAt !== null) {
    // 3.1: a lead with both a callback and an offer follow-up shows the earlier of the two; chip = the earlier one's kind
    const offerEarlier = offerEff !== null && !offerDue && offerEff < futureAt;
    return mk("11", "their_move", offerEarlier ? "offer_out" : "callback_booked", {}, offerEarlier ? offerEff! : futureAt);
  }
  if (offerEff !== null && !offerDue) return mk("12", "their_move", "offer_out", {}, offerEff);
  if (textedOk && loDeadline !== null && now < loDeadline) return mk("13", "their_move", "texted_last", { by: lo!.source === "campaign" ? "campaign" : AI_CLASS.has(lo!.source!) ? "ai" : "human" }, loDeadline);
  if ((textedOk && loDeadline !== null && now >= loDeadline) || loFinal) return mk("14", "your_move", "gone_quiet", { kind: textedOk ? "texted_silent" : "drip_finished" });
  return mk("15", "your_move", "nothing_planned");
}

/** Places every lead of a world, giving each lead the other leads whose homeowner is the same person (`contactGroup`). */
export function placeWorld(leads: readonly Lead[], now: number, opts: OracleOptions = {}): Map<string, Placement> {
  const groupOf = (l: Lead) => (l.contactGroup ? leads.filter((x) => x !== l && x.contactGroup === l.contactGroup) : []);
  return new Map(leads.map((l) => [l.key, place(l, now, { ...opts, group: groupOf(l) })]));
}

export const NEEDS_ATTENTION_CHIPS: readonly Reason[] = ["new_lead", "call_today", "due", "new_reply", "broken", "offer", "gone_quiet", "nothing_planned"];
export const WAITING_CHIPS: readonly Reason[] = ["in_drip", "texted_last", "offer_out", "callback_booked"];

export type Tab = "needs_attention" | "waiting" | "all";

export function tabOf(p: Placement): Tab | "all" {
  return p.place === "your_move" ? "needs_attention" : p.place === "their_move" ? "waiting" : "all";
}

/** Expected membership of every tab/chip view for a world, plus the badge. */
export function expectedViews(placements: Map<string, Placement>) {
  const views = new Map<string, string[]>();
  const push = (k: string, id: string) => { (views.get(k) ?? views.set(k, []).get(k)!).push(id); };
  let badge = 0;
  for (const [id, p] of placements) {
    push("all|", id);
    push(`all|${p.reason}`, id);
    if (p.place === "your_move") { push("needs_attention|", id); push(`needs_attention|${p.reason}`, id); }
    if (p.place === "their_move") { push("waiting|", id); push(`waiting|${p.reason}`, id); }
    if (p.inBadge) badge += 1;
  }
  return { views, badge };
}

// re-exported only so tests can build fixtures without reaching into model.ts twice
export type { Obligation };
