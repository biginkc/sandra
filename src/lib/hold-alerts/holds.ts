import type { OpenHold, PipelineRun, RunLabel } from "@/app/(dashboard)/messages-v2/types";

import type { HoldInfo } from "./types";

/**
 * A hold is HOT (SMS to the owner) when one of its reasons is EXACTLY one of the
 * configured values. Exact match, not substring: `price_quoted` or
 * `distressed_seller` are not hot. The default is EMPTY: no hold is hot until
 * reasons are named in `HOLD_ALERT_HOT_REASONS` (comma-separated).
 */
export const HOT_HOLD_REASONS: readonly string[] = [];

/** Hold reasons the system can produce; `HOLD_ALERT_HOT_REASONS` entries are validated against these. */
export const KNOWN_HOLD_REASONS: readonly string[] = [
  "hot_lead",
  "price_or_offer",
  "distress",
  "multi_property",
  "call_request",
  "third_party",
  "needs_review",
  "draft_held",
  "reply_pending",
  "send_timeout_then_sent",
];
/** `jev_below_threshold:<outcome>` is generated per Jev outcome. */
const JEV_BELOW_THRESHOLD = /^jev_below_threshold:[a-z0-9_]+$/;

const isKnownHoldReason = (v: string) => KNOWN_HOLD_REASONS.includes(v) || JEV_BELOW_THRESHOLD.test(v);

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
    if (!isKnownHoldReason(value)) {
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
  return reasons.some((reason) => hotReasons.includes(reason));
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
      name: label?.name ?? "Unknown sender",
      hot: isHotHold(hold, hotReasons),
    });
  }
  return out;
}
