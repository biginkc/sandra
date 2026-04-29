/**
 * Pre-import precheck for D4D / Skip Genie reshaped CSVs. Splits a
 * reshaped file into two new files:
 *
 *   <input>.cleaned.csv      — rows that will import cleanly
 *   <input>.needs-review.csv — rows whose PROP: Address Full content
 *                              couldn't be parsed (< 2 commas)
 *
 * Empty rows (no PROP data) and intra-file duplicates are dropped from
 * the cleaned output — the importer would silent-skip them anyway.
 *
 * Usage:
 *   npx tsx scripts/precheck-d4d-csv.ts <input.csv>
 */

import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

import { precheckRows } from "../src/lib/csv/precheck";

async function main() {
  const [, , inputArg] = process.argv;
  if (!inputArg) {
    console.error("Usage: npx tsx scripts/precheck-d4d-csv.ts <input.csv>");
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }

  const cleanedPath = inputPath.replace(/\.csv$/i, ".cleaned.csv");
  const reviewPath = inputPath.replace(/\.csv$/i, ".needs-review.csv");

  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    console.warn(`Parse warnings: ${parsed.errors.length}`);
  }

  const headers = parsed.meta.fields ?? [];
  const result = precheckRows(parsed.data);

  fs.writeFileSync(
    cleanedPath,
    Papa.unparse(result.ready, { columns: headers }),
    "utf8",
  );
  fs.writeFileSync(
    reviewPath,
    Papa.unparse(result.needsReview, { columns: headers }),
    "utf8",
  );

  const { stats } = result;
  console.log(`Read ${stats.total} rows from ${path.basename(inputPath)}\n`);
  console.log(`  Ready to import:        ${stats.ready.toString().padStart(5)}  → ${cleanedPath}`);
  console.log(`  Empty (dropped):        ${stats.empty.toString().padStart(5)}  → no PROP data, skip-trace miss`);
  console.log(`  Intra-file dup (dropped):${stats.intraFileDup.toString().padStart(4)}  → same address as earlier row`);
  console.log(`  Needs review:           ${stats.unparseable.toString().padStart(5)}  → ${reviewPath}`);
  console.log(
    `\nUpload ${path.basename(cleanedPath)} for a clean import.`,
  );
  if (stats.unparseable > 0) {
    console.log(
      `Open ${path.basename(reviewPath)} to inspect the ${stats.unparseable} rows whose Address Full couldn't be parsed.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
