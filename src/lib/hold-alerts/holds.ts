import type { OpenHold, PipelineRun, RunLabel } from "@/app/(dashboard)/messages-v2/types";

import type { HoldInfo } from "./types";

/**
 * A hold is HOT (SMS to the owner) when one of its reasons is EXACTLY one of
 * these values. Exact match, not substring: `price_quoted` or `distressed_seller`
 * are not hot. This list is a business rule: it lives only here.
 */
// pending Jarrad approval: placeholder values, not an approved list.
export const HOT_HOLD_REASONS = ["jev_below_threshold:new_lead", "price_or_offer", "distress"] as const;

/** The reasons a hold carries, each compared whole against HOT_HOLD_REASONS: flag reason, run outcome, run reason. */
export function isHotHold(hold: OpenHold<PipelineRun>): boolean {
  const reasons = [hold.flag_reason, hold.run?.final_outcome, hold.run?.reason].filter(
    (v): v is string => typeof v === "string",
  );
  return reasons.some((reason) => (HOT_HOLD_REASONS as readonly string[]).includes(reason));
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
 * Reduce open holds to what an alert may carry: ids, first name, address, age.
 * `labels` is keyed by hold id (the page's label loader output). Holds with no
 * property and informational holds are dropped.
 */
export function toAlertHolds(
  holds: readonly OpenHold<PipelineRun>[],
  labels: ReadonlyMap<string, RunLabel>,
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
      address: label?.address ?? null,
      hot: isHotHold(hold),
    });
  }
  return out;
}
