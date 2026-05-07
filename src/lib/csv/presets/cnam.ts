/**
 * CNAM lookup table preset (detect-only).
 *
 * `cnam_update.csv` and similar files are simple two-column lookup
 * tables — a phone number paired with a CNAM (caller-name) string.
 * Useful for phone-number enrichment but not as a lead source.
 */
import type { TransformResult, VendorPreset } from "./types";

const SIGNATURE_HEADERS = ["phones", "cnam"] as const;

export const cnamPreset: VendorPreset = {
  id: "cnam",
  label: "CNAM Lookup Table",
  description:
    "Phone → caller-name (CNAM) lookup tables. Useful for phone " +
    "enrichment, not for importing leads.",
  importable: false,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const matched = SIGNATURE_HEADERS.filter((h) => headerSet.has(h));
    if (matched.length === SIGNATURE_HEADERS.length && headers.length === 2) {
      return {
        id: "cnam",
        confidence: 1.0,
        reasons: ["Exactly 2 columns: phones + cnam"],
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
          "CNAM files are phone-name lookup tables, not lead sources. They belong in a phone-enrichment flow once one exists.",
        ],
      },
    };
    return result;
  },
};
