import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import localConfig from "../../../vitest.local-integration.config";
import { assertIsolatedDbEnv, assertIsolatedDbUrl } from "./isolated-db-env";

const API = "http://127.0.0.1:54961";
const DB = "postgresql://postgres:postgres@127.0.0.1:54962/postgres";
const KEY = "service-role-key-for-my-own-stack";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    LOCAL_SUPABASE_URL: API,
    LOCAL_SUPABASE_SERVICE_ROLE_KEY: KEY,
    TEST_SUPABASE_URL: API,
    TEST_SUPABASE_SERVICE_ROLE_KEY: KEY,
    TEST_SUPABASE_DB_URL: DB,
    ...overrides,
  };
}

const CI = { CI: "1", GITHUB_ACTIONS: "true", E2E_DISPOSABLE_DATABASE: "1" };
const ciPorts = {
  LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
  TEST_SUPABASE_URL: "http://127.0.0.1:54321",
  TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
};

describe("assertIsolatedDbEnv", () => {
  it("throws when config is omitted", () => {
    expect(() => assertIsolatedDbEnv({})).toThrow(/must be set explicitly/);
    for (const key of Object.keys(env())) {
      expect(() => assertIsolatedDbEnv(env({ [key]: undefined })), key).toThrow(/must be set explicitly/);
      expect(() => assertIsolatedDbEnv(env({ [key]: "  " })), key).toThrow(/must be set explicitly/);
    }
  });

  it.each(["54331", "54321"])("refuses shared API port %s", (port) => {
    const url = `http://127.0.0.1:${port}`;
    expect(() => assertIsolatedDbEnv(env({ LOCAL_SUPABASE_URL: url, TEST_SUPABASE_URL: url }))).toThrow(/shared dev-stack port/);
  });

  it.each(["54329", "54322"])("refuses shared DB port %s", (port) => {
    expect(() =>
      assertIsolatedDbEnv(env({ TEST_SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres` })),
    ).toThrow(/shared dev-stack port/);
  });

  it("refuses CI ports without the full disposable marker", () => {
    expect(() => assertIsolatedDbEnv(env(ciPorts))).toThrow(/shared dev-stack port/);
    expect(() => assertIsolatedDbEnv({ ...env(ciPorts), CI: "1" })).toThrow(/shared dev-stack port/);
    expect(() => assertIsolatedDbEnv({ ...env(ciPorts), CI: "1", GITHUB_ACTIONS: "true" })).toThrow(/shared dev-stack port/);
    expect(() => assertIsolatedDbEnv({ ...env(ciPorts), E2E_DISPOSABLE_DATABASE: "1" })).toThrow(/shared dev-stack port/);
  });

  it("never allows 54329/54331 even with the CI marker", () => {
    const url = "http://127.0.0.1:54331";
    expect(() => assertIsolatedDbEnv({ ...env({ LOCAL_SUPABASE_URL: url, TEST_SUPABASE_URL: url }), ...CI })).toThrow();
    expect(() =>
      assertIsolatedDbEnv({ ...env({ TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54329/postgres" }), ...CI }),
    ).toThrow();
  });

  it("refuses hosted Supabase and non-loopback hosts", () => {
    const hosted = "https://abc.supabase.co";
    expect(() => assertIsolatedDbEnv(env({ LOCAL_SUPABASE_URL: hosted, TEST_SUPABASE_URL: hosted }))).toThrow(/hosted/);
    expect(() =>
      assertIsolatedDbEnv(env({ TEST_SUPABASE_DB_URL: "postgresql://postgres:x@db.abc.supabase.co:5432/postgres" })),
    ).toThrow(/hosted/);
    expect(() =>
      assertIsolatedDbEnv(env({ TEST_SUPABASE_DB_URL: "postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres" })),
    ).toThrow(/hosted/);
    expect(() => assertIsolatedDbEnv(env({ LOCAL_SUPABASE_URL: "http://db.example.com:54961", TEST_SUPABASE_URL: "http://db.example.com:54961" }))).toThrow(/loopback/);
    expect(() => assertIsolatedDbEnv(env({ TEST_SUPABASE_DB_URL: `${DB}?host=db.example.com` }))).toThrow(/query/);
  });

  it("refuses mismatched TEST/LOCAL values", () => {
    expect(() => assertIsolatedDbEnv(env({ TEST_SUPABASE_URL: "http://127.0.0.1:54971" }))).toThrow(/same stack/);
    expect(() => assertIsolatedDbEnv(env({ TEST_SUPABASE_SERVICE_ROLE_KEY: "other" }))).toThrow(/differ/);
  });

  it("passes for a valid isolated stack", () => {
    expect(() => assertIsolatedDbEnv(env())).not.toThrow();
  });

  it("passes for CI disposable ports with the full marker", () => {
    expect(() => assertIsolatedDbEnv({ ...env(ciPorts), ...CI })).not.toThrow();
    expect(() => assertIsolatedDbEnv({ ...env(ciPorts), ...CI, CI: "true" })).not.toThrow();
  });
});

describe("assertIsolatedDbUrl", () => {
  it("requires an explicit, isolated DB URL", () => {
    expect(() => assertIsolatedDbUrl({})).toThrow(/must be set explicitly/);
    expect(() => assertIsolatedDbUrl({ TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54329/postgres" })).toThrow();
    expect(() => assertIsolatedDbUrl({ TEST_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55422/postgres" })).not.toThrow();
  });
});

describe("vitest.local-integration.config.ts", () => {
  it("runs the isolation guard as globalSetup and has no silent stack defaults", () => {
    expect(localConfig.test?.globalSetup).toContain("./src/lib/testing/isolated-db-env.global-setup.ts");
    const source = readFileSync(path.resolve(__dirname, "../../../vitest.local-integration.config.ts"), "utf8");
    expect(source).not.toMatch(/5433[01]|54329|eyJ/);
  });
});
