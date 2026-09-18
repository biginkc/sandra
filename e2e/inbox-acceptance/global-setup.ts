import sharedGlobalSetup from "../global-setup";
import {
  adminClient,
  DEFAULT_ORG_ID,
  ensureAcceptanceOrganization,
} from "../fixtures";
import {
  MOCK_SENDER_PRIMARY,
  MOCK_SENDER_SECONDARY,
  MOCK_PROVIDER_CAMPAIGN_ID,
  seedProviderCampaignCatalog,
  seedSenderCatalog,
} from "../../tests/integration/delivery";
import { deleteAcceptanceOrganization, resetAcceptanceFixture } from "./cleanup";
import { markCleanupComplete, resetResultsFile, readMatrixResults } from "./results";
import { resetMatrixForRun, applyRunOutcomesToMatrix, assertFullAcceptance } from "./matrix";

/** Reset every required row, retain actual run results, clean the owned
 * fixture, and release its lock even when verification/cleanup fails. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const sharedTeardown = await sharedGlobalSetup();

  // Create the per-run disposable organization after the database lock is
  // held.  This keeps the acceptance tenant outside the pre-run baseline and
  // prevents cleanup from touching the historical shared tenant.
  const admin = adminClient();
  await ensureAcceptanceOrganization(admin);
  // The per-run organization is created after the shared fixture reset, so
  // it has no delivery catalog yet. Seed the same mock inventory that the
  // release path validates before any queued-message acceptance row runs.
  await seedSenderCatalog(admin, DEFAULT_ORG_ID, [
    MOCK_SENDER_PRIMARY,
    MOCK_SENDER_SECONDARY,
  ]);
  await seedProviderCampaignCatalog(admin, DEFAULT_ORG_ID, [
    MOCK_PROVIDER_CAMPAIGN_ID,
  ]);

  resetResultsFile();
  resetMatrixForRun();

  return async function teardown(): Promise<void> {
    let cleanupSucceeded = false;
    try {
      const admin = adminClient();
      await resetAcceptanceFixture(admin, DEFAULT_ORG_ID);
      await deleteAcceptanceOrganization();
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
