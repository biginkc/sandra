import type { OpenHold, PipelineRun, RunLabel } from "@/app/(dashboard)/messages-v2/types";

import type { HoldInfo } from "./types";

/**
 * A hold is HOT (SMS to the owner) when one of its reasons is EXACTLY one of the
 * configured values (or matches a `prefix:*` / `*:backed` wildcard entry). Not substring: `price_quoted` or
 * `distressed_seller` are not hot. The default is EMPTY: no hold is hot until
 * reasons are named in `HOLD_ALERT_HOT_REASONS` (comma-separated).
 */
export const HOT_HOLD_REASONS: readonly string[] = [];

/**
 * Hold reasons the system can produce; `HOLD_ALERT_HOT_REASONS` entries are
 * validated against these. Derived from what the code emits (properties'
 * last_ai_escalation_reason via markPropertyNeedsAttention, pipeline run
 * outcome/reason); `holds.reasons.test.ts` fails when an emitted literal is
 * missing here.
 */
export const KNOWN_HOLD_REASONS: readonly string[] = [
  // Flags set by the responder, Jev and the sequences engine.
  "hot_lead",
  "price_or_offer",
  "distress",
  "multi_property",
  "call_request",
  "third_party",
  "needs_review",
  "draft_held",
  "quiet_hours_recipient",
  "template_sent_outcome_missing",
  "draft_persist_failed",
  "reply_pending",
  "needs_reply",
  "send_timeout",
  "send_timeout_then_sent",
  "send_timeout_unparseable",
  "send_check_failed",
  "rep_sms_human_takeover",
  "inbound_reply",
  "generate_error",
  "provider_billing",
  "provider_auth",
  "suppression_incomplete",
  "workflow_start_and_fallback_failed",
  "jev_unexpected_send_route",
  "jev_new_lead_promotion_failed",
  "jev_unclear_no_action",
  // Model judgments about opt-out / DNC / phone-wide wrong number never act
  // on their own (Jarrad 2026-10-07); a human confirms each one.
  "jev_dnc_needs_confirm",
  "jev_opted_out_needs_confirm",
  "jev_wrong_number_all_needs_confirm",
  "model_opt_out_needs_confirm",
  "model_dnc_needs_confirm",
  // Hostile / opt-out PHRASE wording (Jarrad 2026-10-08): held for a person.
  "hostile_needs_confirm",
  "optout_phrase_needs_confirm",
  "sold_needs_human",
  "wrong_number_suppression_failed",
  "hostile_suppression_failed",
  "ai_disposition_replay_lookup_failed",
  "ai_disposition_missing_thread_identity",
  // Run outcomes / reasons.
  "escalated",
  "auto_closed",
  "opted_out",
  "skipped",
  "error",
  "flag_failed",
  "llm_autosend_off",
  "outbound_mode_hold",
  "stale_context",
  "claim_refused_on_retry",
  "disposition_write_failed",
  "db_error",
  "property_not_found",
  "already_claimed",
  "already_terminal",
  "already_answered",
  "already_flagged",
  "evidence_truncated",
  "superseded_before_send",
  "superseded_by_broadcast",
  "rep_text_scheduled",
  "sent_late",
  "replayed_other_disposition",
  "jev_stale_decision_context",
  "dnc_proposal_write_failed",
  "disposition_proposal_write_failed",
  "dnc_keyword",
  "stop_keyword",
  "help_keyword",
  "wrong_number_keyword",
  "no_property",
  "no_contact",
  "ai_responder_exception",
];

/** Families with a variable tail: `keyword:<tier>`, `safety:<reason>`, `dead_letter_failed:<reason>` ... */
export const KNOWN_HOLD_REASON_PREFIXES: readonly string[] = [
  "keyword:",
  "safety:",
  "low_confidence:",
  "reply_skipped:",
  "send_blocked:",
  "send_timeout:",
  "dead_letter_failed:",
  "suppression_incomplete:",
  "hostile_needs_confirm:",
  "optout_phrase_needs_confirm:",
  "jev_below_threshold:",
  "jev_automatic_failed:",
  "model:",
  "already_flagged:",
];

