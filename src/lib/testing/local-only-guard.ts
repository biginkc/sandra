import { requireLoopbackPostgresUrl } from "./loopback-postgres-url";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Destructive integration/volume suites (anything that resets, truncates,
 * deletes or cleans storage) MUST call this before touching the database.
 * It throws unless BOTH the Supabase API URL and the Postgres URL are
 * loopback, so a swapped env var can never point a reset at the shared
 * hosted test project.
 */
export function assertLocalOnlyEnvironment(
  env: Record<string, string | undefined> = process.env,
): void {
  const api = env.TEST_SUPABASE_URL;
  const db = env.TEST_SUPABASE_DB_URL;
  if (!api || !db) {
    throw new Error("Refusing to run: TEST_SUPABASE_URL and TEST_SUPABASE_DB_URL must both be set to loopback URLs.");
  }
  let apiUrl: URL;
  try {
    apiUrl = new URL(api);
  } catch {
    throw new Error("Refusing to run: TEST_SUPABASE_URL is not a valid URL.");
  }
  if (
    !["http:", "https:"].includes(apiUrl.protocol) ||
    !LOOPBACK_HOSTS.has(apiUrl.hostname) ||
    apiUrl.username ||
    apiUrl.password
  ) {
    throw new Error("Refusing to run: TEST_SUPABASE_URL is not a loopback URL.");
  }
  try {
    requireLoopbackPostgresUrl(db);
  } catch {
    throw new Error("Refusing to run: TEST_SUPABASE_DB_URL is not a loopback Postgres URL.");
  }
}
