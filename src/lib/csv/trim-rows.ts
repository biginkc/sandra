import type { Mapping, RowData } from "./validate";

/**
 * Reduce each row to only the columns referenced by the mapping. Drops every
 * unmapped column from the payload before it leaves the client.
 *
 * Why: the wizard reads the user's full CSV (Skip Genie / DataTree D4D files
 * commonly carry 200+ columns of which we use ~15) and submits the rows to a
 * Server Action. Next.js's `serverActions.bodySizeLimit` and Vercel's request
 * body limit both bound how much we can ship in one POST. A 1,855-row D4D
 * file serializes to ~11 MB if we send every column; trimmed to mapped
 * columns it's ~1 MB. Keeps the wizard usable for any CSV the user throws
 * at it without round-tripping through Storage.
 *
 * Invariants:
 * - Validation already ran against the full rows before this point. The
 *   server validates again on the trimmed rows; both validators only ever
 *   read `row[mapping[fieldId]]`, so unmapped columns are unused.
 * - `null` mapping values (the wizard convention for "this field is
 *   intentionally unmapped") are skipped.
 *
 * Performance: O(rows × mapped_cols). For 1,855 rows × 15 cols this is
 * trivial; we don't need to stream.
 */
export function trimRowsToMapping(
  rows: readonly RowData[],
  mapping: Mapping,
): RowData[] {
  const keepHeaders = new Set<string>();
  for (const header of Object.values(mapping)) {
    if (typeof header === "string" && header.length > 0) {
      keepHeaders.add(header);
    }
  }

  return rows.map((row) => {
    const trimmed: Record<string, string | null | undefined> = {};
    for (const header of keepHeaders) {
      // Preserve missing keys as `undefined` (the validator handles those
      // identically to empty strings — see rawFor in validate.ts).
      if (header in row) {
        trimmed[header] = row[header];
      }
    }
    return trimmed;
  });
}
