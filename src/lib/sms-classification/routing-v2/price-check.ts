import { V2_PRICE_CHECK_ACTIONS, V2_ROAD_ACTIONS, type V2Action } from "./actions";
import type { ValueLookupResult } from "./dealmachine-value";
import { v2SliceAllowed, type RoutingV2Flags } from "./flags";
import { DEFAULT_CUTOFF } from "./order";
import { askAboveEightyPercent, extractDollarAmount, type ExtractedPrice } from "./price-amount";
import { REPAIRS_FOLLOW_UP_IDS, type PropertyTypeOption, type RepairsFollowUpId } from "./questions";
import { v2ReplyText } from "./reply-texts";
import type { V2Decision } from "./route";

/**
 * Routing v2 PR-E: the price check (ORDER-TABLE row 11, BUILD-PLAN §5 PR-E, §7 Q8).
 *
 * NOT wired into live dispatch: the cutover PR calls these. Every outcome is built from the
 * steps PR-B already owns (`V2_ROAD_ACTIONS`, `V2_PRICE_CHECK_ACTIONS`); no text lives here.
 *
 *   price_check flag off (or property not eligible) → today's price alert, byte-identical
 *     (`V2_ROAD_ACTIONS.price_check`), and DealMachine is never asked.
 *   lot  → alert tagged vacant lot (`ALERT_land_price`), no 80% check, no DealMachine call.
 *   commercial → alert (`ALERT_commercial`), no DealMachine call.
 *   no single dollar amount (none / multiple / range) → fair-price reply + alert, no call.
 *   DealMachine error / no value → fair-price reply + alert.
 *   ask > 80% of value → repairs reply (`price_too_high`); follow-ups run on the next inbound.
 *   ask ≤ 80% (exactly 80% included) → fair-price reply + alert.
 */
export type V2PriceCheckOutcome =
  | "flag_off"
  | "land_price"
  | "commercial"
  | "no_single_amount"
  | "no_value"
  | "too_high"
  | "fair";

export type V2PriceCheckResult = {
  outcome: V2PriceCheckOutcome;
  action: V2Action;
  extracted: ExtractedPrice | null;
  value: number | null;
  /** Why the value was missing (provider/cache), for the audit. */
  noValueReason?: string;
};

export type V2PriceCheckInput = {
  flags: RoutingV2Flags;
  propertyId: string;
  /** The routeV2 decision that reached the price_check road. */
  decision: V2Decision;
  reply: string;
  propertyType: Record<PropertyTypeOption, number>;
  /** Cached/claimed DealMachine lookup (only called when a single amount was named). */
  lookupValue: () => Promise<ValueLookupResult>;
};

const valid = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const priceAction = (steps: V2Action["steps"]): V2Action => ({ road: "price_check", steps });

/** Today's price alert (flag off): exactly what PR-B's road table already does. */
export function v2PriceCheckFlagOffAction(decision: V2Decision): V2Action {
  return { road: "price_check", steps: V2_ROAD_ACTIONS.price_check(decision) };
}

export async function runV2PriceCheck(input: V2PriceCheckInput): Promise<V2PriceCheckResult> {
  if (!v2SliceAllowed(input.flags, "price_check", input.propertyId)) {
    return { outcome: "flag_off", action: v2PriceCheckFlagOffAction(input.decision), extracted: null, value: null };
  }
  if ((input.propertyType.lot ?? 0) >= DEFAULT_CUTOFF) {
    return {
      outcome: "land_price",
      action: { road: "ALERT_land_price", steps: V2_ROAD_ACTIONS.ALERT_land_price(input.decision) },
      extracted: null,
      value: null,
    };
  }
  if ((input.propertyType.commercial ?? 0) >= DEFAULT_CUTOFF) {
    return {
      outcome: "commercial",
      action: { road: "ALERT_commercial", steps: V2_ROAD_ACTIONS.ALERT_commercial(input.decision) },
      extracted: null,
      value: null,
    };
  }

  const extracted = extractDollarAmount(input.reply);
  if (extracted.kind !== "single") {
    return { outcome: "no_single_amount", action: priceAction(V2_PRICE_CHECK_ACTIONS.fair_or_no_value), extracted, value: null };
  }

  let lookup: ValueLookupResult;
  try {
    lookup = await input.lookupValue();
  } catch {
    lookup = { kind: "no_value", reason: "lookup_threw" };
  }
  if (lookup.kind !== "value" || !Number.isFinite(lookup.value) || lookup.value <= 0) {
    return {
      outcome: "no_value",
      action: priceAction(V2_PRICE_CHECK_ACTIONS.fair_or_no_value),
      extracted,
      value: null,
      noValueReason: lookup.kind === "no_value" ? lookup.reason : "invalid_value",
    };
  }
  if (askAboveEightyPercent(extracted.amount, lookup.value)) {
    return { outcome: "too_high", action: priceAction(V2_PRICE_CHECK_ACTIONS.too_high), extracted, value: lookup.value };
  }
  return { outcome: "fair", action: priceAction(V2_PRICE_CHECK_ACTIONS.fair_or_no_value), extracted, value: lookup.value };
}

