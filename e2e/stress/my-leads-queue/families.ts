import { createRng, type Rng } from "../prng";
import { DAY, HOUR, MIN, SEC, emptyLead, type Appointment, type Enrollment, type Lead, type Msg, type OutboundSource, type SendOutcome, type Stage } from "./model";
import { addBusinessDays, chicagoLocal, minusChicagoDays } from "./oracle";

/**
 * The 31 scenario families of the stress design (section 1). Each builds leads for ONE variant of a world:
 * a wording of the inbound text (5) x a stage context (3), with every threshold timestamp jittered +-1 minute
 * from a seeded generator. The builders only describe facts; the oracle decides what is expected.
 */
export const WORDINGS = [
  { id: "reply", body: "Yes I'm interested, call me" },
  { id: "stop", body: "stop" },
  { id: "question", body: "Who is this? What's your offer?" },
  { id: "emoji", body: "👍" },
  { id: "empty", body: "" },
] as const;
export type Wording = (typeof WORDINGS)[number];

export const STAGE_CONTEXTS = ["contacted", "not_contacted", "offer_sent"] as const;
export type StageContext = (typeof STAGE_CONTEXTS)[number];

export type Kit = {
  now: number;
  rng: Rng;
  w: Wording;
  st: StageContext;
  /** `base` +- up to one minute, never exactly `base` (ties between oracle and SQL at a threshold are not the point). */
  j(base: number, spread?: number): number;
  lead(key: string, over?: Partial<Lead>): Lead;
  inb(ref: string, at: number, extra?: Partial<Msg>): Msg;
  out(ref: string, at: number, extra?: Partial<Msg>): Msg;
  appt(ref: string, due: number, extra?: Partial<Appointment>): Appointment;
  drip(over?: Partial<Enrollment>): Enrollment;
  attempt(at: number, outcome?: Lead["attempts"][number]["outcome"]): Lead["attempts"][number];
};

export type FamilyDef = {
  id: string;
  title: string;
  /** World clock. Default: a Wednesday noon a few days either side of the run date. */
  now?: (rng: Rng) => number;
  build(k: Kit): Lead[];
  /** Special runner behaviour beyond per-lead comparison. */
  view?: "owner" | "deep_link";
  /** Build once (first variant only): the family needs one big queue, not 15 copies of it. */
  singleVariant?: boolean;
};

/** Sends whose 3-business-day deadline the boundary family straddles: Fri 4 PM CDT, Fri 4 PM CDT before fall-back, Fri 4 PM CST before spring-forward, a plain Wednesday. */
const BD_SENDS = [Date.UTC(2026, 9, 16, 21), Date.UTC(2026, 9, 30, 21), Date.UTC(2027, 2, 12, 22), Date.UTC(2026, 9, 14, 17)];
/** One millisecond before, exactly at, one millisecond after a threshold. */
const EXACT = [-1, 0, 1] as const;
const WED_NOON_UTC = Date.UTC(2026, 9, 14, 17, 0, 0);
const defaultNow = (rng: Rng) => WED_NOON_UTC + rng.int(0, 60) * DAY;

export function makeKit(now: number, rng: Rng, w: Wording, st: StageContext, prefix: string): Kit {
  let seq = 0;
  const kit: Kit = {
    now, rng, w, st,
    j: (base, spread = MIN) => { const d = rng.int(-spread, spread); return base + (d === 0 ? SEC : d); },
    lead: (key, over = {}) => emptyLead(`${prefix}_${key}_${seq += 1}`, now, { stage: st === "offer_sent" ? "offer_sent" : st === "not_contacted" ? "not_contacted" : "contacted", ...over }),
    inb: (ref, at, extra = {}) => ({ ref, dir: "inbound", at, body: w.body, ...extra }),
    out: (ref, at, extra = {}) => ({ ref, dir: "outbound", at, body: "On our way", source: "human", outcome: "sent", ...extra }),
    appt: (ref, due, extra = {}) => ({ ref, due, status: "open", ...extra }),
    drip: (over = {}) => ({ status: "active", nextRunAt: now + 2 * HOUR, updatedAt: now - 5 * MIN, enrolledAt: now - 5 * DAY, enrolledBy: "none", steps: 4, step: 1, ...over }),
    attempt: (at, outcome = "no_answer") => ({ at, outcome }),
  };
  return kit;
}

const pick = <T,>(k: Kit, xs: readonly T[]) => k.rng.pick(xs);
const plain = (k: Kit, key: string, over: Partial<Lead> = {}) => k.lead(key, over);

