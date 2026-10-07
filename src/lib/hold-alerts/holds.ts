import type { OpenHold, PipelineRun, RunLabel } from "@/app/(dashboard)/messages-v2/types";

import type { HoldInfo } from "./types";

/**
 * A hold is HOT (SMS to the owner) when its text contains any of these tokens,
 * case-insensitively. Exactly the three tokens in PLAN D8 / section 4.7; do not
 * add others without Jarrad's approval of the exact list.
 */
export const HOT_HOLD_REASON_TOKENS = ["new_lead", "price", "distress"] as const;

export function holdKeyFor(propertyId: string, since: string | null): string {
  return `${propertyId}:${since ?? "unknown"}`;
}

/** Hold text only: reason, flag reason, run outcome and run reason. Never the inbound preview. */
export function isHotHold(hold: OpenHold<PipelineRun>): boolean {
  const text = [hold.reason, hold.flag_reason, hold.run?.final_outcome, hold.run?.reason]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  return HOT_HOLD_REASON_TOKENS.some((token) => text.includes(token));
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
      holdKey: holdKeyFor(hold.property_id, hold.since),
      propertyId: hold.property_id,
      since: hold.since,
      name: label?.name ?? "Unknown sender",
      address: label?.address ?? null,
      hot: isHotHold(hold),
    });
  }
  return out;
}
