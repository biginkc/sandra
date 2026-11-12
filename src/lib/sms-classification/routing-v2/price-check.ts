import { OPT_OUT_PHRASES } from "@/lib/sequences/opt-out";

import { V2_PRICE_CHECK_ACTIONS, V2_ROAD_ACTIONS, type V2Action } from "./actions";
import type { ValueLookupResult } from "./dealmachine-value";
import { v2SliceAllowed, type RoutingV2Flags } from "./flags";
import { DEFAULT_CUTOFF } from "./order";
import { askAboveEightyPercent, extractDollarAmount, type ExtractedPrice } from "./price-amount";
import { REPAIRS_ALERT_IDS, REPAIRS_FOLLOW_UP_IDS, type PropertyTypeOption, type RepairsFollowUpId, type V2QuestionId } from "./questions";
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
 *   no dollar amount at all + asked_offer ≥ 0.6 + named_price < 0.6 → the book_appointment
 *     road with the asked_offer reply + Book appointment drip (no named-price alert), no call.
 *   no single dollar amount (none / multiple / range) → fair-price reply + alert, no call.
 *   DealMachine error / no value → fair-price reply + alert.
 *   DealMachine record is land (living_area_sqft and num_bedrooms both 0/null) → the same
 *     vacant-lot alert as Jev's lot answer, no 80% check, no seller reply. Unknown → as before.
 *   ask > 80% of value → repairs reply (`price_too_high`); follow-ups run on the next inbound.
 *   ask ≤ 80% (exactly 80% included) → fair-price reply + alert.
 */
