/** The P0 fixture writer is restricted to one exclusively owned loopback stack.
 * Exact strings intentionally exclude URL query overrides understood by node-postgres.
 * No network, file, environment, or database access occurs in this guard.
 */
export function validateInboxBaselineTarget(apiUrl, databaseUrl) {
  const validApi = apiUrl === "http://127.0.0.1:58421"
    || apiUrl === "http://127.0.0.1:58421/";
  const validDatabase = databaseUrl === "postgresql://postgres:postgres@127.0.0.1:58422/postgres"
    || databaseUrl === "postgres://postgres:postgres@127.0.0.1:58422/postgres";
  if (!validApi || !validDatabase) {
    // Never expose runtime URLs or credentials in rejection output.
    throw new Error("Dedicated loopback target guard failed");
  }
  return {
    apiOrigin: "http://127.0.0.1:58421",
    // Do not hand the original connection string to a second URL parser.
    databaseConfig: {
      host: "127.0.0.1",
      port: 58422,
      database: "postgres",
      user: "postgres",
      password: "postgres",
      ssl: false,
    },
  };
}
