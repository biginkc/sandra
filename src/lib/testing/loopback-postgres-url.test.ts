import { describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "./loopback-postgres-url";

describe("requireLoopbackPostgresUrl", () => {
  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
    "postgresql://postgres:postgres@localhost:54329/postgres",
    "postgresql://postgres:postgres@[::1]:54329/postgres",
  ])("accepts an exact loopback PostgreSQL URL", (connectionString) => {
    expect(requireLoopbackPostgresUrl(connectionString)).toBe(connectionString);
  });

  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54329/postgres?host=example.com",
    "postgresql://postgres:postgres@127.0.0.1:54329/postgres?service=unexpected",
    "socket:/var/run/postgresql?db=postgres",
    "postgresql://postgres:postgres@example.com:54329/postgres",
  ])("rejects a connection string with an alternate target", (connectionString) => {
    expect(() => requireLoopbackPostgresUrl(connectionString)).toThrow(
      "Local migration integration tests require a loopback Supabase database.",
    );
  });
});