/**
 * Was our last text the repairs reply? Then this inbound runs the repairs follow-ups.
 * Exact match against the approved text (whitespace-trimmed), never a fuzzy match.
 */
export function isAfterRepairsReply(ourLastText: string | null | undefined): boolean {
  return typeof ourLastText === "string" && ourLastText.trim() === v2ReplyText("price_too_high");
}

/**
 * Follow-up yes cutoff: the same 0.60 default as every other v2 yes/no question
 * (`DEFAULT_CUTOFF`, order.ts; BUILD-PLAN §16 "Cutoffs unchanged (60%)"). The plan names no
 * other cutoff for these three; only reason_to_sell differs (0.40).
 */
export const REPAIRS_FOLLOW_UP_CUTOFF = DEFAULT_CUTOFF;

/** Pull the three follow-up probabilities out of a Jev answer map (invalid/missing omitted). */
export function readRepairsFollowUps(
  answers: Record<string, { noul?: unknown } | undefined>,
): Partial<Record<RepairsFollowUpId, number>> {
  const out: Partial<Record<RepairsFollowUpId, number>> = {};
  for (const id of REPAIRS_FOLLOW_UP_IDS) {
    const v = answers[id]?.noul;
    if (valid(v)) out[id] = v;
  }
  return out;
}

export type RepairsFollowUpOutcome = "follow_up_yes" | "no_repairs" | "listed" | "other" | "unavailable";

export type RepairsFollowUpInput = {
  flags: RoutingV2Flags;
  propertyId: string;
  /** Probabilities for the three follow-ups. null/missing/invalid = not answered (fail closed). */
  followUps: Partial<Record<RepairsFollowUpId, number>> | null;
  /** The existing v2 `listed` answer for this inbound. */
  listedProbability: number | null;
  /**
   * Seller said no repairs are needed. There is NO approved question for this (pending
   * Jarrad), so nothing detects it yet; defaults to false so the realtor reply never fires on
   * a guess.
   */
  noRepairs?: boolean;
};

/**
 * Next inbound after the repairs reply. Order as approved: any follow-up yes → alert;
 * "no repairs" → realtor reply; listed yes → Listed drip; anything else → Price too high drip.
 * Returns null when the price_check slice is off (normal routing applies). If the follow-up
 * answers are missing, a person looks (alert) instead of guessing a drip.
 */
export function decideRepairsFollowUp(input: RepairsFollowUpInput): { outcome: RepairsFollowUpOutcome; action: V2Action } | null {
  if (!v2SliceAllowed(input.flags, "price_check", input.propertyId)) return null;
  const fu = input.followUps;
  const complete = fu !== null && REPAIRS_FOLLOW_UP_IDS.every((id) => valid(fu[id]));
  if (!complete) return { outcome: "unavailable", action: priceAction(V2_PRICE_CHECK_ACTIONS.fair_or_no_value.filter((s) => s.kind === "alert")) };
  if (REPAIRS_FOLLOW_UP_IDS.some((id) => (fu[id] as number) >= REPAIRS_FOLLOW_UP_CUTOFF)) {
    return { outcome: "follow_up_yes", action: priceAction(V2_PRICE_CHECK_ACTIONS.fair_or_no_value.filter((s) => s.kind === "alert")) };
  }
  if (input.noRepairs === true) return { outcome: "no_repairs", action: priceAction(V2_PRICE_CHECK_ACTIONS.no_repairs) };
  if (valid(input.listedProbability) && input.listedProbability >= DEFAULT_CUTOFF) {
    return { outcome: "listed", action: { road: "listed_drip", steps: V2_ROAD_ACTIONS.listed_drip(null as never) } };
  }
  return { outcome: "other", action: priceAction(V2_PRICE_CHECK_ACTIONS.other) };
}