export type V2PriceCheckOutcome =
  | "flag_off"
  | "land_price"
  | "commercial"
  | "asked_offer_no_amount"
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
  /** Jev yes probabilities for this inbound. Missing = the asked-offer branch never fires. */
  probabilities?: Partial<Record<V2QuestionId, number>>;
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
  // "What's your offer?" with no amount: row 11 won only because talked_price overlaps
  // asked_offer. Ranges / multiple amounts and a likely spoken price keep the alert below.
  const askedOffer = input.probabilities?.asked_offer;
  const namedPrice = input.probabilities?.named_price;
  if (
    extracted.kind === "none"
    && valid(askedOffer) && askedOffer >= DEFAULT_CUTOFF
    && valid(namedPrice) && namedPrice < DEFAULT_CUTOFF
  ) {
    const decision: V2Decision = {
      ...input.decision,
      road: "book_appointment",
      provenance: { by: "jev", row: "12", step: "book", signal: "asked_offer", probability: askedOffer },
    };
    return {
      outcome: "asked_offer_no_amount",
      action: { road: "book_appointment", steps: V2_ROAD_ACTIONS.book_appointment(decision) },
      extracted,
      value: null,
    };
  }
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
  // Jarrad 2026-11-11: DealMachine says land (no living area, no bedrooms) → straight to him as
  // the vacant-lot alert (same road as Jev's lot answer): no 80% check, no seller reply.
  if (lookup.isLand === true) {
    return {
      outcome: "land_price",
      action: { road: "ALERT_land_price", steps: V2_ROAD_ACTIONS.ALERT_land_price(input.decision) },
      extracted,
      value: lookup.value,
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
  return isExactlyApprovedReply(ourLastText, v2ReplyText("price_too_high"));
}

/**
 * F5: was our last text the approved not-interested reply? Then a bare "ok" (Jev row 19) is
 * an acknowledgement of the no, not a yes. Same exact-match rule as isAfterRepairsReply.
 */
export function isAfterNotInterestedReply(ourLastText: string | null | undefined): boolean {
  return isExactlyApprovedReply(ourLastText, v2ReplyText("not_interested"));
}

function isExactlyApprovedReply(ourLastText: string | null | undefined, approved: string): boolean {
  if (typeof ourLastText !== "string") return false;
  const body = ourLastText.trim();
  if (body === approved) return true;
  // Only Sandra's exact appended phrases; arbitrary trailing seller text is not stripped.
  return OPT_OUT_PHRASES.some((footer) => body === `${approved} ${footer}`);
}

/**
 * Follow-up yes cutoff: the same 0.60 default as every other v2 yes/no question
 * (`DEFAULT_CUTOFF`, order.ts; BUILD-PLAN §16 "Cutoffs unchanged (60%)"). The plan names no
 * other cutoff for these four; only reason_to_sell differs (0.40).
 */
export const REPAIRS_FOLLOW_UP_CUTOFF = DEFAULT_CUTOFF;

/** Pull the four follow-up probabilities out of a Jev answer map (invalid/missing omitted). */
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

/**
 * ORDER-TABLE rows 1, 2 and 2b (legal/hostile, stop, asked us to call) beat the follow-ups:
 * when the regular v2 decision for this inbound is one of these, the follow-ups do not apply
 * and that road stands, unchanged ("Call me should always take precedence over everything",
 * stop stays first).
 * After-repairs precedence: Jarrad 2026-10-30 — row-3/bounce roads close normally. Wrong
 * person / already sold / tenant (wrong_number_close) and the "no SMS capabilities" bounce
 * (bad_number) take their normal road instead of the Price too high drip.
 */
export const REPAIRS_FOLLOW_UP_PRECEDENCE_ROADS: ReadonlySet<string> = new Set([
  "stop", "ALERT_call_me", "wrong_number_close", "bad_number",
]);

export type RepairsFollowUpInput = {
  flags: RoutingV2Flags;
  propertyId: string;
  /** The regular routeV2 decision for this same inbound (stop / call-me win first). */
  mainDecision: V2Decision;
  /** Probabilities for the four follow-ups. null/missing/invalid = not answered (fail closed). */
  followUps: Partial<Record<RepairsFollowUpId, number>> | null;
  /** The existing v2 `listed` answer for this inbound. */
  listedProbability: number | null;
};

const ALERT_ONLY = V2_PRICE_CHECK_ACTIONS.fair_or_no_value.filter((s) => s.kind === "alert");

/**
 * Next inbound after the repairs reply, in the plan's order:
 *   1. stop / legal / call-me (regular decision) → null: that road stands, unchanged;
 *   2. any yes on needs_repairs, flexible_price or original_portion → alert;
 *   3. no_repairs yes → the approved no_repairs_realtor reply;
 *   4. listed yes → Listed drip;
 *   5. anything else → Price too high drip.
 * "No repairs" is ONLY the no_repairs answer at the cutoff: a low needs_repairs, silence or an
 * unclear reply never counts. Returns null when the price_check slice is off (normal routing).
 * Missing follow-up answers → alert (a person looks) instead of guessing.
 */
export function decideRepairsFollowUp(input: RepairsFollowUpInput): { outcome: RepairsFollowUpOutcome; action: V2Action } | null {
  if (!v2SliceAllowed(input.flags, "price_check", input.propertyId)) return null;
  if (input.mainDecision.road !== null && REPAIRS_FOLLOW_UP_PRECEDENCE_ROADS.has(input.mainDecision.road)) return null;
  const fu = input.followUps;
  const complete = fu !== null && REPAIRS_FOLLOW_UP_IDS.every((id) => valid(fu[id]));
  if (!complete) return { outcome: "unavailable", action: priceAction(ALERT_ONLY) };
  const yes = (id: RepairsFollowUpId) => (fu[id] as number) >= REPAIRS_FOLLOW_UP_CUTOFF;
  if (REPAIRS_ALERT_IDS.some(yes)) return { outcome: "follow_up_yes", action: priceAction(ALERT_ONLY) };
  if (yes("no_repairs")) return { outcome: "no_repairs", action: priceAction(V2_PRICE_CHECK_ACTIONS.no_repairs) };
  if (valid(input.listedProbability) && input.listedProbability >= DEFAULT_CUTOFF) {
    return { outcome: "listed", action: { road: "listed_drip", steps: V2_ROAD_ACTIONS.listed_drip(input.mainDecision) } };
  }
  return { outcome: "other", action: priceAction(V2_PRICE_CHECK_ACTIONS.other) };
}
