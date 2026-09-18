import sharedGlobalSetup from "../global-setup";
import { adminClient, DEFAULT_ORG_ID, deleteOrgScopedFixtureRows, countOrgScopedFixtureRows } from "../fixtures";
import { resetResultsFile, readMatrixResults } from "./results";
import { resetMatrixForRun, applyRunOutcomesToMatrix, assertFullAcceptance } from "./matrix";

/** Reset every required row, retain actual run results, clean the owned
 * fixture, and release its lock even when verification/cleanup fails. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const sharedTeardown = await sharedGlobalSetup();

  resetResultsFile();
  resetMatrixForRun();

  return async function teardown(): Promise<void> {
    try {
      const outcomes = readMatrixResults();
      applyRunOutcomesToMatrix(outcomes);
      const admin = adminClient();
      await deleteOrgScopedFixtureRows(admin, DEFAULT_ORG_ID);
      const remaining = await countOrgScopedFixtureRows(admin, DEFAULT_ORG_ID);
      if (remaining !== 0) throw new Error(`Inbox acceptance cleanup left ${remaining} fixture rows`);
      assertFullAcceptance(outcomes);
    } finally {
      await sharedTeardown();
    }
  };
}
