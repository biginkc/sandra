import { haikuEligibility, type HaikuEligibility } from "./haiku-eligibility";
import { DEFAULT_CUTOFF, LAND_PRICE_SIGNALS, OPPORTUNITY_SIGNALS, V2_ORDER, type V2Road, type V2Signal } from "./order";
import { PROPERTY_TYPE_OPTIONS, V2_QUESTION_IDS, type PropertyTypeOption, type V2QuestionId } from "./questions";

/** Code pre-checks (no AI), regexes copied from the v7 replay (final/jev.py). */
const REACTION = /^\s*(Liked|Loved|Laughed at|Emphasized|Questioned|Disliked)\s+["“”']/i;
const BOUNCE = /no sms capabilit|unable to receive/i;
const DRIVING = /i'?m driving|i am driving|driving,? can'?t text|sent from my car|do not disturb while driving/i;

export type CodeCheck = "reaction" | "bad_number" | "driving";

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
};

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
