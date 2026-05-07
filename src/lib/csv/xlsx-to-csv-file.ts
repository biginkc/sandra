import { read as xlsxRead, utils as xlsxUtils } from "xlsx";

/**
 * Convert an XLSX `ArrayBuffer` into a CSV-shaped `File`.
 *
 * The wizard's upload step takes the user's `.xlsx`, converts it to CSV
 * in browser memory for the client-side parse + validation, and then
 * uploads the file to the `csv-imports` Storage bucket — which the
 * workflow re-parses with papaparse on the server. Pre-fix the upload
 * sent the original XLSX bytes through with `content-type: text/csv`,
 * so the workflow's papaparse got binary garbage, every row's mapped
 * columns were missing, validation returned an empty `normalized` and
 * `ingest.ts` silent-skipped all 100% of the rows. Three production
 * PropStream imports between 2026-05-04 and 2026-05-07 hit that bug
 * (job ids visible in csv_imports — all `0 succeeded / 436 skipped`
 * shape). Returning a real CSV-bytes `File` here means the bytes that
 * land in Storage match the content-type and the workflow can parse
 * them.
 *
 * Only the first sheet is read — the wizard never offered multi-sheet
 * imports.
 */
export function xlsxBufferToCsvFile(
  buffer: ArrayBuffer,
  sourceFilename: string,
): File {
  const wb = xlsxRead(buffer, { type: "array", cellDates: true });
  const firstSheetName = wb.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("XLSX file has no sheets.");
  }
  const ws = wb.Sheets[firstSheetName];
  const csv = xlsxUtils.sheet_to_csv(ws, { blankrows: false });
  const csvFilename = sourceFilename.replace(/\.xlsx$/i, ".csv");
  return new File([csv], csvFilename, { type: "text/csv" });
}