/** Marker appended once a timeout flag's dead-letter row exists (`send_timeout:<id>:backed`). */
export const BACKED_SUFFIX = ":backed";

/** True when `v` is a reason the system emits: exact, `<prefix><tail>`, or either with the `:backed` suffix. */
export function isKnownHoldReason(v: string): boolean {
  const base = v.endsWith(BACKED_SUFFIX) ? v.slice(0, -BACKED_SUFFIX.length) : v;
  if (!base) return false;
  if (KNOWN_HOLD_REASONS.includes(base)) return true;
  return KNOWN_HOLD_REASON_PREFIXES.some((p) => base.startsWith(p) && base.length > p.length && !/\s/.test(base));
}

/**
 * A `HOLD_ALERT_HOT_REASONS` entry may be a wildcard: `dead_letter_failed:*`
 * (a known prefix family) or `*:backed` (the backed suffix). Anything else is exact.
 */
export function isKnownHotEntry(entry: string): boolean {
  if (entry.endsWith("*")) return KNOWN_HOLD_REASON_PREFIXES.includes(entry.slice(0, -1));
  if (entry.startsWith("*")) return entry.slice(1) === BACKED_SUFFIX;
  return isKnownHoldReason(entry);
}

function matchesHotEntry(reason: string, entry: string): boolean {
  if (entry.endsWith("*")) return reason.startsWith(entry.slice(0, -1));
  if (entry.startsWith("*")) return reason.endsWith(entry.slice(1));
  return reason === entry;
}

/** Reads `HOLD_ALERT_HOT_REASONS`: unknown values are dropped with a warning. */
export function parseHotHoldReasons(
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): readonly string[] {
  const raw = env.HOLD_ALERT_HOT_REASONS;
  if (!raw || !raw.trim()) return HOT_HOLD_REASONS;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    if (!isKnownHotEntry(value)) {
      warn(`HOLD_ALERT_HOT_REASONS: ignoring unknown hold reason "${value}"`);
      continue;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** The reasons a hold carries, each compared whole against `hotReasons`: flag reason, run outcome, run reason. */
export function isHotHold(hold: OpenHold<PipelineRun>, hotReasons: readonly string[] = HOT_HOLD_REASONS): boolean {
  const reasons = [hold.flag_reason, hold.run?.final_outcome, hold.run?.reason].filter(
    (v): v is string => typeof v === "string",
  );
  return reasons.some((reason) => hotReasons.some((entry) => matchesHotEntry(reason, entry)));
}

/** What the hold is about, stable while the hold is: its flag reason, else the sources that opened it. */
export function holdReasonKey(hold: Pick<OpenHold<PipelineRun>, "flag_reason" | "sources">): string {
  return hold.flag_reason || hold.sources.join("+") || "hold";
}

/** `${property}:${reason}`; the start time is never part of the key. */
export function holdKeyFor(propertyId: string, reasonKey: string): string {
  return `${propertyId}:${reasonKey}`;
}

/** The send-timeout flag alone is informational (the reply did go out): no alert. */
export function isInformationalHold(hold: OpenHold<PipelineRun>): boolean {
  return (
    hold.flag_reason === "send_timeout_then_sent" &&
    hold.sources.length === 1 &&
    hold.sources[0] === "needs_attention"
  );
}

/**
 * Reduce open holds to what an alert may carry: ids, first name, age.
 * `labels` is keyed by hold id (the page's label loader output). Holds with no
 * property and informational holds are dropped.
 */
export function toAlertHolds(
  holds: readonly OpenHold<PipelineRun>[],
  labels: ReadonlyMap<string, RunLabel>,
  hotReasons: readonly string[] = HOT_HOLD_REASONS,
): HoldInfo[] {
  const out: HoldInfo[] = [];
  for (const hold of holds) {
    if (!hold.property_id) continue;
    if (isInformationalHold(hold)) continue;
    const label = labels.get(hold.id);
    out.push({
      holdKey: holdKeyFor(hold.property_id, holdReasonKey(hold)),
      propertyId: hold.property_id,
      since: hold.since,
      startedAt: hold.alert_since ?? null,
      name: label?.name ?? "Unknown sender",
      hot: isHotHold(hold, hotReasons),
    });
  }
  return out;
}
