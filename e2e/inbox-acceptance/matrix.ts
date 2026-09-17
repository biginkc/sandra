import fs from "node:fs";
import path from "node:path";

const MATRIX_PATH = path.resolve(
  __dirname,
  "../../docs/performance/inbox-redesign/acceptance-matrix.md",
);

/**
 * Canonical blocked-row classification (Astra round-2 finding #3: every
 * blocked row needs an explicit reason, not a bare "Not run").
 *
 * Two buckets, by root cause:
 *  - BACKEND: the row's capability IS wired into /inbox's UI, but the
 *    /inbox backend RPC schema (inbox_authorize_sync etc.) is not
 *    installed on the shared e2e Supabase test project (confirmed via
 *    direct RPC probe: PGRST202). Every /inbox request returns "workspace
 *    unavailable" regardless of fixture data, so these can't be verified
 *    in this environment today even though the UI exists.
 *  - UI: the row's capability is NOT wired into /inbox's UI at all yet
 *    (reuse components exist but are unimported) — blocked independent of
 *    the backend gap, pending Jarrad's mock sign-off on the follow-up PR.
 */
const BACKEND_NOT_INSTALLED_REASON =
  "blocked: /inbox backend schema not installed on e2e test DB (PGRST202 — inbox_authorize_sync not found in schema cache; every /inbox request returns \"workspace unavailable\")";
const UI_NOT_WIRED_REASON = "blocked: UI not wired + mock sign-off";

export const BLOCKED_ROW_REASONS: Record<string, string> = {
  // F01 is structural, not backend-dependent: there is no tab affordance
  // on /inbox at all, by design (Outbox stays on /messages).
  F01: "blocked: no tab affordance exists on /inbox by design — Outbox tab is exercised separately via O01-O10 on /messages",

  // Backend-blocked: UI is wired (search/filter/list/read + bulk-metadata
  // actions), but /inbox itself is unreachable in this environment.
  F02: BACKEND_NOT_INSTALLED_REASON,
  F03: BACKEND_NOT_INSTALLED_REASON,
  F04: BACKEND_NOT_INSTALLED_REASON,
  F05: BACKEND_NOT_INSTALLED_REASON,
  F06: BACKEND_NOT_INSTALLED_REASON,
  F07: BACKEND_NOT_INSTALLED_REASON,
  F08: BACKEND_NOT_INSTALLED_REASON,
  F09: BACKEND_NOT_INSTALLED_REASON,
  F10: BACKEND_NOT_INSTALLED_REASON,
  A01: BACKEND_NOT_INSTALLED_REASON,
  A02: BACKEND_NOT_INSTALLED_REASON,
  A03: BACKEND_NOT_INSTALLED_REASON,
  A05: BACKEND_NOT_INSTALLED_REASON,
  A06: BACKEND_NOT_INSTALLED_REASON,
  A07: BACKEND_NOT_INSTALLED_REASON,
  A10: BACKEND_NOT_INSTALLED_REASON,
  A11: BACKEND_NOT_INSTALLED_REASON,

  // UI-not-wired: blocked regardless of the backend gap.
  F11: UI_NOT_WIRED_REASON,
  F12: UI_NOT_WIRED_REASON,
  F13: UI_NOT_WIRED_REASON,
  F14: UI_NOT_WIRED_REASON,
  A04: `${UI_NOT_WIRED_REASON} — no faithful existing-capability match for "Follow up" among the wired outcomes; do not guess the mapping`,
  A08: `${UI_NOT_WIRED_REASON} — reuse-only wiring deferred to the mock-gated follow-up PR per the architect brief`,
  A09: UI_NOT_WIRED_REASON,
  A12: UI_NOT_WIRED_REASON,
  A13: UI_NOT_WIRED_REASON,
  R01: UI_NOT_WIRED_REASON,
  R02: UI_NOT_WIRED_REASON,
  R03: UI_NOT_WIRED_REASON,
  R04: UI_NOT_WIRED_REASON,
  R05: UI_NOT_WIRED_REASON,
  U01: UI_NOT_WIRED_REASON,
  U02: UI_NOT_WIRED_REASON,
  U03: UI_NOT_WIRED_REASON,
  U04: UI_NOT_WIRED_REASON,
  U05: `${UI_NOT_WIRED_REASON} — Treatment specifies new behavior (explicit snapshot-scoped bulk dismiss) not yet implemented`,
  U06: `${UI_NOT_WIRED_REASON} — Treatment specifies new behavior (explicit snapshot-scoped bulk restore) not yet implemented`,
  U07: UI_NOT_WIRED_REASON,
  U08: UI_NOT_WIRED_REASON,
};

export const O_ROW_IDS = ["O01", "O02", "O03", "O04", "O05", "O06", "O07", "O08", "O09", "O10"] as const;

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

function replaceRow(content: string, id: string, status: string, evidence: string): string {
  const rowRegex = new RegExp(`(\\|\\s*${id}\\s*\\|(?:[^|\\n]*\\|){3})[^|\\n]*\\|[^|\\n]*\\|`);
  if (!rowRegex.test(content)) {
    throw new Error(`writeMatrixRows: row ${id} not found in acceptance-matrix.md`);
  }
  const safeStatus = sanitizeForTableCell(status);
  const safeEvidence = sanitizeForTableCell(evidence);
  return content.replace(rowRegex, (_match, prefix: string) => `${prefix} ${safeStatus} | ${safeEvidence} |`);
}

/**
 * Rewrite Status + Evidence for every row this harness owns (all 50).
 *
 * Called ONCE at the start of every run (from global-setup, before any
 * test executes) — Astra round-2 finding #2: a prior run's stale "pass"
 * must never survive into a run where the same row later fails or is
 * skipped. Starting every run from a known, fully-reasoned baseline
 * (blocked rows get their static reason; O-rows reset to "Not run") and
 * only overwriting with a genuine outcome from THIS run's execution is
 * the only way to guarantee that.
 */
export function resetMatrixForRun(): void {
  let content = fs.readFileSync(MATRIX_PATH, "utf8");
  for (const [id, reason] of Object.entries(BLOCKED_ROW_REASONS)) {
    content = replaceRow(content, id, reason, "Not run");
  }
  for (const id of O_ROW_IDS) {
    content = replaceRow(content, id, "Not run", "Not run");
  }
  fs.writeFileSync(MATRIX_PATH, content, "utf8");
}

export type RowOutcome = { id: string; status: "pass" | "fail" | "skip"; evidence: string };

/**
 * Apply this run's real O-row outcomes on top of the "Not run" baseline
 * `resetMatrixForRun` wrote. Only ever touches O01-O10 — the 40 blocked
 * rows are never claimed by a spec in this PR, so they're never
 * overwritten here (they keep the reasoned baseline).
 */
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
  for (const id of O_ROW_IDS) {
    const recorded = byId.get(id);
    if (!recorded || recorded.length === 0) continue; // stays "Not run" from the reset baseline
    const failure = recorded.find((r) => r.status === "fail");
    const success = recorded.find((r) => r.status === "pass");
    if (failure) {
      content = replaceRow(content, id, `fail (${runAt})`, failure.evidence);
    } else if (success) {
      content = replaceRow(content, id, `pass (${runAt})`, success.evidence);
    } else {
      const skip = recorded[0];
      content = replaceRow(content, id, `blocked: ${skip.evidence}`, "Not run");
    }
  }
  fs.writeFileSync(MATRIX_PATH, content, "utf8");
}
