import { requireLoopbackPostgresUrl } from "./loopback-postgres-url";

const loopbackApiHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Destructive integration setup (tenant resets, user deletes, migration
 * replay) must only ever run against a disposable local stack. Throws unless
 * BOTH the database URL and the API URL are loopback, so a swapped env var
 * cannot point the reset at the shared hosted test project.
 */
export function assertLocalOnlyTestEnv(dbUrl: string | undefined, apiUrl: string | undefined): void {
  if (!dbUrl || !apiUrl) throw new Error("Local-only test guard: DB URL and API URL are required.");
  requireLoopbackPostgresUrl(dbUrl);
  let api: URL;
  try { api = new URL(apiUrl); } catch { throw new Error("Local-only test guard: API URL is not a valid URL."); }
  if (api.username || api.password) {
    throw new Error("Local-only test guard: API URL must not carry credentials.");
  }
  if (!["http:", "https:"].includes(api.protocol) || !loopbackApiHosts.has(api.hostname)) {
    throw new Error("Local-only test guard: API URL must be loopback.");
  }
}
