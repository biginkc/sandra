import sharedGlobalSetup from "../global-setup";
import { adminClient, DEFAULT_ORG_ID, deleteOrgScopedFixtureRows, countOrgScopedFixtureRows } from "../fixtures";
import { resetResultsFile, readMatrixResults } from "./results";
import { resetMatrixForRun, applyRunOutcomesToMatrix } from "./matrix";

/**
 * Wraps the shared e2e/global-setup.ts (the cross-run advisory lock) with
 * the acceptance harness's own start-of-run and end-of-run responsibilities:
 *
 *  - START (before any test runs): reset every row this harness owns to a
 *    fully-reasoned baseline — the 40 blocked rows get their static
 *    classification, the 10 O-rows reset to "Not run" — and clear the
 *    results log. This is what guarantees a stale "pass" from an earlier
 *    run can never survive into a run where the same row now fails or is
 *    skipped (Astra round-2 finding #2): every run starts from a known
 *    state and only a genuine outcome from THIS run overwrites it.
 *
 *  - END (after every test finishes, success or failure): write this
 *    run's real O-row outcomes into the matrix, then leave the shared
 *    fixture clean via the org-scoped cleanup and assert it.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const sharedTeardown = await sharedGlobalSetup();

  resetResultsFile();
  resetMatrixForRun();

  return async function teardown(): Promise<void> {
    const outcomes = readMatrixResults();
    applyRunOutcomesToMatrix(outcomes);

    const admin = adminClient();
    await deleteOrgScopedFixtureRows(admin, DEFAULT_ORG_ID);
    const remaining = await countOrgScopedFixtureRows(admin, DEFAULT_ORG_ID);
    if (remaining !== 0) {
      throw new Error(
        `inbox-acceptance teardown: org-scoped cleanup left ${remaining} row(s) for org ${DEFAULT_ORG_ID} — the shared fixture is NOT clean.`,
      );
    }

    await sharedTeardown();
  };
}
