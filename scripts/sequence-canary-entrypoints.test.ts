import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");

function runScript(script: string) {
  return spawnSync(process.execPath, [tsxCli, script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      GITHUB_RUN_ID: "",
      CANARY_GITHUB_READ_TOKEN: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      PROD_SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
    },
  });
}

describe("new sequence canary script entrypoints", () => {
  it("runs the failure latch with tsx and rejects absent history credentials", () => {
    const result = runScript("scripts/check-sequence-canary-failure-latch.ts");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Canary history unavailable");
    expect(result.stderr).not.toMatch(/Top-level await|Transform failed|cjs output format/);
  });

  it("runs the smoke entrypoint with tsx and rejects absent database credentials", () => {
    const result = runScript("scripts/smoke-sequences-prod.ts");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Missing URL or service key");
    expect(result.stderr).not.toMatch(/Top-level await|Transform failed|cjs output format/);
  });
});
