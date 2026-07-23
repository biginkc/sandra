import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PROD_BASE_URL = "https://sandra.bmhgroupkc.com";
export const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
export const TEST_PROJECT_REF = "ncsngxlcyxylaeskiteu";
export const PROD_CANARY_ENV_FILES = [
  ".env.prod-canary.local",
  ".env.local",
] as const;

export function loadProdCanaryEnvFiles(rootDir = process.cwd()): void {
  for (const filename of PROD_CANARY_ENV_FILES) {
    const filepath = path.resolve(rootDir, filename);
    if (!fs.existsSync(filepath)) continue;

    for (const line of fs.readFileSync(filepath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value === "") continue;
      if (!process.env[key]) process.env[key] = value;
    }
  }
}

export function assertProdSupabaseUrl(url: string): void {
  if (url.includes(TEST_PROJECT_REF)) {
    throw new Error(
      [
        `Refusing to run production canaries against the test project (${TEST_PROJECT_REF}).`,
        "Use production Supabase values, preferably in .env.prod-canary.local.",
      ].join(" "),
    );
  }

  if (!url.includes(PROD_PROJECT_REF)) {
    throw new Error(
      `Supabase URL ${url} does not match the Sandra production ref (${PROD_PROJECT_REF}).`,
    );
  }
}
