import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import localConfig from "../../../vitest.local-integration.config";
import remoteConfig from "../../../vitest.integration.config";
import filterLocalConfig from "../../../vitest.filter-local.config";
import slackLocalConfig from "../../../vitest.slack-local.config";

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

  // The migrations dir is not the only place destructive suites live: scan the
  // whole tree (src/** and tests/**) for loopback-guarded integration suites.
  const GUARD = /assertLocalOnlyEnvironment|assertLocalOnlyTestEnv|requireLoopbackPostgresUrl/;
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith(".integration.test.ts") && GUARD.test(readFileSync(full, "utf8"))) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
    return out;
  }
  const guardedSuites = [...walk(path.join(root, "src")), ...walk(path.join(root, "tests"))];

  it("finds the guarded suites outside supabase/migrations", () => {
    expect(guardedSuites).toContain("src/lib/prospects/search-filter-composition.integration.test.ts");
    expect(guardedSuites).toContain("src/lib/prospects/search-eval-budget.integration.test.ts");
    expect(guardedSuites).toContain("tests/search-oracle/oracle-comparison.integration.test.ts");
  });

  it("excludes every guarded src/** and tests/** integration suite from the hosted config", () => {
    const exclude = remoteConfig.test?.exclude ?? [];
    for (const suite of guardedSuites) expect(exclude, suite).toContain(suite);
  });

  it("every guarded suite is selected by exactly one local runner", () => {
    const included = new Set([...(localConfig.test?.include ?? []), ...(filterLocalConfig.test?.include ?? []), ...(slackLocalConfig.test?.include ?? [])]);
    for (const suite of guardedSuites) expect(included.has(suite), suite).toBe(true);
  });
});
