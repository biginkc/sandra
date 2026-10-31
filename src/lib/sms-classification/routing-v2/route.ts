import { haikuEligibility, type HaikuEligibility } from "./haiku-eligibility";
import { DEFAULT_CUTOFF, LAND_PRICE_SIGNALS, OPPORTUNITY_SIGNALS, V2_ORDER, type V2Road, type V2Signal } from "./order";
import { PROPERTY_TYPE_OPTIONS, V2_QUESTION_IDS, type PropertyTypeOption, type V2QuestionId } from "./questions";

/** Code pre-checks (no AI), regexes copied from the v7 replay (final/jev.py). */
const REACTION = /^\s*(Liked|Loved|Laughed at|Emphasized|Questioned|Disliked)\s+["“”']/i;
const BOUNCE = /no sms capabilit|unable to receive/i;
const DRIVING = /i'?m driving|i am driving|driving,? can'?t text|sent from my car|do not disturb while driving/i;

export type CodeCheck = "reaction" | "bad_number" | "driving" | "not_interested_phrase";

/**
 * Jarrad 2026-10-30 (BUILD-PLAN §16): "Do NOT check back" (and "Do not bother", "No need to
 * call me back") → Not interested drip, NOT a stop. Exactly these three, matched as the whole
 * message, ignoring case, punctuation and extra spaces. Legal / hostile (row 1) and the
 * carrier STOP keyword (webhook) still win. No other phrase is added here.
 */
const NOT_INTERESTED_PHRASES: ReadonlySet<string> = new Set(["do not check back", "do not bother", "no need to call me back"]);

export function isNotInterestedPhrase(reply: string): boolean {
  const norm = reply.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return NOT_INTERESTED_PHRASES.has(norm);
}

export function codePreCheck(reply: string): CodeCheck | null {
  if (REACTION.test(reply)) return "reaction";
  if (BOUNCE.test(reply)) return "bad_number";
  if (DRIVING.test(reply)) return "driving";
  return null;
}

const CODE_ROADS: Record<CodeCheck, V2Road> = {
  reaction: "reaction+book_appointment",
  bad_number: "bad_number",
  driving: "driving_reply+book_appointment",
  not_interested_phrase: "not_interested_drip",
};

/** "A Jev stop / legal / hostile ≥0.70 is final" (Jarrad 2026-10-30): no Haiku, whatever else scored. */
const STOP_FINAL_AT = 0.7;

/** ORDER-TABLE rows 1–2: these beat the code pre-checks. */
const STOP_FIRST_STEPS: ReadonlySet<string> = new Set(["legal_hostile", "asked_stop"]);

export type V2RouteInput = {
  reply: string;
  probabilities: Record<V2QuestionId, number>;
  propertyType: Record<PropertyTypeOption, number>;
};

export type V2Decision = {
  /** null = no question reached its cutoff (would go to Haiku; alert if Haiku cannot tell). */
  road: V2Road | null;
  provenance:
    | { by: "code"; check: CodeCheck }
    | { by: "jev"; row: string; step: string; signal: V2Signal; probability: number }
    | { by: "jev"; row: null; step: null; signal: null; probability: null };
  haiku: HaikuEligibility;
  opportunityAlert: boolean;
};

export function validProbability(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function signalProbability(input: V2RouteInput, signal: V2Signal): number {
  if (signal.startsWith("PT:")) return input.propertyType[signal.slice(3) as PropertyTypeOption] ?? 0;
  return input.probabilities[signal as V2QuestionId];
}

/** Pure router. Callers must pass a complete, validated probability set (see assertCompleteV2). */
export function routeV2(input: V2RouteInput): V2Decision {
  const opportunityAlert = OPPORTUNITY_SIGNALS.some((q) => input.probabilities[q] >= DEFAULT_CUTOFF);
  // Stop/legal/hostile (ORDER-TABLE rows 1–2) are evaluated before the code pre-checks, so
  // "STOP, I'm driving" or a hostile reaction still routes to stop.
  const row1 = V2_ORDER.find((step) => step.step === "legal_hostile")!;
  const row2 = V2_ORDER.find((step) => step.step === "asked_stop")!;
  const finalStop = (step: typeof row1, signal: V2Signal, p: number): V2Decision => ({
    road: "stop", provenance: { by: "jev", row: step.row, step: step.step, signal, probability: p }, haiku: null, opportunityAlert,
  });
  // A confident stop-family answer is final, even when another stop-family signal sits in the
  // Haiku band (review A-1): legal / hostile first (row 1), then asked_stop (row 2).
  for (const { signal } of row1.signals) {
    const p = signalProbability(input, signal);
    if (p >= STOP_FINAL_AT) return finalStop(row1, signal, p);
  }
  const askedStop = row2.signals[0]!;
  const askedStopP = signalProbability(input, askedStop.signal);
  const row1Band = row1.signals.some(({ signal, cutoff }) => signalProbability(input, signal) >= cutoff);
  if (row1Band && askedStopP >= STOP_FINAL_AT) return finalStop(row2, askedStop.signal, askedStopP);
  // D-1: Jarrad's three not-interested phrases, after legal/hostile, before asked_stop.
  if (!row1Band && isNotInterestedPhrase(input.reply)) {
    return { road: CODE_ROADS.not_interested_phrase, provenance: { by: "code", check: "not_interested_phrase" }, haiku: null, opportunityAlert };
  }
  if (askedStopP >= STOP_FINAL_AT) return finalStop(row2, askedStop.signal, askedStopP);
  let checked = false;
  for (const step of V2_ORDER) {
    if (!checked && !STOP_FIRST_STEPS.has(step.step)) {
      checked = true;
      const check = codePreCheck(input.reply);
      if (check) return { road: CODE_ROADS[check], provenance: { by: "code", check }, haiku: null, opportunityAlert: false };
    }
    for (const { signal, cutoff } of step.signals) {
      const p = signalProbability(input, signal);
      if (p >= cutoff) {
        let road = step.road;
        if (road === "vacant_land_drip" && LAND_PRICE_SIGNALS.some((q) => input.probabilities[q] >= DEFAULT_CUTOFF)) {
          road = "ALERT_land_price";
        }
        return {
          road,
          provenance: { by: "jev", row: step.row, step: step.step, signal, probability: p },
          haiku: haikuEligibility({ signal, probability: p }),
          opportunityAlert,
        };
      }
    }
  }
  return {
    road: null,
    provenance: { by: "jev", row: null, step: null, signal: null, probability: null },
    haiku: haikuEligibility(null),
    opportunityAlert,
  };
}

/** Fail closed: a missing or invalid answer means no v2 decision at all. */
export function assertCompleteV2(
  answers: Record<string, { noul?: unknown; probabilities?: Record<string, unknown> } | undefined>,
): { ok: true; probabilities: Record<V2QuestionId, number>; propertyType: Record<PropertyTypeOption, number> } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const probabilities = {} as Record<V2QuestionId, number>;
  for (const id of V2_QUESTION_IDS) {
    const v = answers[id]?.noul;
    if (validProbability(v)) probabilities[id] = v;
    else missing.push(id);
  }
  const propertyType = {} as Record<PropertyTypeOption, number>;
  const pt = answers.property_type?.probabilities;
  for (const opt of PROPERTY_TYPE_OPTIONS) {
    const v = pt?.[opt];
    if (validProbability(v)) propertyType[opt] = v;
    else missing.push(`property_type.${opt}`);
  }
  return missing.length ? { ok: false, missing } : { ok: true, probabilities, propertyType };
}
