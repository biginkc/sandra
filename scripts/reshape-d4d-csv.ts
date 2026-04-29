/**
 * One-shot reshaper for Skip Genie / DataTree (D4D) CSV exports.
 *
 * Problem: D4D's `PROP: Address Full` is space-delimited
 *   ("807 TRIPLE LODE DR ANGELS CAMP CA 95222")
 * but the import wizard's parser expects the comma-delimited shape used by
 * DealMachine, PropStream, etc.:
 *   ("807 TRIPLE LODE DR, ANGELS CAMP, CA 95222")
 *
 * Strategy: D4D files also carry separate `PROP: City`, `PROP: State`, and
 * `PROP: Zip` columns. The script uses those to do an unambiguous strip-from-
 * the-end split — no fragile street-suffix guessing required. Same logic
 * runs against `PROP: Mail *` for the mailing address.
 *
 * Idempotent: rows whose Address Full already contains 2+ commas pass
 * through untouched. Rows missing per-field components also pass through;
 * the import wizard will flag them with its existing parse-failure error.
 *
 * Usage:
 *   npx tsx scripts/reshape-d4d-csv.ts <input.csv> [output.csv]
 *
 * Default output path is `<input>.reshaped.csv` next to the input.
 */

import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

import { reshapeRows } from "../src/lib/csv/reshape-d4d";

const ADDRESS_FULL_HEADER = "PROP: Address Full";
const CITY_HEADER = "PROP: City";
const STATE_HEADER = "PROP: State";
const ZIP_HEADER = "PROP: Zip";

const MAILING_ADDRESS_FULL_HEADER = "PROP: Mail Address Full";
const MAILING_CITY_HEADER = "PROP: Mail City";
const MAILING_STATE_HEADER = "PROP: Mail State";
const MAILING_ZIP_HEADER = "PROP: Mail Zip";

async function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    console.error(
      "Usage: npx tsx scripts/reshape-d4d-csv.ts <input.csv> [output.csv]",
    );
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }

  const outputPath = outputArg
    ? path.resolve(outputArg)
    : inputPath.replace(/\.csv$/i, ".reshaped.csv");

  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length) {
    console.warn(`Parse warnings (${parsed.errors.length}):`);
    for (const err of parsed.errors.slice(0, 5)) {
      console.warn(`  row ${err.row}: ${err.message}`);
    }
  }

  const headers = parsed.meta.fields ?? [];
  const hasProperty =
    headers.includes(ADDRESS_FULL_HEADER) &&
    headers.includes(CITY_HEADER) &&
    headers.includes(STATE_HEADER) &&
    headers.includes(ZIP_HEADER);
  const hasMailing =
    headers.includes(MAILING_ADDRESS_FULL_HEADER) &&
    headers.includes(MAILING_CITY_HEADER) &&
    headers.includes(MAILING_STATE_HEADER) &&
    headers.includes(MAILING_ZIP_HEADER);

  if (!hasProperty && !hasMailing) {
    console.error(
      `Input doesn't look like a D4D / Skip Genie file — required headers ` +
        `not found. Expected at least: ${ADDRESS_FULL_HEADER}, ${CITY_HEADER}, ` +
        `${STATE_HEADER}, ${ZIP_HEADER}.`,
    );
    process.exit(1);
  }

  let rows = parsed.data;
  let totalReshaped = 0;
  let totalAlreadyComma = 0;
  let totalSkipped = 0;

  if (hasProperty) {
    const result = reshapeRows(
      rows,
      ADDRESS_FULL_HEADER,
      CITY_HEADER,
      STATE_HEADER,
      ZIP_HEADER,
    );
    rows = result.rows;
    console.log(
      `Property address: ${result.stats.rowsReshaped} reshaped · ${result.stats.rowsAlreadyComma} already comma-delimited · ${result.stats.rowsSkippedEmpty} empty · ${result.stats.rowsSkippedNoComponents} could not split (left as-is)`,
    );
    totalReshaped += result.stats.rowsReshaped;
    totalAlreadyComma += result.stats.rowsAlreadyComma;
    totalSkipped +=
      result.stats.rowsSkippedEmpty + result.stats.rowsSkippedNoComponents;
  }

  if (hasMailing) {
    const result = reshapeRows(
      rows,
      MAILING_ADDRESS_FULL_HEADER,
      MAILING_CITY_HEADER,
      MAILING_STATE_HEADER,
      MAILING_ZIP_HEADER,
    );
    rows = result.rows;
    console.log(
      `Mailing address:  ${result.stats.rowsReshaped} reshaped · ${result.stats.rowsAlreadyComma} already comma-delimited · ${result.stats.rowsSkippedEmpty} empty · ${result.stats.rowsSkippedNoComponents} could not split (left as-is)`,
    );
    totalReshaped += result.stats.rowsReshaped;
    totalAlreadyComma += result.stats.rowsAlreadyComma;
    totalSkipped +=
      result.stats.rowsSkippedEmpty + result.stats.rowsSkippedNoComponents;
  }

  const out = Papa.unparse(rows, { columns: headers });
  fs.writeFileSync(outputPath, out, "utf8");

  console.log(
    `\nWrote ${rows.length} rows to ${outputPath}\n` +
      `Total: ${totalReshaped} reshaped · ${totalAlreadyComma} already comma-delimited · ${totalSkipped} skipped`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
