import {
  DEFAULT_COMP_SETTINGS,
  type CompSettings,
  type LeadCompRow,
  type ProviderCompResult,
  type VerifyReason,
} from "./types";

export type NormalizedLeadComp = Omit<LeadCompRow, "id" | "org_id" | "property_id" | "request_id" | "fetched_at">;

/**
 * Turns a provider result into the `lead_comps` row the server stores. Confidence follows the
 * org thresholds: `high` when fsd <= half the verify ceiling, `medium` up to the ceiling, else
 * `low`; a missing AVM is `low`. `verify_first` is set with a reason whenever the rep should
 * confirm the number before quoting it. `arv_estimate` is always null (ARV is Jarrad's own number).
 */
export function normalizeProviderResult(
  r: ProviderCompResult,
  provider: LeadCompRow["provider"],
  settings: CompSettings = DEFAULT_COMP_SETTINGS,
): NormalizedLeadComp {
  const value = finitePositive(r.asIs.value);
  const fsd = finiteNonNegative(r.asIs.fsdPct);
  const reasons: VerifyReason[] = [];
  let confidence: LeadCompRow["confidence"];
  if (value === null) {
    confidence = "low";
    reasons.push("no_avm");
  } else if (fsd === null) {
    confidence = "low";
    reasons.push("wide_range");
  } else if (fsd <= settings.verify_max_fsd_pct * 0.5) {
    confidence = "high";
  } else if (fsd <= settings.verify_max_fsd_pct) {
    confidence = "medium";
  } else {
    confidence = "low";
    reasons.push("wide_range");
  }
  if (r.comps.length < settings.verify_min_comps) reasons.push("few_comps");
  if (!r.legal.complete) reasons.push("legal_incomplete");

  let low = finitePositive(r.asIs.low);
  let high = finitePositive(r.asIs.high);
  if (low !== null && high !== null && low > high) [low, high] = [high, low];

  return {
    provider,
    as_is_value: value,
    as_is_low: low,
    as_is_high: high,
    confidence,
    confidence_score: Number.isFinite(r.asIs.score) ? Math.round(r.asIs.score as number) : null,
    verify_first: reasons.length > 0,
    verify_reasons: reasons,
    arv_estimate: null,
    arv_method: "none",
    comps: r.comps,
    owner_of_record: r.ownerOfRecord,
    legal_description: r.legal.text,
    legal_description_complete: r.legal.complete,
    provider_property_id: r.providerPropertyId,
    raw: r.raw,
  };
}

function finitePositive(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}
function finiteNonNegative(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Legal description completeness (conservative, §3.2): `true` only when the text carries a
 * lot/block/tract token AND is at least 25 characters. Subdivision-only legals (common in
 * Assigns) stay incomplete so contract prefill never uses them.
 */
export const LEGAL_TOKEN = /\b(lot|lots|blk|block|tract|tr|sec|section|unit|parcel|l\d+|b\d+)\b/i;
export function classifyLegal(text: string | null | undefined): { text: string | null; complete: boolean } {
  const trimmed = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (!trimmed) return { text: null, complete: false };
  return { text: trimmed, complete: trimmed.length >= 25 && LEGAL_TOKEN.test(trimmed) };
}
