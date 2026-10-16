import { assertIsolatedDbUrl } from "./isolated-db-env";

// DB-only variant: runs before any test file loads, no connection made.
export default function setup(): void {
  assertIsolatedDbUrl(process.env);
}
