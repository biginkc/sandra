import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { integrationEnv, resolveDbUrl } from "./guards";

// The two vitest integration lanes run under vitest.local-integration.config.ts, which injects a TEST_SUPABASE_DB_URL
// default pointing at the shared local stack. Both lanes build their environment with integrationEnv(process.env), which
// resolves MYLEADS_STRESS_DB_URL only and removes TEST_SUPABASE_DB_URL, so nothing they call can fall back to it.
const SHARED = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const OWN = "postgresql://postgres:postgres@127.0.0.1:55722/postgres";

describe("integrationEnv (runtime)", () => {
  it("refuses when only the config-injected TEST_SUPABASE_DB_URL is present", () => {
    expect(() => integrationEnv({ TEST_SUPABASE_DB_URL: SHARED })).toThrow(/DB_URL_UNSET/);
  });
  it("removes TEST_SUPABASE_DB_URL so a downstream resolveDbUrl can only see the explicit URL", () => {
    const env = integrationEnv({ MYLEADS_STRESS_DB_URL: OWN, TEST_SUPABASE_DB_URL: SHARED });
    expect(env.TEST_SUPABASE_DB_URL).toBeUndefined();
    expect(resolveDbUrl(env)).toBe(OWN);
    expect(() => resolveDbUrl({ ...env, MYLEADS_STRESS_DB_URL: undefined })).toThrow(/DB_URL_UNSET/);
  });
});

// Static: each lane builds its env with integrationEnv(process.env) and never touches the fallback resolver or the
// config-injected variable, by any name. Only whole-line and block comments are stripped, so code after a URL string survives.
const dir = path.resolve(__dirname);
const code = (file: string) =>
  readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe.each([
  { file: "smoke.integration.test.ts", needsApi: false },
  { file: "race.dispatch.integration.test.ts", needsApi: true },
])("$file uses only the integration guard", ({ file, needsApi }) => {
  const src = code(file);
  it("binds its env from integrationEnv(process.env)", () => {
    expect(src).toMatch(/const env = integrationEnv\(process\.env\);/);
  });
  it("never mentions resolveDbUrl or TEST_SUPABASE_DB_URL", () => {
    expect(src).not.toMatch(/\bresolveDbUrl\b/);
    expect(src).not.toMatch(/TEST_SUPABASE_DB_URL/);
  });
  it("never hands the raw process.env onward (only to integrationEnv / resolveIntegrationApiUrl)", () => {
    expect(src).not.toMatch(/\.\.\.\s*process\.env\b/);
    const whole = [...src.matchAll(/(\w+)\(\s*process\.env\s*[,)]/g)].map((m) => m[1]);
    for (const callee of whole) expect(["integrationEnv", "resolveIntegrationApiUrl"]).toContain(callee);
    expect(src).not.toMatch(/,\s*process\.env\s*\)/);
  });
  it("takes its database url only from the guarded env", () => {
    expect(src).toMatch(/const url = env\.MYLEADS_STRESS_DB_URL;/);
    expect([...src.matchAll(/\bconst url\s*=/g)].length).toBe(1);
  });
  it("opens connections only with the guarded url", () => {
    for (const m of src.matchAll(/connectionString:\s*([^,}\s]+)/g)) expect(m[1]).toBe("url");
  });
  it.runIf(needsApi)("takes its API URL only through resolveIntegrationApiUrl", () => {
    expect(src).toMatch(/const API = resolveIntegrationApiUrl\(process\.env\);/);
    expect(src).not.toMatch(/54331/);
  });
});