export const FAMILIES: readonly FamilyDef[] = [
  { id: "new_lead", title: "new lead", build: (k) => [
    k.lead("never", { stage: "not_contacted", attempts: [], assignedAt: k.now - k.rng.int(0, 2 * DAY) }),
    k.lead("called_since", { stage: "not_contacted", attempts: [k.attempt(k.j(k.now - HOUR))], assignedAt: k.now - 2 * DAY }),
  ] },
  // Placement-only: the "first call overdue" suffix comes from the existing episode working-hours deadline (design row 3 "the existing
  // warning"), which this model does not re-derive. The family asserts that overdue new leads stay Your move · New lead; the headline
  // suffix is out of scope (noted in the PR).
  { id: "first_call_overdue", title: "first call overdue", build: (k) => [
    k.lead("overdue", { stage: "not_contacted", attempts: [], assignedAt: k.j(k.now - pick(k, [4 * HOUR, DAY, 3 * DAY, 9 * DAY]), 5 * MIN) }),
  ] },
  { id: "call_today_pinned", title: "call today pinned", build: (k) => {
    const pinnedAt = k.now - 2 * HOUR;
    return [
      k.lead("open_pin", { pin: { pinnedAt, until: null } }),
      k.lead("until_future", { pin: { pinnedAt, until: k.j(k.now + 30 * MIN, 5 * MIN) } }),
      k.lead("until_boundary", { pin: { pinnedAt, until: k.j(k.now) } }),
      k.lead("call_after", { pin: { pinnedAt, until: null }, attempts: [k.attempt(k.j(pinnedAt))] }),
      k.lead("note_after", { pin: { pinnedAt, until: null }, events: [{ type: "note", at: k.now - HOUR, actor: "user" }] }),
      k.lead("pin_plus_reply", { pin: { pinnedAt, until: null }, messages: [k.inb("i", k.now - HOUR)] }),
    ];
  } },
  { id: "callback_boundary", title: "callback due -16/-15/-1/0/+1 min", build: (k) =>
    [...[-16, -15, -1, 0, 1].map((d) => k.lead(`d${d}`, { appointments: [k.appt("a", k.j(k.now + (15 + d) * MIN, 5 * SEC))] })),
      // exactly at the threshold and one millisecond either side (design 16.3)
      ...EXACT.map((e) => k.lead(`exact${e}`, { appointments: [k.appt("a", k.now + 15 * MIN + e)] }))] },
  { id: "callback_snoozed", title: "callback snoozed", build: (k) => [
    k.lead("snooze_future", { appointments: [k.appt("a", k.now - HOUR, { status: "snoozed", snoozedUntil: k.j(k.now + DAY) })] }),
    k.lead("snooze_just_passed", { appointments: [k.appt("a", k.now - DAY, { status: "snoozed", snoozedUntil: k.j(k.now - 10 * MIN, 5 * MIN) })], enrollment: k.drip() }),
    k.lead("snooze_at_boundary", { appointments: [k.appt("a", k.now - DAY, { status: "snoozed", snoozedUntil: k.j(k.now + 15 * MIN) })] }),
  ] },
  { id: "callback_7_chicago_days", title: "callback > 7 Chicago days", now: (rng) => rng.pick([Date.UTC(2026, 10, 5, 22), Date.UTC(2027, 2, 15, 20), defaultNow(rng)]), build: (k) => [
    k.lead("at_cutoff", { appointments: [k.appt("a", k.j(minusChicagoDays(k.now, 7)))] }),
    k.lead("six_days", { appointments: [k.appt("a", k.now - 6 * DAY)] }),
    k.lead("nine_days", { appointments: [k.appt("a", k.now - 9 * DAY)] }),
  ] },
  { id: "offer_chain_boundaries", title: "offer chain follow-up at four boundaries", build: (k) => {
    const offer = (hasChain: boolean, followUpAt: number) => ({ sentAt: k.now - 3 * DAY, followUpAt, outcome: "pending" as const, hasChain });
    const leads = [-16, -15, -1, 0].map((d) => {
      const due = k.j(k.now + (15 + d) * MIN, 5 * SEC);
      return k.lead(`chain${d}`, { stage: "offer_sent", offer: offer(true, due), appointments: [k.appt("c", due, { offerChain: true })] });
    });
    const legacy = k.j(k.now + 15 * MIN, 5 * MIN);
    leads.push(k.lead("legacy", { stage: "offer_sent", offer: offer(false, legacy) }));
    for (const e of EXACT) {
      const due = k.now + 15 * MIN + e;
      leads.push(k.lead(`chain_exact${e}`, { stage: "offer_sent", offer: offer(true, due), appointments: [k.appt("c", due, { offerChain: true })] }));
      leads.push(k.lead(`legacy_exact${e}`, { stage: "offer_sent", offer: offer(false, due) }));
    }
    return leads;
  } },
  { id: "offer_chain_no_successor", title: "offer chain task completed without successor", build: (k) => {
    const offer = { sentAt: k.now - 3 * DAY, followUpAt: k.now - DAY, outcome: "pending" as const, hasChain: true };
    return [
      k.lead("completed", { stage: "offer_sent", offer, appointments: [k.appt("c", k.now - DAY, { offerChain: true, status: "completed" })] }),
      k.lead("cancelled", { stage: "offer_sent", offer, appointments: [k.appt("c", k.now - DAY, { offerChain: true, status: "cancelled" })] }),
      k.lead("with_callback", { stage: "offer_sent", offer, appointments: [k.appt("c", k.now - DAY, { offerChain: true, status: "completed" }), k.appt("cb", k.now + 2 * DAY)] }),
      k.lead("offer_declined", { stage: "offer_sent", offer: { ...offer, outcome: "declined" } }),
      // snoozed chain task: rows 8/12 use its due_at, not the snooze (due now-1h snoozed to tomorrow = Offer follow-up due)
      k.lead("chain_snoozed", { stage: "offer_sent", offer: { ...offer, followUpAt: k.now - HOUR }, appointments: [k.appt("c", k.now - HOUR, { offerChain: true, status: "snoozed", snoozedUntil: k.now + DAY })] }),
      k.lead("chain_snoozed_future", { stage: "offer_sent", offer: { ...offer, followUpAt: k.now + 2 * DAY }, appointments: [k.appt("c", k.now + 2 * DAY, { offerChain: true, status: "snoozed", snoozedUntil: k.now + 3 * DAY })] }),
    ];
  } },
  { id: "needs_offer", title: "needs offer", build: (k) => [
    k.lead("ready", { stage: "needs_offer" }),
    k.lead("ready_declined_before", { stage: "needs_offer", offer: { sentAt: k.now - 9 * DAY, followUpAt: k.now - 6 * DAY, outcome: "declined", hasChain: false } }),
    k.lead("ready_with_drip", { stage: "needs_offer", enrollment: k.drip() }),
  ] },
  { id: "reply_drip_states", title: "new reply with drip active/paused/none", build: (k) => {
    const at = k.j(k.now - 3 * HOUR);
    const dripText = (ref: string, ago: number): Msg => k.out(ref, k.now - ago, { source: "drip" });
    return [
      k.lead("active", { messages: [dripText("d", 5 * HOUR), k.inb("i", at)], enrollment: k.drip() }),
      k.lead("paused_reply", { messages: [dripText("d", 5 * HOUR), k.inb("i", at)], enrollment: k.drip({ status: "paused", pause: "inbound_reply", nextRunAt: null }) }),
      k.lead("none", { messages: [k.inb("i", at)] }),
      k.lead("contact_only", { messages: [k.inb("i", at, { contactOnly: true })] }),
      // v9 17 (SQ5): the same contact is homeowner on two queue leads -> ambiguous, never New reply
      ...(() => { const g = `shared${k.rng.int(0, 1e9)}`; return [
        k.lead("contact_shared", { question: "SQ5", contactShared: true, contactGroup: g, messages: [k.inb("i", at, { contactOnly: true })] }),
        k.lead("contact_shared_sibling", { question: "SQ5", contactShared: true, contactGroup: g }),
      ]; })(),
      k.lead("missed_call", { missedCalls: [at] }),
    ];
  } },
  { id: "reply_handled_by", title: "reply handled by …", build: (k) => {
    const i = k.now - 3 * HOUR;
    const after = (ago: number) => k.j(i + ago, 30 * SEC);
    const sendAt = after(HOUR);
    const base = (key: string, over: Partial<Lead>) => k.lead(key, { messages: [k.inb("i", i)], ...over });
    const withReply = (key: string, source: OutboundSource) => base(key, { messages: [k.inb("i", i), k.out("o", sendAt, { source })] });
    return [
      withReply("human", "human"), withReply("approved", "approved_draft"), withReply("ai_template", "ai_template"), withReply("ai_written", "ai_written"),
      base("reached", { attempts: [k.attempt(after(HOUR), "reached")] }),
      base("voicemail", { attempts: [k.attempt(after(HOUR), "voicemail")] }),
      base("no_answer", { attempts: [k.attempt(after(HOUR), "no_answer")] }),
      base("wrong_number", { attempts: [k.attempt(after(HOUR), "wrong_number")] }),
      base("note", { events: [{ type: "note", at: after(HOUR), actor: "user" }] }),
      base("rep_enrollment", { enrollment: k.drip({ enrolledBy: "rep", enrolledAt: after(HOUR) }) }),
      base("ai_enrollment", { enrollment: k.drip({ enrolledBy: "ai", enrolledAt: after(HOUR) }) }),
      base("dispo", { events: [{ type: "dispo_set", at: after(HOUR), actor: "user" }] }),
      base("system_dispo", { events: [{ type: "dispo_set", at: after(HOUR), actor: "system" }] }),
      base("next_step", { events: [{ type: "appointment_booked", at: after(HOUR), actor: "user" }], appointments: [k.appt("a", k.now + DAY)] }),
      base("log_attempt_event", { events: [{ type: "my_leads_workflow", at: after(HOUR), actor: "user", operation: "log_acquisition_attempt" }] }),
      base("log_offer_event", { events: [{ type: "my_leads_workflow", at: after(HOUR), actor: "user", operation: "log_acquisition_offer" }] }),
      base("campaign_text", { messages: [k.inb("i", i), k.out("o", sendAt, { source: "campaign" })] }),
      base("queued_text", { messages: [k.inb("i", i), k.out("o", sendAt, { outcome: "queued" })] }),
      base("ai_hold_draft", { aiDraftPending: true }),
      // v9 17 (SQ4): a no-answer attempt plus its log_acquisition_attempt workflow event must NOT clear the reply
      base("no_answer_plus_log_event", { attempts: [k.attempt(after(HOUR), "no_answer")], events: [{ type: "my_leads_workflow", at: after(HOUR), actor: "user", operation: "log_acquisition_attempt" }] }),
      base("handled_then_draft", { attempts: [k.attempt(after(HOUR), "reached")], aiDraftPending: true }),
    ];
  } },
  { id: "stamped_x_then_y", title: "stamped reply X then Y", build: (k) => {
    const x = k.j(k.now - 3 * HOUR), y = k.j(k.now - 2 * HOUR);
    const send = k.j(k.now - HOUR);
    const stamps = [{ kind: "inbound", ref: "x" }, { kind: "inbound", ref: "y" }, { kind: "foreign" }, undefined] as const;
    return stamps.flatMap((stamp, n) => (["human", "ai_written"] as OutboundSource[]).map((source) =>
      k.lead(`s${n}_${source}`, { messages: [k.inb("x", x), k.inb("y", y), k.out("o", send, { source, ...(stamp ? { stamp } : {}) })] })));
  } },
  { id: "unresolved_stamp", title: "unresolved-stamp text", build: (k) => {
    const i = k.now - 3 * HOUR;
    const send = k.now - 2 * HOUR;
    return [
      k.lead("alone", { messages: [k.inb("i", i), k.out("o", send, { stamp: { kind: "unresolved" } })] }),
      k.lead("then_reached", { messages: [k.inb("i", i), k.out("o", send, { stamp: { kind: "unresolved" } })], attempts: [k.attempt(k.now - HOUR, "reached")] }),
      k.lead("then_plain_text", { messages: [k.inb("i", i), k.out("o", send, { stamp: { kind: "unresolved" } }), k.out("p", k.now - HOUR)] }),
      k.lead("no_inbound", { messages: [k.out("o", send, { stamp: { kind: "unresolved" } })] }),
    ];
  } },
  { id: "accepted_then_failed", title: "accepted-then-delivery-failed with/without newer inbound", build: (k) => {
    const x = k.now - 3 * HOUR;
    const sentAt = k.j(k.now - 2 * HOUR);
    const failed = k.out("o", sentAt, { outcome: "accepted_then_failed", sentAt, failedAt: sentAt + 10 * MIN });
    const y = k.j(sentAt + 30 * MIN, 20 * MIN);
    return [
      k.lead("no_y", { messages: [k.inb("x", x), failed] }),
      k.lead("with_y", { messages: [k.inb("x", x), failed, k.inb("y", y)] }),
      k.lead("ledger_failed_no_y", { messages: [k.inb("x", x), k.out("o", sentAt, { outcome: "accepted_then_failed", sentAt, failedAt: sentAt + 10 * MIN, ledger: { state: "delivery_failed", updatedAt: sentAt + 10 * MIN } })] }),
      k.lead("ledger_failed_with_y", { messages: [k.inb("x", x), k.out("o", sentAt, { outcome: "accepted_then_failed", sentAt, failedAt: sentAt + 10 * MIN, ledger: { state: "delivery_failed", updatedAt: sentAt + 10 * MIN } }), k.inb("y", y)] }),
    ];
  } },
  { id: "failed_non_ledger", title: "failed non-ledger text", build: (k) => {
    const failAt = k.j(k.now - 2 * HOUR);
    const f = (ago = 0) => k.out("f", failAt - ago, { outcome: "failed", failedAt: failAt - ago + MIN });
    return [
      k.lead("alone", { messages: [f()] }),
      k.lead("replaced", { messages: [f(), k.out("r", k.j(failAt + 30 * MIN, 10 * MIN))] }),
      k.lead("no_answer_after", { messages: [f()], attempts: [k.attempt(k.now - HOUR)] }),
      k.lead("dispo_after", { messages: [f()], events: [{ type: "dispo_set", at: k.now - HOUR, actor: "user" }] }),
      k.lead("drip_after", { messages: [f()], enrollment: k.drip({ enrolledBy: "rep", enrolledAt: k.now - HOUR }) }),
      k.lead("dismissed", { messages: [f()], events: [{ type: "rep_sms_failure_dismissed", at: k.now - HOUR, actor: "user", dismisses: "f" }] }),
      k.lead("seven_day_edge", { messages: [k.out("f", k.j(k.now - 7 * DAY), { outcome: "failed", failedAt: k.now - 7 * DAY + MIN })] }),
      k.lead("after_reply_fails", { messages: [k.inb("i", k.now - 3 * HOUR), f()] }),
    ];
  } },
  { id: "provider_unknown", title: "provider_unknown text", build: (k) => {
    const at = k.j(k.now - 2 * HOUR);
    return [
      k.lead("unverified", { messages: [k.out("u", at, { outcome: "failed_unknown" })] }),
      k.lead("reconciled_delivered", { messages: [k.out("u", at, { outcome: "delivered" })] }),
      k.lead("reconciled_failed", { messages: [k.out("u", at, { outcome: "failed" })] }),
      k.lead("pending_stale", { messages: [k.out("p", k.j(k.now - 15 * MIN), { outcome: "pending" })] }),
      k.lead("pending_fresh", { messages: [k.out("p", k.now - 5 * MIN, { outcome: "pending" })] }),
      k.lead("with_reply", { messages: [k.inb("i", k.now - 3 * HOUR), k.out("u", at, { outcome: "failed_unknown" })] }),
    ];
  } },
  { id: "ledger_unknown_stale", title: "ledger unknown stale", build: (k) => {
    const states = ["unknown", "reserved", "sending"] as const;
    return states.flatMap((s) => [-5, 0, 5, 40].map((d) => {
      const updatedAt = k.j(k.now - (15 + d) * MIN, 20 * SEC);
      return k.lead(`${s}_${d}`, { ledgers: [{ ref: "l", state: s, updatedAt }], ...(s === "unknown" && updatedAt > k.now - 15 * MIN ? { question: "SQ2" } : {}) });
    })).concat((["sending", "reserved"] as const).flatMap((st) => EXACT.map((e) => k.lead(`${st}_exact${e}`, { ledgers: [{ ref: "l", state: st, updatedAt: k.now - 15 * MIN + e }] })))).concat([-5, 5].map((d) => {
      const updatedAt = k.j(k.now - (15 + d) * MIN, 20 * SEC);
      return k.lead(`obligation_unknown_${d}`, { obligations: [{ ref: "o", state: "unknown", updatedAt }], ...(updatedAt > k.now - 15 * MIN ? { question: "SQ2" } : {}) });
    }));
  } },
  { id: "obligation", title: "obligation required/blocked/stale lease", build: (k) => {
    const at = k.now - HOUR;
    const ob = (key: string, state: Lead["obligations"][number]["state"], lease?: number) => k.lead(key, { obligations: [{ ref: "o", state, updatedAt: at, leaseExpiresAt: lease }] });
    return [
      ob("required", "required"), ob("draft", "draft"), ob("blocked", "blocked"), ob("failed_nd", "failed_not_dispatched"), ob("delivery_failed", "delivery_failed"), ob("unknown", "unknown"),
      ob("claimed_expired", "claimed", k.j(k.now)), ob("claimed_valid", "claimed", k.j(k.now + 10 * MIN)), ob("sending_expired", "sending", k.j(k.now)),
      ob("accepted", "accepted"), ob("voided", "voided"),
      k.lead("replaced", { obligations: [{ ref: "o", state: "delivery_failed", updatedAt: at }], messages: [k.out("r", k.now - 30 * MIN)] }),
    ];
  } },
  { id: "campaign_queue", title: "campaign queued future/overdue", build: (k) => {
    const camp = (key: string, over: Partial<Msg>) => k.lead(key, { messages: [k.out("c", k.now - 2 * DAY, { source: "campaign", outcome: "queued", ...over })] });
    return [
      camp("future", { scheduledFor: k.now + DAY }),
      camp("recent", { scheduledFor: k.now - 10 * MIN }),
      camp("boundary", { scheduledFor: k.j(k.now - 30 * MIN) }),
      camp("overdue", { scheduledFor: k.now - 45 * MIN }),
      ...EXACT.map((e) => camp(`exact${e}`, { scheduledFor: k.now - 30 * MIN + e })),
      k.lead("future_with_reply", { messages: [k.inb("i", k.now - HOUR), k.out("c", k.now - 2 * DAY, { source: "campaign", outcome: "queued", scheduledFor: k.now + DAY })] }),
      k.lead("sent", { messages: [k.out("c", k.now - 2 * DAY, { source: "campaign", sentAt: k.now - 2 * HOUR })] }),
      k.lead("sent_long_ago", { messages: [k.out("c", k.now - 9 * DAY, { source: "campaign", sentAt: k.now - 6 * DAY })] }),
    ];
  } },
  { id: "drip_health", title: "drip healthy/stuck claim/next_run_at overdue", build: (k) => [
    k.lead("healthy", { enrollment: k.drip() }),
    k.lead("nurture_60d", { enrollment: k.drip({ nextRunAt: k.now + 60 * DAY }) }),
    k.lead("overdue_edge", { enrollment: k.drip({ nextRunAt: k.j(k.now - 60 * MIN) }) }),
    k.lead("overdue_30", { enrollment: k.drip({ nextRunAt: k.now - 30 * MIN }) }),
    k.lead("overdue_90", { enrollment: k.drip({ nextRunAt: k.now - 90 * MIN }) }),
    k.lead("claim_edge", { enrollment: k.drip({ claimAt: k.j(k.now - 15 * MIN) }) }),
    k.lead("claim_fresh", { enrollment: k.drip({ claimAt: k.now - 5 * MIN }) }),
    k.lead("no_next_run", { enrollment: k.drip({ nextRunAt: null }) }),
    ...EXACT.map((e) => k.lead(`overdue_exact${e}`, { enrollment: k.drip({ nextRunAt: k.now - 60 * MIN + e }) })),
    ...EXACT.map((e) => k.lead(`claim_exact${e}`, { enrollment: k.drip({ claimAt: k.now - 15 * MIN + e }) })),
  ] },
  { id: "call_in_progress", title: "call_in_progress fresh vs stale", build: (k) => [
    k.lead("fresh", { enrollment: k.drip({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: k.now - 5 * MIN }) }),
    k.lead("edge", { enrollment: k.drip({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: k.j(k.now - 30 * MIN) }) }),
    k.lead("stale", { enrollment: k.drip({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: k.now - 45 * MIN }) }),
    ...EXACT.map((e) => k.lead(`exact${e}`, { enrollment: k.drip({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: k.now - 30 * MIN + e }) })),
    k.lead("fresh_with_callback", { enrollment: k.drip({ status: "paused", pause: "call_in_progress", nextRunAt: null, updatedAt: k.now - 5 * MIN }), appointments: [k.appt("a", k.now + 3 * HOUR)] }),
  ] },
  { id: "drip_pause_reasons", title: "norma_call / manual / provider_failed pauses", build: (k) => {
    const reasons = ["norma_call", "manual", "provider_failed", "appointment_booked", "person_took_over", "terminal_dispo", "inbound_reply", "rep_sms_human_takeover",
      "reconciliation_required", "no_phone", "template_missing", "step_misconfigured", "consent_unavailable", "no_approved_sender"];
    return reasons.flatMap((r) => [
      k.lead(r, { enrollment: k.drip({ status: "paused", pause: r, nextRunAt: null }) }),
      ...(r === "norma_call" ? [k.lead("norma_cb", { enrollment: k.drip({ status: "paused", pause: r, nextRunAt: null }), appointments: [k.appt("a", k.now + DAY)] }), k.lead("norma_open", { enrollment: k.drip({ status: "paused", pause: r, nextRunAt: null }), normaCalling: true })] : []),
    ]);
  } },
  { id: "drip_completed", title: "drip completed no reply / completed then texted", build: (k) => {
    const done = k.now - 13 * DAY;
    const en = (steps = 4) => k.drip({ status: "completed", nextRunAt: null, updatedAt: done, completedAt: done, step: steps, steps });
    const finalText = (extra: Partial<Msg> = {}) => k.out("d", done, { source: "drip", dripFinal: true, ...extra });
    return [
      k.lead("no_reply", { enrollment: en(), messages: [finalText()] }),
      k.lead("not_final", { enrollment: en(), messages: [finalText({ dripFinal: false })] }),
      k.lead("then_texted", { enrollment: en(), messages: [finalText(), k.out("h", k.j(k.now - DAY))] }),
      k.lead("then_callback", { enrollment: en(), messages: [finalText()], appointments: [k.appt("a", k.now + 2 * DAY)] }),
      k.lead("then_new_enrollment", { enrollment: k.drip({ enrolledBy: "rep", enrolledAt: k.now - HOUR }), messages: [finalText()] }),
      k.lead("then_reply", { enrollment: en(), messages: [finalText(), k.inb("i", k.now - 5 * DAY)] }),
      k.lead("opted_out_note", { enrollment: k.drip({ status: "opted_out", nextRunAt: null }), events: [{ type: "note", at: k.now - HOUR, actor: "user" }] }),
    ];
  } },
  { id: "texted_last_short", title: "texted last at 1h / 2 business days", now: (rng) => Date.UTC(2026, 9, 14, 17) + rng.int(0, 30) * DAY, build: (k) => {
    const src = (): OutboundSource => pick(k, ["human", "approved_draft", "ai_template", "ai_written", "campaign"] as const);
    const mk = (key: string, at: number) => k.lead(key, { messages: [k.out("o", at, { source: src() })] });
    return [mk("one_hour", k.j(k.now - HOUR)), mk("two_bd", k.j(addBusinessDaysBack(k.now, 2))), mk("later_inbound", k.now - 2 * HOUR),
      // rows 13/14 follow the latest ACCEPTED outbound (v9 17)
      k.lead("accepted_then_old_failure", { messages: [k.out("o", k.now - 9 * DAY), k.out("f", k.now - 8 * DAY, { outcome: "failed", failedAt: k.now - 8 * DAY + MIN })] }),
      k.lead("accepted_then_dismissed_failure", { messages: [k.out("o", k.now - 2 * HOUR), k.out("f", k.now - HOUR, { outcome: "failed", failedAt: k.now - HOUR + MIN })], events: [{ type: "rep_sms_failure_dismissed", at: k.now - 30 * MIN, actor: "user", dismisses: "f" }] }),
      k.lead("then_inbound", { messages: [k.out("o", k.now - 2 * HOUR), k.inb("i", k.now - HOUR)] })];
  } },
  { id: "texted_last_bd_boundary", title: "texted last 3 business days +1 s, Fri→Mon and DST", now: (rng) => addBusinessDays(rng.pick(BD_SENDS), 3), build: (k) => {
    // `now` is the 3-business-day deadline of a text sent at `s0` (Fri 4 PM, both DST weekends, a plain Wednesday). A text sent one
    // second EARLIER is 3 business days + 1 s old (Gone quiet); one second LATER is still inside the window (Texted last).
    const s0 = BD_SENDS.find((s) => addBusinessDays(s, 3) === k.now) ?? BD_SENDS[0]!;
    const src = (): OutboundSource => pick(k, ["human", "ai_written", "campaign"] as const);
    return [
      k.lead("plus_1s", { messages: [k.out("o", s0 - SEC, { source: src() })] }),
      k.lead("minus_1s", { messages: [k.out("o", s0 + SEC, { source: src() })] }),
      k.lead("plus_1m", { messages: [k.out("o", s0 - MIN - k.rng.int(1, 20) * SEC, { source: src() })] }),
      k.lead("minus_1m", { messages: [k.out("o", s0 + MIN + k.rng.int(1, 20) * SEC, { source: src() })] }),
      ...EXACT.map((e) => k.lead(`exact${e}`, { messages: [k.out("o", s0 - e, { source: src() })] })),
    ];
  } },
  { id: "manual_queued_text", title: "manual queued text with future callback", build: (k) => {
    const q = () => k.out("q", k.now - HOUR, { outcome: "queued" });
    return [
      k.lead("alone", { messages: [q()] }),
      k.lead("future_callback", { messages: [q()], appointments: [k.appt("a", k.now + DAY)] }),
      k.lead("healthy_drip", { messages: [q()], enrollment: k.drip() }),
      k.lead("due_callback", { messages: [q()], appointments: [k.appt("a", k.now - HOUR)] }),
      k.lead("with_reply", { messages: [q(), k.inb("i", k.now - 30 * MIN)] }),
      k.lead("future_sched_not_manual", { messages: [k.out("q", k.now - HOUR, { outcome: "queued", scheduledFor: k.now + DAY, source: "campaign" })] }),
    ];
  } },
  { id: "under_contract", title: "under contract with/without callback", build: (k) => {
    const uc = (key: string, over: Partial<Lead>) => k.lead(key, { stage: "under_contract", ...over });
    return [
      uc("nothing", {}),
      uc("future_callback", { appointments: [k.appt("a", k.now + DAY)] }),
      uc("snoozed_future", { appointments: [k.appt("a", k.now - HOUR, { status: "snoozed", snoozedUntil: k.now + 2 * DAY })] }),
      (() => { const due = k.j(k.now + 15 * MIN, 5 * SEC); return uc("callback_boundary", { appointments: [k.appt("a", due)], }); })(),
      uc("callback_overdue", { appointments: [k.appt("a", k.now - 2 * DAY)] }),
      uc("callback_missed", { appointments: [k.appt("a", k.now - 9 * DAY)] }),
      uc("with_reply", { messages: [k.inb("i", k.now - HOUR)] }),
      uc("with_drip", { enrollment: k.drip() }),
      uc("texted", { messages: [k.out("o", k.now - 10 * DAY)] }),
    ];
  } },
  { id: "no_phone", title: "no phone", build: (k) => [
    k.lead("nothing", { hasPhone: false }),
    k.lead("reply", { hasPhone: false, messages: [k.inb("i", k.now - HOUR)] }),
    k.lead("callback", { hasPhone: false, appointments: [k.appt("a", k.now + DAY)] }),
    k.lead("drip_no_phone", { hasPhone: false, enrollment: k.drip({ status: "paused", pause: "no_phone", nextRunAt: null }) }),
    k.lead("new", { hasPhone: false, stage: "not_contacted", attempts: [] }),
  ] },
  { id: "dnc", title: "DNC", build: (k) => [
    k.lead("nothing", { dnc: true }),
    k.lead("reply", { dnc: true, messages: [k.inb("i", k.now - HOUR)] }),
    k.lead("callback_due", { dnc: true, appointments: [k.appt("a", k.now - HOUR)] }),
    k.lead("texted", { dnc: true, messages: [k.out("o", k.now - HOUR)] }),
  ] },
  { id: "owner_viewing_rep", title: "owner viewing rep", view: "owner", build: mixed },
  { id: "deep_link_page2", title: "deep link beyond page 1", view: "deep_link", singleVariant: true, build: (k) => {
    const leads: Lead[] = [];
    for (let n = 0; n < 64; n += 1) leads.push(k.lead(`r${n}`, { messages: [k.inb("i", k.now - (n + 1) * 7 * MIN)] }));
    for (let n = 0; n < 12; n += 1) leads.push(k.lead(`t${n}`, { messages: [k.out("o", k.now - (n + 1) * HOUR)] }));
    return leads;
  } },
];

