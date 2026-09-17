import fs from "node:fs";
import path from "node:path";

/**
 * Cross-file result collection for the acceptance matrix runner.
 *
 * Playwright's workers:1 + fullyParallel:false still gives each spec file
 * its own test() closures; the simplest reliable way to hand every row's
 * outcome to one final "write the matrix" step is a small append-only JSON
 * file on disk, read back by e2e/inbox-acceptance/global-teardown.ts after
 * every spec has run.
 */

export type MatrixRowResult = {
  id: string;
  status: "pass" | "fail";
  evidence: string;
};

const RESULTS_FILE = path.resolve(
  __dirname,
  "../../test-results/inbox-acceptance-results.json",
);

export function resetResultsFile(): void {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, "[]\n", "utf8");
}

export function recordMatrixResult(result: MatrixRowResult): void {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  const existing: MatrixRowResult[] = fs.existsSync(RESULTS_FILE)
    ? JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"))
    : [];
  existing.push(result);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2), "utf8");
}

export function readMatrixResults(): MatrixRowResult[] {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
}

export { RESULTS_FILE };
