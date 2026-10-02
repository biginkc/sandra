import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import localConfig from "../../../vitest.local-integration.config";
import remoteConfig from "../../../vitest.integration.config";

const root = path.resolve(__dirname, "../../..");
const migrationsDir = path.join(root, "supabase/migrations");

/**
 * Scratch-database migration suites replay DDL and seed fixtures against a
 * loopback database (`requireLoopbackPostgresUrl`). The generic hosted runner
 * (`npm run test:integration`, vitest.integration.config.ts) globs every
 * migration integration test, so each loopback-only suite must be excluded
 * there and selected only by the local runner.
 */
const loopbackOnlySuites = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".integration.test.ts"))
  .filter((name) => readFileSync(path.join(migrationsDir, name), "utf8").includes("requireLoopbackPostgresUrl") || readFileSync(path.join(migrationsDir, name), "utf8").includes("assertLocalOnlyTestEnv"))
  .map((name) => `supabase/migrations/${name}`);

describe("integration runner configuration boundary", () => {
  it("finds the loopback-only migration suites", () => {
    expect(loopbackOnlySuites).toContain("supabase/migrations/20260929120000_dialpad_cti_call_projection.integration.test.ts");
    expect(loopbackOnlySuites.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes every loopback-only suite from the remote/hosted integration config", () => {
    const exclude = remoteConfig.test?.exclude ?? [];
    for (const suite of loopbackOnlySuites) expect(exclude, suite).toContain(suite);
  });

  it("selects every loopback-only suite in the local config, and nothing the remote config does not exclude", () => {
    const include = localConfig.test?.include ?? [];
    const exclude = remoteConfig.test?.exclude ?? [];
    for (const suite of loopbackOnlySuites) expect(include, suite).toContain(suite);
    for (const suite of include) expect(exclude, suite).toContain(suite);
  });

  it("keeps the remote config's generic migration glob (the boundary is the exclude list, not a narrower include)", () => {
    expect(remoteConfig.test?.include).toContain("supabase/migrations/**/*.integration.test.ts");
  });
});
