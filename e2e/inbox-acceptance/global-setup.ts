import sharedGlobalSetup from "../global-setup";
import { adminClient, DEFAULT_ORG_ID } from "../fixtures";
import { resetAcceptanceFixture } from "./cleanup";
import { markCleanupComplete, resetResultsFile, readMatrixResults } from "./results";
import { resetMatrixForRun, applyRunOutcomesToMatrix, assertFullAcceptance } from "./matrix";

/** Reset every required row, retain actual run results, clean the owned
 * fixture, and release its lock even when verification/cleanup fails. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const sharedTeardown = await sharedGlobalSetup();

  resetResultsFile();
  resetMatrixForRun();

  return async function teardown(): Promise<void> {
    let cleanupSucceeded = false;
    try {
      const admin = adminClient();
      await resetAcceptanceFixture(admin, DEFAULT_ORG_ID);
      cleanupSucceeded = true;
    } finally {
      // Never publish a green matrix before the owned fixture is proven clean.
      // If cleanup fails, the result envelope remains cleanup_ok=false and the
      // release gate rejects the otherwise-complete row outcomes.
      if (cleanupSucceeded) {
        markCleanupComplete();
        applyRunOutcomesToMatrix(readMatrixResults());
      }
      await sharedTeardown();
    }
    assertFullAcceptance(readMatrixResults());
  };
}
