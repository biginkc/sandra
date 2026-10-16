import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// The two vitest integration lanes run under vitest.local-integration.config.ts, which injects a TEST_SUPABASE_DB_URL
// default pointing at the shared local stack. They must select their database only through resolveIntegrationDbUrl
// (MYLEADS_STRESS_DB_URL, no fallback) and the dispatch lanes their API only through resolveIntegrationApiUrl.
// This test fails if either entry point goes back to resolveDbUrl or reads TEST_SUPABASE_DB_URL itself.
const dir = path.resolve(__dirname);
const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe.each([
  { file: "smoke.integration.test.ts", needsApi: false },
  { file: "race.dispatch.integration.test.ts", needsApi: true },
])("$file selects its database only through the integration guard", ({ file, needsApi }) => {
  const src = code(read(file));
  it("calls resolveIntegrationDbUrl", () => {
    expect(src).toMatch(/\bresolveIntegrationDbUrl\s*\(/);
  });
  it("never calls the fallback resolver or reads TEST_SUPABASE_DB_URL", () => {
    expect(src).not.toMatch(/\bresolveDbUrl\s*\(/);
    expect(src).not.toMatch(/TEST_SUPABASE_DB_URL/);
  });
  it.runIf(needsApi)("takes its API URL only through resolveIntegrationApiUrl", () => {
    expect(src).toMatch(/\bresolveIntegrationApiUrl\s*\(/);
    expect(src).not.toMatch(/54331/);
  });
});
