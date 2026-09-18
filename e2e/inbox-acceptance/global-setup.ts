import sharedGlobalSetup from "../global-setup";
import { adminClient, DEFAULT_ORG_ID } from "../fixtures";
import { resetAcceptanceFixture } from "./cleanup";
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
      await resetAcceptanceFixture(admin, DEFAULT_ORG_ID);
      assertFullAcceptance(outcomes);
    } finally {
      await sharedTeardown();
    }
  };
}
