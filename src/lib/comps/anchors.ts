import { calculateClosr, DEFAULT_INPUTS } from "@/lib/calculators/closr-v1";
import type { CalculatorInputs } from "@/lib/calculators/types";

/**
 * CLOSR anchors with suppression (NN2). `calculateClosr` zero-fills a missing input, so with
 * `arv = null` it still returns `arv70 = 0` and fee offers of `-rehab - fee`. Those numbers are
 * never surfaced: an ARV-dependent anchor is `unavailable` unless `arv` and `rehab` are present
 * and valid, and an as-is anchor is `unavailable` without `asIs`. Inputs come from
 * `lead_comps.as_is_value` and `lead_valuation_inputs` only, never from `properties.arv`.
 */
export type AnchorValue =
  | { status: "ok"; value: number }
  | { status: "unavailable"; reason: "no_as_is" | "no_arv" | "arv_invalid" | "no_rehab" };

export type AsIsAnchorKey = "equity" | "family" | "secure" | "rapid";
export type ArvAnchorKey = "arv70" | "investor" | "fee40000" | "fee30000" | "fee20000" | "fee10000";

export type ClosrAnchors = {
  asIsDependent: Record<AsIsAnchorKey, AnchorValue>;
  arvDependent: Record<ArvAnchorKey, AnchorValue>;
  verifyFirst: boolean;
};

export const AS_IS_ANCHOR_KEYS: readonly AsIsAnchorKey[] = ["equity", "family", "secure", "rapid"];
export const ARV_ANCHOR_KEYS: readonly ArvAnchorKey[] = ["arv70", "investor", "fee40000", "fee30000", "fee20000", "fee10000"];

const MAX_AMOUNT = 1e12;
const isAmount = (n: number | null): n is number => typeof n === "number" && Number.isFinite(n);

export function computeAnchors(i: {
  asIs: number | null;
  arv: number | null;
  rehab: number | null;
  verifyFirst: boolean;
}): ClosrAnchors {
  const asIsOk = isAmount(i.asIs) && i.asIs > 0 && i.asIs <= MAX_AMOUNT;

  let arvReason: Extract<AnchorValue, { status: "unavailable" }>["reason"] | null = null;
  if (!isAmount(i.arv)) arvReason = "no_arv";
  else if (i.arv <= 0 || i.arv > MAX_AMOUNT || (asIsOk && i.arv < (i.asIs as number))) arvReason = "arv_invalid";
  else if (!isAmount(i.rehab) || i.rehab < 0 || i.rehab > MAX_AMOUNT) arvReason = "no_rehab";

  const inputs: CalculatorInputs = {
    ...DEFAULT_INPUTS,
    asIs: asIsOk ? i.asIs : null,
    arv: arvReason === null ? i.arv : null,
    rehab: arvReason === null ? i.rehab : null,
  };
  const r = calculateClosr(inputs);

  const asIsDependent = Object.fromEntries(
    AS_IS_ANCHOR_KEYS.map((key) => [
      key,
      asIsOk ? { status: "ok", value: r[key] } : { status: "unavailable", reason: "no_as_is" },
    ]),
  ) as Record<AsIsAnchorKey, AnchorValue>;

  const arvValues: Record<ArvAnchorKey, number> = {
    arv70: r.arv70,
    investor: r.investor,
    fee40000: r.offers.fee40000,
    fee30000: r.offers.fee30000,
    fee20000: r.offers.fee20000,
    fee10000: r.offers.fee10000,
  };
  const arvDependent = Object.fromEntries(
    ARV_ANCHOR_KEYS.map((key) => [
      key,
      arvReason === null
        ? { status: "ok", value: arvValues[key] }
        : { status: "unavailable", reason: arvReason },
    ]),
  ) as Record<ArvAnchorKey, AnchorValue>;

  return { asIsDependent, arvDependent, verifyFirst: i.verifyFirst };
}
