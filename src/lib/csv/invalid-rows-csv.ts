import Papa from "papaparse";

import type { Mapping, RowData, ValidatedRow } from "./validate";
import { ruleLabel } from "./error-labels";

/**
 * Build a CSV containing every invalid row, narrowed to the user's mapped
 * columns plus a leading "Error" column.
 *
 * Why narrow: D4D files routinely have 200+ columns; dumping the original
 * full row makes the export unreadable in a sheet. The mapped columns are
 * what the user cares about (the data they intended to import). The Error
 * column is the row's first error, with a human label.
 *
 * Skips empty rows (those have no content; not actionable).
 */
export function buildInvalidRowsCsv(
  rows: readonly RowData[],
  mapping: Mapping,
  validated: readonly ValidatedRow[],
): string {
  const mappedHeaders = Object.values(mapping).filter(
    (h): h is string => typeof h === "string" && h.length > 0,
  );

  const records: Record<string, string>[] = [];

  for (const v of validated) {
    if (v.ok) continue;
    if (v.errors.length === 0) continue; // empty rows have no errors
    const row = rows[v.rowIndex] ?? {};
    const firstError = v.errors[0];
    const record: Record<string, string> = {
      Row: String(v.rowIndex + 2), // +2: header line + 1-indexed
      Error: ruleLabel(firstError.rule),
      "Error detail": firstError.message,
    };
    for (const header of mappedHeaders) {
      const cell = row[header];
      record[header] = cell == null ? "" : String(cell);
    }
    records.push(record);
  }

  const columns = ["Row", "Error", "Error detail", ...mappedHeaders];

  if (records.length === 0) {
    // Papa.unparse([]) returns an empty string, not a header row. Emit the
    // header explicitly so the download is never a confusing blank file.
    return columns.map(escapeCsvCell).join(",");
  }

  return Papa.unparse(records, { columns, newline: "\n" });
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
