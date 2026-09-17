import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import type { RowOutcome } from "./matrix";

/**
 * Cross-file result collection for the acceptance matrix runner.
 *
 * Playwright's workers:1 + fullyParallel:false still gives each spec file
 * its own test() closures; the simplest reliable way to hand every row's
 * outcome to one final "write the matrix" step is a small append-only JSON
 * file on disk, read back by e2e/inbox-acceptance/global-setup.ts's
 * returned teardown after every spec has run.
 */

const RESULTS_FILE = path.resolve(
  __dirname,
  "../../test-results/inbox-acceptance-results.json",
);

const EVIDENCE_DIR = path.resolve(
  __dirname,
  "../../test-results/inbox-acceptance-evidence",
);

export function resetResultsFile(): void {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, "[]\n", "utf8");
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

export function recordRowOutcome(result: RowOutcome): void {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  const existing: RowOutcome[] = fs.existsSync(RESULTS_FILE)
    ? JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"))
    : [];
  existing.push(result);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2), "utf8");
}

export function readMatrixResults(): RowOutcome[] {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
}

export function hasRecordedOutcome(id: string): boolean {
  return readMatrixResults().some((r) => r.id === id);
}

/**
 * Capture a durable screenshot for a passing row (Astra round-2 finding
 * #1: Evidence cells must link a real run artifact, not the source spec
 * file). Written under test-results/ (which the config's `trace: "on"` /
 * `screenshot: "on"` settings also populate per-test), returned as a
 * repo-relative path suitable for the matrix's Evidence column.
 */
export async function captureRowEvidence(page: Page, id: string): Promise<string> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const absolutePath = path.join(EVIDENCE_DIR, `${id}.png`);
  await page.screenshot({ path: absolutePath });
  return path.relative(path.resolve(__dirname, "../.."), absolutePath);
}

export { RESULTS_FILE, EVIDENCE_DIR };
