/**
 * Phone line-type vocabulary shared by ingest (skip trace, CSV) and the
 * SMS send path. Mirrors the contacts.phone_N_type CHECK constraint.
 *
 * 'unknown' means "never classified" (legacy imports), not "classified
 * as something else" — sends treat landline as a hard block and unknown
 * as operator's choice.
 */
export type PhoneLineType = "mobile" | "landline" | "unknown";

/** Narrow an arbitrary DB string to the line-type vocabulary. */
export function asLineType(value: string | null | undefined): PhoneLineType {
  return value === "mobile" || value === "landline" ? value : "unknown";
}

/** Vendor labels (Tracerfy "Mobile"/"Landline", PropStream "Mobile"/
 *  "Landline"/"Land Line") → our lowercase vocabulary. */
export function lineTypeFromVendorLabel(
  label: string | null | undefined,
): PhoneLineType {
  const v = (label ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (v === "mobile" || v === "cell" || v === "wireless") return "mobile";
  if (v === "landline") return "landline";
  return "unknown";
}