function addBusinessDaysBack(now: number, n: number): number {
  // a send time n business days before `now` on the Chicago wall clock (as everywhere else), skipping weekends
  let t = now;
  let done = 0;
  while (done < n) {
    t = minusChicagoDays(t, 1);
    if (chicagoLocal(t).dow < 6) done += 1;
  }
  return t;
}

/** A mixed queue used by the owner-view family: one lead of many shapes. */
function mixed(k: Kit): Lead[] {
  const i = k.now - 3 * HOUR;
  return [
    k.lead("reply", { messages: [k.inb("i", i)] }),
    k.lead("due", { appointments: [k.appt("a", k.now - HOUR)] }),
    k.lead("drip", { enrollment: k.drip() }),
    k.lead("texted", { messages: [k.out("o", k.now - HOUR)] }),
    k.lead("broken", { enrollment: k.drip({ status: "paused", pause: "provider_failed", nextRunAt: null }) }),
    k.lead("callback", { appointments: [k.appt("a", k.now + DAY)] }),
    k.lead("quiet", { messages: [k.out("o", k.now - 10 * DAY)] }),
    k.lead("uc", { stage: "under_contract" }),
    plain(k, "nothing"),
  ];
}

export const FAMILY_IDS = FAMILIES.map((f) => f.id);

