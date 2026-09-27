const loopbackPostgresHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

const localPostgresUrlError = "Local migration integration tests require a loopback Supabase database.";

/**
 * Reject connection strings that node-postgres can reinterpret with query
 * parameters. In particular, `?host=` overrides the WHATWG URL hostname and
 * could direct a supposedly local integration test to a remote database.
 */
export function requireLoopbackPostgresUrl(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(localPostgresUrlError);
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !loopbackPostgresHosts.has(url.hostname)
    || url.search
    || url.hash
  ) {
    throw new Error(localPostgresUrlError);
  }

  return connectionString;
}
