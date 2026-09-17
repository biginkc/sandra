import fs from "node:fs";
import path from "node:path";

import { adminClient, DEFAULT_ORG_ID, deleteOrgScopedFixtureRows, countOrgScopedFixtureRows } from "../fixtures";
import { readMatrixResults } from "./results";

const MATRIX_PATH = path.resolve(
  __dirname,
  "../../docs/performance/inbox-redesign/acceptance-matrix.md",
);

/**
 * Runs once after every inbox-acceptance spec finishes (regardless of
 * pass/fail), in the same Node process as the test run.
 *
 * 1. Writes real Status + Evidence back into acceptance-matrix.md for
 *    every row that actually ran (from results.ts's JSON log) — this is
 *    the "a row only flips from Not run with linked evidence" contract.
 * 2. Leaves the shared fixture clean via the NEW org-scoped cleanup
 *    helper (not the broad resetTenantTables RPC), then asserts the
 *    fixture org has zero rows left so a corrupt cleanup fails loudly
 *    instead of silently leaving junk in the shared DB other proofs use.
 */
export default async function globalTeardown(): Promise<void> {
  const results = readMatrixResults();
  if (results.length > 0) {
    let content = fs.readFileSync(MATRIX_PATH, "utf8");
    const runAt = new Date().toISOString();
    for (const result of results) {
      const rowRegex = new RegExp(
        `(\\|\\s*${result.id}\\s*\\|(?:[^|\\n]*\\|){3})[^|\\n]*\\|[^|\\n]*\\|`,
      );
      content = content.replace(rowRegex, (_match, prefix: string) => {
        const status = result.status === "pass" ? "pass" : "FAIL";
        return `${prefix} ${status} (${runAt}) |  ${result.evidence} |`;
      });
    }
    fs.writeFileSync(MATRIX_PATH, content, "utf8");
  }

  const admin = adminClient();
  await deleteOrgScopedFixtureRows(admin, DEFAULT_ORG_ID);
  const remaining = await countOrgScopedFixtureRows(admin, DEFAULT_ORG_ID);
  if (remaining !== 0) {
    throw new Error(
      `inbox-acceptance global teardown: org-scoped cleanup left ${remaining} row(s) for org ${DEFAULT_ORG_ID} — the shared fixture is NOT clean.`,
    );
  }
}
