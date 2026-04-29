/**
 * Pure-logic helpers for reshaping Skip Genie / DataTree (D4D) CSV exports
 * so their `PROP: Address Full` column matches the comma-delimited shape
 * the import wizard expects.
 *
 * The script wrapper lives at `scripts/reshape-d4d-csv.ts`; the parsing/
 * unparsing of CSV bytes happens there. This module only knows about
 * already-parsed row objects.
 */

export interface ReshapeStats {
  rowsTotal: number;
  rowsReshaped: number;
  rowsAlreadyComma: number;
  rowsSkippedEmpty: number;
  rowsSkippedNoComponents: number;
}

export type ReshapeStatus =
  | "reshaped"
  | "already_comma"
  | "empty"
  | "no_components";

/**
 * Reshape a single space-delimited address into comma-delimited form using
 * the side-data per-field columns. Returns the input untouched when:
 *   - the value is empty,
 *   - the value already has 2+ commas (idempotent), or
 *   - the per-field components don't actually appear at the end of the
 *     combined string (bad data — the validator will surface it).
 */
export function reshapeAddressFull(
  raw: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined,
): { value: string; status: ReshapeStatus } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { value: "", status: "empty" };

  if (trimmed.split(",").length >= 3) {
    return { value: trimmed, status: "already_comma" };
  }

  const cityT = (city ?? "").trim();
  const stateT = (state ?? "").trim();
  const zipT = (zip ?? "").trim();

  if (!cityT || !stateT || !zipT) {
    return { value: trimmed, status: "no_components" };
  }

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = new RegExp(
    `\\s+${escape(cityT)}\\s+${escape(stateT)}\\s+${escape(zipT)}\\s*$`,
    "i",
  );
  const stripped = trimmed.replace(tail, "");
  if (stripped === trimmed) {
    return { value: trimmed, status: "no_components" };
  }

  const address = stripped.trim();
  if (!address) {
    return { value: trimmed, status: "no_components" };
  }

  return {
    value: `${address}, ${cityT}, ${stateT} ${zipT}`,
    status: "reshaped",
  };
}

export function reshapeRows(
  rows: Record<string, string>[],
  combinedHeader: string,
  cityHeader: string,
  stateHeader: string,
  zipHeader: string,
): { rows: Record<string, string>[]; stats: ReshapeStats } {
  const stats: ReshapeStats = {
    rowsTotal: rows.length,
    rowsReshaped: 0,
    rowsAlreadyComma: 0,
    rowsSkippedEmpty: 0,
    rowsSkippedNoComponents: 0,
  };

  const out = rows.map((row) => {
    const result = reshapeAddressFull(
      row[combinedHeader],
      row[cityHeader],
      row[stateHeader],
      row[zipHeader],
    );
    switch (result.status) {
      case "reshaped":
        stats.rowsReshaped++;
        return { ...row, [combinedHeader]: result.value };
      case "already_comma":
        stats.rowsAlreadyComma++;
        return row;
      case "empty":
        stats.rowsSkippedEmpty++;
        return row;
      case "no_components":
        stats.rowsSkippedNoComponents++;
        return row;
    }
  });

  return { rows: out, stats };
}
