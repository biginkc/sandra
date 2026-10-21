import type { VoicemailDropReasonInfo } from "./types";

/**
 * Reason-code classes exactly as the plan lists them ("Failures after the
 * 202"). Anything not listed is "unclassified"; the plan's config bucket also
 * names bad voice_id / phone_line_id but gives no codes for them, so those are
 * not mapped here.
 */
const CONFIG_CODES = new Set([3021, 4010]);
const CONSENT_CODES = new Set([4016, 6005, 6011]);
const DELIVERY_CODES = new Set([4001, 4002, 4007]);
/** Not in the saved Drop Cowboy spec; confirm in probe 0. */
const UNVERIFIED_CODES = new Set([6005, 6011]);

export function classifyReasonCode(code: number | null | undefined): VoicemailDropReasonInfo {
  const reasonCode = typeof code === "number" && Number.isInteger(code) ? code : null;
  const unverified = reasonCode !== null && UNVERIFIED_CODES.has(reasonCode);
  if (reasonCode === 0) return { reasonCode, reasonClass: "success", unverified };
  if (reasonCode === null) return { reasonCode, reasonClass: "unclassified", unverified };
  if (CONFIG_CODES.has(reasonCode)) return { reasonCode, reasonClass: "config", unverified };
  if (CONSENT_CODES.has(reasonCode)) return { reasonCode, reasonClass: "consent", unverified };
  if (DELIVERY_CODES.has(reasonCode)) return { reasonCode, reasonClass: "delivery", unverified };
  return { reasonCode, reasonClass: "unclassified", unverified };
}
