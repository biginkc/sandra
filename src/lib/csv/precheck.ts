/**
 * Pre-import classification for D4D / Skip Genie reshaped CSVs.
 *
 * Each row falls into one of four buckets:
 *   - ready: PROP: Address Full has 2+ commas (parseable) AND this is
 *            the first occurrence of the normalized address in the file
 *   - empty: row has no PROP data at all (D4D's skip-trace miss case)
 *   - intra_file_dup: parseable but the same address appeared earlier
 *   - unparseable: PROP: Address Full has content but is missing the
 *                  commas needed for the validator's regex to extract
 *                  street + city + state + zip
 *
 * The script wrapper (scripts/precheck-d4d-csv.ts) writes the `ready`
 * rows to one file and the `unparseable` rows to a "needs-review" file.
 * Empty rows and intra-file duplicates are dropped — the importer would
 * silent-skip them anyway, so excluding them up front makes the live
 * Progress UI show real work and shaves wall-clock off the run.
 */

const ADDRESS_FULL_HEADER = "PROP: Address Full";
const CITY_HEADER = "PROP: City";
const STATE_HEADER = "PROP: State";
const ZIP_HEADER = "PROP: Zip";

export type RowCategory = "ready" | "empty" | "intra_file_dup" | "unparseable";

export type PrecheckStats = {
  total: number;
  ready: number;
  empty: number;
  intraFileDup: number;
  unparseable: number;
};

export type PrecheckResult = {
  /** Parseable, unique rows — will create a new property each. */
  ready: Record<string, string>[];
  /** Parseable but address matches an earlier row — importer will dedup
   *  but the row's homeowner/agent contacts still upsert against the
   *  matched property. Kept in the import payload by default. */
  intraFileDups: Record<string, string>[];
  /** PROP: Address Full has content but isn't comma-formatted. Won't
   *  validate; offered as a separate download for manual review. */
  needsReview: Record<string, string>[];
  /** No PROP data at all. Skipped silently by the importer; safe to
   *  drop from the upload payload. */
  empty: Record<string, string>[];
  stats: PrecheckStats;
};

/**
 * Detect whether the precheck heuristics apply to a given set of CSV
 * headers. Returns true only for files that look like D4D / Skip Genie
 * exports — i.e. those carrying a `PROP: Address Full` column. For
 * other shapes (DealMachine, Zillow, generic) the panel stays hidden.
 */
export function isPrecheckApplicable(headers: readonly string[]): boolean {
  return headers.includes(ADDRESS_FULL_HEADER);
}

/**
 * Classify a single row in isolation. Returns 'intra_file_dup' for any
 * row that's parseable but has appeared in `seenAddresses` already.
 * Mutates `seenAddresses` to register the first occurrence.
 */
function categorize(
  row: Record<string, string>,
  seenAddresses: Set<string>,
): RowCategory {
  const addrFull = (row[ADDRESS_FULL_HEADER] ?? "").trim();
  const city = (row[CITY_HEADER] ?? "").trim();
  const state = (row[STATE_HEADER] ?? "").trim();
  const zip = (row[ZIP_HEADER] ?? "").trim();

  // Empty: nothing to import.
  if (!addrFull && !city && !state && !zip) return "empty";

  // Has PROP data but Address Full is unparseable (no comma format).
  if (addrFull.split(",").length < 3) return "unparseable";

  const normalized = addrFull.toLowerCase().replace(/\s+/g, " ").trim();
  if (seenAddresses.has(normalized)) return "intra_file_dup";
  seenAddresses.add(normalized);
  return "ready";
}

export function precheckRows(
  rows: readonly Record<string, string>[],
): PrecheckResult {
  const seenAddresses = new Set<string>();
  const ready: Record<string, string>[] = [];
  const intraFileDups: Record<string, string>[] = [];
  const needsReview: Record<string, string>[] = [];
  const empty: Record<string, string>[] = [];
  const stats: PrecheckStats = {
    total: rows.length,
    ready: 0,
    empty: 0,
    intraFileDup: 0,
    unparseable: 0,
  };

  for (const row of rows) {
    const category = categorize(row, seenAddresses);
    switch (category) {
      case "ready":
        ready.push(row);
        stats.ready++;
        break;
      case "empty":
        empty.push(row);
        stats.empty++;
        break;
      case "intra_file_dup":
        intraFileDups.push(row);
        stats.intraFileDup++;
        break;
      case "unparseable":
        needsReview.push(row);
        stats.unparseable++;
        break;
    }
  }

  return { ready, intraFileDups, needsReview, empty, stats };
}