/** FNV-1a so a (seed, family, repeat) triple maps to a stable 32-bit world seed. */
export function worldSeed(seed: number, family: string, repeat: number): number {
  let h = 2166136261 ^ seed;
  for (const ch of `${family}#${repeat}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export type Variant = { wording: Wording; stage: StageContext };
export const VARIANTS: readonly Variant[] = WORDINGS.flatMap((wording) => STAGE_CONTEXTS.map((stage) => ({ wording, stage })));

/** All 15 wording x stage variants of one family for one repeat, as one world of leads. Deterministic from the seed. */
export function buildFamilyWorld(family: FamilyDef, seed: number, repeat: number, allVariants: readonly Variant[] = VARIANTS) {
  const variants = family.singleVariant ? allVariants.slice(0, 1) : allVariants;
  const rng = createRng(worldSeed(seed, family.id, repeat));
  const now = (family.now ?? defaultNow)(rng);
  const leads: Lead[] = [];
  for (const [n, v] of variants.entries()) {
    const kit = makeKit(now, rng, v.wording, v.stage, `${family.id.slice(0, 18)}${n}`);
    for (const lead of family.build(kit)) leads.push({ ...lead, tags: [...(lead.tags ?? []), `family:${family.id}`, `wording:${v.wording.id}`, `stage:${v.stage}`] });
  }
  return { now, leads };
}

// Re-exported for the smoke test and report.
export type { SendOutcome, Stage };
export { minusChicagoDays };
