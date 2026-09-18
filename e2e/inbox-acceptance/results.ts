import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";

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
  fs.writeFileSync(
    RESULTS_FILE,
    JSON.stringify(
      {
        candidate_sha: candidateSha(),
        run_started_at: new Date().toISOString(),
        cleanup_ok: false,
        rows: [],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

type ResultsFile = {
  candidate_sha: string;
  run_started_at: string;
  cleanup_ok: boolean;
  run_finished_at?: string;
  rows: RowOutcome[];
};

function candidateSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
  }).trim();
}

function readResultsFile(): ResultsFile {
  if (!fs.existsSync(RESULTS_FILE)) {
    return { candidate_sha: "", run_started_at: "", cleanup_ok: false, rows: [] };
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  // Older checked-in artifacts were a bare row array. Read them so a failed
  // teardown can still report its rows, but their missing identity is a
  // deliberate release-gate failure rather than proof for a candidate.
  if (Array.isArray(parsed)) {
    return { candidate_sha: "", run_started_at: "", cleanup_ok: false, rows: parsed as RowOutcome[] };
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("acceptance results file must be an object");
  }
  const file = parsed as Partial<ResultsFile>;
  if (!Array.isArray(file.rows)) {
    throw new Error("acceptance results file is missing rows");
  }
  return {
    candidate_sha: typeof file.candidate_sha === "string" ? file.candidate_sha : "",
    run_started_at: typeof file.run_started_at === "string" ? file.run_started_at : "",
    cleanup_ok: file.cleanup_ok === true,
    ...(typeof file.run_finished_at === "string" ? { run_finished_at: file.run_finished_at } : {}),
    rows: file.rows,
  };
}

export function markCleanupComplete(): void {
  const file = readResultsFile();
  file.cleanup_ok = true;
  file.run_finished_at = new Date().toISOString();
  writeResultsFile(file);
}

function writeResultsFile(file: ResultsFile): void {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export function recordRowOutcome(result: RowOutcome): void {
  const file = readResultsFile();
  file.rows.push(result);
  writeResultsFile(file);
}

/**
 * Remove any previously recorded outcomes for the given row ids (Astra
 * round-3 finding #2). Playwright retries re-run a WHOLE test from
 * scratch on failure — retries are only enabled in CI
 * (`retries: process.env.CI ? 2 : 0`), but when they are, an attempt
 * that passes and records "pass" for its rows, then fails on a LATER
 * unrelated assertion, triggers a full retry. Without this purge, the
 * retry's own outcomes would sit ALONGSIDE the first attempt's stale
 * "pass" entries, and if the retry fails before reaching one of those
 * rows' assertions again, afterEach's "already recorded" check would
 * see the first attempt's leftover pass and skip backfilling a fail —
 * silently keeping a pass that does not reflect the test's true final
 * result. Call this at the START of every attempt (test.beforeEach)
 * for the ids that attempt owns, so only THIS attempt's outcomes can
 * ever be present for those ids by the time afterEach runs.
 */
export function purgeRowOutcomes(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const file = readResultsFile();
  const idSet = new Set(ids);
  file.rows = file.rows.filter((r) => !idSet.has(r.id));
  writeResultsFile(file);
}

export function readMatrixResults(): RowOutcome[] {
  return readResultsFile().rows;
}

export function hasRecordedOutcome(id: string): boolean {
  return readMatrixResults().some((r) => r.id === id);
}

/**
 * Capture a durable screenshot for a passing row (Astra round-2 finding
 * #1: Evidence cells must link a real run artifact, not the source spec
 * file). Written under test-results/, returned as a repo-relative path
 * suitable for the matrix's Evidence column.
 */
export async function captureRowEvidence(page: Page, id: string, subject?: Locator): Promise<string> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const absolutePath = path.join(EVIDENCE_DIR, `${id}.png`);
  await (subject ?? page).screenshot({ path: absolutePath });
  return path.relative(path.resolve(__dirname, "../.."), absolutePath);
}

export { RESULTS_FILE, EVIDENCE_DIR };
