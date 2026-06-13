import fs from "node:fs";
import path from "node:path";

/**
 * Load `.env.test.local` from the repo root via a minimal parser so we
 * don't pull in `dotenv` just for this. Shared by
 * `vitest.integration.config.ts` (which injects vars into test workers)
 * and `tests/integration/global-setup.ts` (which runs in the vitest main
 * process, where `test.env` from the config is not applied).
 */
export function loadTestEnv(): Record<string, string> {
  const filepath = path.resolve(__dirname, "../..", ".env.test.local");
  if (!fs.existsSync(filepath)) return {};
  const raw = fs.readFileSync(filepath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}
