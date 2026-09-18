import fs from "node:fs";
import path from "node:path";

const MATRIX_PATH = path.resolve(
  __dirname,
  "../../docs/performance/inbox-redesign/acceptance-matrix.md",
);

/** Every required row starts unproven; historical environment gaps are not
 * permanent test exclusions. Only this run's evidence may change a row. */
export const ALL_ROW_IDS = [
  ...Array.from({ length: 14 }, (_, n) => `F${String(n + 1).padStart(2, "0")}`),
  ...Array.from({ length: 13 }, (_, n) => `A${String(n + 1).padStart(2, "0")}`),
  ...Array.from({ length: 5 }, (_, n) => `R${String(n + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, n) => `U${String(n + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, n) => `O${String(n + 1).padStart(2, "0")}`),
];

/**
 * Make arbitrary text (error messages, skip reasons) safe to drop into a
 * single Markdown table cell: strip ANSI color codes, collapse all
 * whitespace/newlines to single spaces, and escape pipe characters so
 * they can never be mistaken for a column boundary. Without this, a raw
 * Playwright assertion error (which routinely contains embedded
 * newlines, ANSI escapes, and `|` in its diff output) silently splits
 * the table across multiple broken rows.
 */
function sanitizeForTableCell(value: string, maxLength = 300): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping ANSI escape sequences
  const noAnsi = value.replace(/\x1b\[[0-9;]*m/g, "");
  const collapsed = noAnsi.replace(/\s+/g, " ").trim();
  const escaped = collapsed.replace(/\|/g, "\\|");
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…` : escaped;
}

// A table cell's content, escape-aware: either a backslash-escaped pair
// (`\|`, `\\`, or any other `\x`) or any single character that is not an
// unescaped pipe/newline. Astra round-3 finding #3: sanitizeForTableCell
// below escapes literal `|` as `\|` so it renders correctly in Markdown —
// but a naive `[^|\n]*` column matcher doesn't know `\|` isn't a real
// delimiter, so on the NEXT rewrite it misreads that escaped pipe as an
// extra column boundary and corrupts the row. Matching `\\.` first (regex
// alternation is ordered) consumes the backslash together with whatever
// follows it as one unit, so an escaped pipe is skipped over instead of
// ending the cell early.
const CELL = String.raw`(?:\\.|[^|\\\n])*`;

function replaceRow(content: string, id: string, status: string, evidence: string): string {
  const rowRegex = new RegExp(`(\\|\\s*${id}\\s*\\|(?:${CELL}\\|){3})${CELL}\\|${CELL}\\|`);
  if (!rowRegex.test(content)) {
    throw new Error(`writeMatrixRows: row ${id} not found in acceptance-matrix.md`);
  }
  const safeStatus = sanitizeForTableCell(status);
  const safeEvidence = sanitizeForTableCell(evidence);
  return content.replace(rowRegex, (_match, prefix: string) => `${prefix} ${safeStatus} | ${safeEvidence} |`);
}

/** Clear stale outcomes before every run, including rows without a test. */
export function resetMatrixForRun(): void {
  let content = fs.readFileSync(MATRIX_PATH, "utf8");
  for (const id of ALL_ROW_IDS) content = replaceRow(content, id, "Not run", "No evidence from this run");
  fs.writeFileSync(MATRIX_PATH, content, "utf8");
}

export type RowOutcome = { id: string; status: "pass" | "fail" | "skip"; evidence: string };

/** Apply outcomes for all required rows; a failed or skipped observation
 * cannot be hidden by another passing observation of the same row. */
export function applyRunOutcomesToMatrix(outcomes: readonly RowOutcome[]): void {
  let content = fs.readFileSync(MATRIX_PATH, "utf8");
  const runAt = new Date().toISOString();
  // One outcome per id: if ANY recording for that id failed, fail wins
  // (even if a later attempt for the same id somehow passed) — a partial
  // failure must never be masked by a later pass in the same run. Else if
  // any recording passed, pass wins (using its evidence). Else skip.
  const byId = new Map<string, RowOutcome[]>();
  for (const outcome of outcomes) {
    const list = byId.get(outcome.id) ?? [];
    list.push(outcome);
    byId.set(outcome.id, list);
  }
  for (const id of ALL_ROW_IDS) {
    const recorded = byId.get(id);
    if (!recorded || recorded.length === 0) continue; // stays "Not run" from the reset baseline
    const failure = recorded.find((r) => r.status === "fail");
    const success = recorded.find((r) => r.status === "pass");
    const skipped = recorded.find((r) => r.status === "skip");
    if (failure) {
      content = replaceRow(content, id, `fail (${runAt})`, failure.evidence);
    } else if (skipped) {
      content = replaceRow(content, id, `blocked: ${skipped.evidence}`, "Not passed");
    } else if (success) {
      content = replaceRow(content, id, `pass (${runAt})`, success.evidence);
    } else {
      const skip = recorded[0];
      content = replaceRow(content, id, `blocked: ${skip.evidence}`, "Not run");
    }
  }
  fs.writeFileSync(MATRIX_PATH, content, "utf8");
}

/** The release gate cannot be green when any required row is absent/skipped. */
export function assertFullAcceptance(outcomes: readonly RowOutcome[]): void {
  const incomplete = ALL_ROW_IDS.filter(id => {
    const rows = outcomes.filter(row => row.id === id);
    return rows.length === 0 || rows.some(row => row.status !== "pass" || !row.evidence.trim());
  });
  if (incomplete.length) throw new Error(`Inbox acceptance incomplete: ${incomplete.join(", ")}`);
}
