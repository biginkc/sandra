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

/**
 * Some skip-trace exports (DealMachine) flag a do-not-call number inside
 * the line-type column itself — the value reads "DO NOT CALL" rather than
 * "Mobile"/"Landline". Such a label has no usable line type, so the
 * number drops under the no-line-type hard rule (migration 080); this
 * predicate lets ingest still raise a contact-level Do Not Contact flag,
 * mirroring PropStream's `Phone N DNC` fold and REISift's "DNC Excluded"
 * sentinel. Compliance-protective: we'd rather over-suppress than text a
 * flagged number, so abbreviations and the "Do Not Contact" spelling both
 * count.
 */
export function isDoNotCallLabel(label: string | null | undefined): boolean {
  const v = (label ?? "").trim().toLowerCase().replace(/[\s_]+/g, "");
  return v === "donotcall" || v === "dnc" || v === "donotcontact";
}
