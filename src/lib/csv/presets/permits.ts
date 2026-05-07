/**
 * Municipal Permits open-data preset (detect-only).
 *
 * Permit-status exports (e.g. `Permits_-_Status_Change_Dataset_*.csv`)
 * carry no PII, no address, no APN — just permit metadata. They aren't
 * lead-import sources; they belong in a property-enrichment flow that
 * doesn't exist yet. We detect them so the user gets a clear "wrong
 * place" message instead of trying to map columns that won't validate.
 */
import type { TransformResult, VendorPreset } from "./types";

const SIGNATURE_HEADERS = [
  "PermitNum",
  "AppliedDate",
  "IssuedDate",
  "StatusCurrent",
] as const;

export const permitsPreset: VendorPreset = {
  id: "permits",
  label: "Municipal Permits",
  description:
    "Permit-status exports from city open-data portals. These don't " +
    "carry property addresses or owner data — they're property " +
    "enrichment, not a lead source.",
  importable: false,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const matched = SIGNATURE_HEADERS.filter((h) => headerSet.has(h));
    if (matched.length === SIGNATURE_HEADERS.length) {
      return {
        id: "permits",
        confidence: 1.0,
        reasons: ["PermitNum + AppliedDate + IssuedDate + StatusCurrent headers present"],
      };
    }
    return null;
  },

  transform(rows, headers) {
    const result: TransformResult = {
      rows,
      headers: [...headers],
      stats: {
        rowsIn: rows.length,
        rowsOut: rows.length,
        rowsCollapsedDup: 0,
        columnsAdded: [],
        columnsRemoved: [],
        notes: [
          "Permits files aren't lead sources — they're property enrichment data. Use a property-enrichment flow once one exists; for now this file can't be imported as leads.",
        ],
      },
    };
    return result;
  },
};
