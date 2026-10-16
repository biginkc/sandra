import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import localConfig from "../../../vitest.local-integration.config";
import {
  assertIsolatedDbEnv,
  assertIsolatedDbUrl,
  assertIsolatedNormaStressEnv,
  assertIsolatedSlackLocalEnv,
} from "./isolated-db-env";

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

describe("assertIsolatedNormaStressEnv", () => {
  const ok = "postgresql://postgres:postgres@127.0.0.1:55422/postgres";
  const shared = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
  it("requires a source and checks every one that is set", () => {
    expect(() => assertIsolatedNormaStressEnv({})).toThrow(/must be set explicitly/);
    expect(() => assertIsolatedNormaStressEnv({ NORMA_STRESS_SOURCE_DB_URL: shared })).toThrow(/shared dev-stack port/);
    expect(() => assertIsolatedNormaStressEnv({ NORMA_STRESS_SOURCE_DB_URL: ok, TEST_SUPABASE_DB_URL: shared })).toThrow();
    expect(() => assertIsolatedNormaStressEnv({ NORMA_STRESS_SOURCE_DB_URL: "postgresql://u:p@db.abc.supabase.co:5432/postgres" })).toThrow(/hosted/);
    expect(() => assertIsolatedNormaStressEnv({ NORMA_STRESS_SOURCE_DB_URL: ok })).not.toThrow();
    expect(() => assertIsolatedNormaStressEnv({ TEST_SUPABASE_DB_URL: ok })).not.toThrow();
  });
});

describe("assertIsolatedSlackLocalEnv", () => {
  const good = { SLACK_LOCAL_API_URL: API, SLACK_LOCAL_SERVICE_KEY: KEY, SLACK_LOCAL_DB_URL: DB };
  it("requires explicit, isolated SLACK_LOCAL_* values", () => {
    expect(() => assertIsolatedSlackLocalEnv({})).toThrow(/must be set explicitly/);
    expect(() => assertIsolatedSlackLocalEnv({ ...good, SLACK_LOCAL_API_URL: "http://127.0.0.1:54331" })).toThrow(/shared dev-stack port/);
    expect(() => assertIsolatedSlackLocalEnv({ ...good, SLACK_LOCAL_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54329/postgres" })).toThrow(/shared dev-stack port/);
    expect(() => assertIsolatedSlackLocalEnv(good)).not.toThrow();
  });
});

// Source scan: no vitest config, and no DB helper fixed in this change, may fall
// back to a shared dev-stack port. Configs that used to default to the shared
// stack may not default to the demo keys either.
const root = path.resolve(__dirname, "../../..");
const vitestConfigs = readdirSync(root).filter((f) => /^vitest\..*\.ts$/.test(f));
const helpers = ["src/lib/norma/stress/db.ts", "tests/integration/norma-next-step-support.ts"];
const SHARED_PORT_DEFAULT = /\?\?\s*["'`][^"'`]*:(54321|54322|54329|54331)\b/;
const DEMO_KEY_DEFAULT = /\?\?\s*["'`]eyJ/;
const formerSharedStackConfigs = [
  "vitest.local-integration.config.ts",
  "vitest.slack-local.config.ts",
  "vitest.norma-queue.config.ts",
  "vitest.norma-stress.config.ts",
  "vitest.norma-inbound.config.ts",
  "vitest.norma-recordings.config.ts",
];

describe("no silent shared-stack defaults", () => {
  it("finds the vitest configs", () => {
    expect(vitestConfigs.length).toBeGreaterThan(10);
  });
  it.each([...vitestConfigs, ...helpers])("%s has no shared-port default", (file) => {
    expect(readFileSync(path.join(root, file), "utf8")).not.toMatch(SHARED_PORT_DEFAULT);
  });
  it.each(formerSharedStackConfigs)("%s has no demo-key default and runs a guard globalSetup", (file) => {
    const source = readFileSync(path.join(root, file), "utf8");
    expect(source).not.toMatch(DEMO_KEY_DEFAULT);
    expect(source).toMatch(/globalSetup: \[".\/src\/lib\/testing\/isolated-[a-z-]+\.global-setup\.ts"\]/);
  });
});

describe("vitest.local-integration.config.ts", () => {
  it("runs the isolation guard as globalSetup and has no silent stack defaults", () => {
    expect(localConfig.test?.globalSetup).toContain("./src/lib/testing/isolated-db-env.global-setup.ts");
    const source = readFileSync(path.resolve(__dirname, "../../../vitest.local-integration.config.ts"), "utf8");
    expect(source).not.toMatch(/5433[01]|54329|eyJ/);
  });
});
