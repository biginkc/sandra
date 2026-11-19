import { assertIsolatedSlackLocalEnv } from "./isolated-db-env";
import { assertLocalOnlyEnvironment } from "./local-only-guard";

// Runs before any test file loads: a bad env fails here, with no connection made.
export default function setup(): void {
  assertIsolatedSlackLocalEnv(process.env);
  assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: process.env.SLACK_LOCAL_API_URL, TEST_SUPABASE_DB_URL: process.env.SLACK_LOCAL_DB_URL });
}
