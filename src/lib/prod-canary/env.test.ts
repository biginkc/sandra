import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PROD_PROJECT_REF,
  TEST_PROJECT_REF,
  assertProdSupabaseUrl,
  loadProdCanaryEnvFiles,
} from "./env";

const touchedEnvKeys = [
  "PROD_CANARY_ENV_TEST_ONLY",
  "PROD_CANARY_ENV_TEST_SHARED",
];

afterEach(() => {
  for (const key of touchedEnvKeys) {
    delete process.env[key];
  }
});

describe("prod canary env guards", () => {
  it("accepts the Sandra production Supabase project URL", () => {
    expect(() =>
      assertProdSupabaseUrl(`https://${PROD_PROJECT_REF}.supabase.co`),
    ).not.toThrow();
  });

  it("rejects the shared test Supabase project with setup guidance", () => {
    expect(() =>
      assertProdSupabaseUrl(`https://${TEST_PROJECT_REF}.supabase.co`),
    ).toThrow(/\.env\.prod-canary\.local/);
  });

  it("rejects unknown Supabase projects", () => {
    expect(() =>
      assertProdSupabaseUrl("https://example.supabase.co"),
    ).toThrow(PROD_PROJECT_REF);
  });

  it("loads dedicated prod canary env before .env.local without overriding shell env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-canary-env-"));
    try {
      fs.writeFileSync(
        path.join(dir, ".env.prod-canary.local"),
        [
          "PROD_CANARY_ENV_TEST_ONLY=from-prod-canary",
          "PROD_CANARY_ENV_TEST_SHARED=from-prod-canary",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(dir, ".env.local"),
        [
          "PROD_CANARY_ENV_TEST_ONLY=from-local",
          "PROD_CANARY_ENV_TEST_SHARED=from-local",
        ].join("\n"),
      );

      process.env.PROD_CANARY_ENV_TEST_SHARED = "from-shell";
      loadProdCanaryEnvFiles(dir);

      expect(process.env.PROD_CANARY_ENV_TEST_ONLY).toBe("from-prod-canary");
      expect(process.env.PROD_CANARY_ENV_TEST_SHARED).toBe("from-shell");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores empty values so fallback files can provide the key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-canary-env-"));
    try {
      fs.writeFileSync(
        path.join(dir, ".env.prod-canary.local"),
        'PROD_CANARY_ENV_TEST_ONLY=""\n',
      );
      fs.writeFileSync(
        path.join(dir, ".env.local"),
        "PROD_CANARY_ENV_TEST_ONLY=from-local\n",
      );

      loadProdCanaryEnvFiles(dir);

      expect(process.env.PROD_CANARY_ENV_TEST_ONLY).toBe("from-local");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
