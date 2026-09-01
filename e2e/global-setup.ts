import { acquireSuiteLock } from "../tests/integration/suite-lock";

/**
 * Playwright globalSetup: hold the shared suite lock for the whole e2e run.
 *
 * The e2e specs call resetTenantTables() (→ reset_tenant_tables()) against
 * the same sandra-crm-test project the vitest integration suite truncates.
 * Without this lock, an e2e run wipes tables mid-integration-run (and vice
 * versa), producing dozens of random failures. See
 * tests/integration/suite-lock.ts.
 *
 * Playwright treats the returned function as the global teardown, which
 * releases the lock after the last spec.
 *
 * In CI the TEST_SUPABASE_DB_URL secret may not be configured; the e2e
 * workflow already serializes CI runs against each other via a GitHub
 * concurrency group, so warn-and-skip there instead of failing the run.
 * Locally the URL is required — an unlocked local run is exactly the race
 * this prevents.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  return acquireSuiteLock({
    logPrefix: "[e2e]",
    onMissingDbUrl: process.env.CI ? "warn-and-skip" : "throw",
  });
}
