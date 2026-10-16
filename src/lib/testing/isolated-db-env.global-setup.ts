import { assertIsolatedDbEnv } from "./isolated-db-env";

// Runs before any test file loads: a bad env fails here, with no connection made.
export default function setup(): void {
  assertIsolatedDbEnv(process.env);
}
