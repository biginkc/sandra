import { acquireSuiteLock } from "./suite-lock";

/**
 * Vitest globalSetup: hold the shared suite lock for the whole integration
 * run. See tests/integration/suite-lock.ts for the full story — the same
 * lock serializes the Playwright e2e suite (e2e/global-setup.ts) because
 * both truncate the same sandra-crm-test tenant tables.
 */
export default async function setup(): Promise<() => Promise<void>> {
  return acquireSuiteLock({ logPrefix: "[integration]" });
}
