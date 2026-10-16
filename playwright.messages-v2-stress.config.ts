import { defineConfig } from "@playwright/test";

import { assertStressDbEnv } from "./scripts/messages-v2/stress/core";

/**
 * Messages v2 Stage 5, Run 4 (UI load), D LANE. Opt-in only: never part of the default Playwright lanes.
 * No .env file is read and no web server is started: the operator starts the app (`next build --webpack` +
 * `next start`) against the SAME disposable stack, and points MV2_STRESS_APP_URL (loopback) at it.
 * The stack bindings are checked by assertStressDbEnv before anything runs (never the dev-stack ports).
 */
assertStressDbEnv(process.env);
const appUrl = process.env.MV2_STRESS_APP_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(appUrl)) throw new Error("MV2_STRESS_APP_URL must be a loopback origin, e.g. http://127.0.0.1:3497");

export default defineConfig({
  testDir: "./scripts/messages-v2/stress",
  testMatch: "ui-load.stress.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 3 * 60 * 60 * 1000,
  // No traces: a trace of a 5,000-card DOM is huge and stalls the reporter. Screenshots on failure only.
  reporter: [["list"]],
  outputDir: "test-results/messages-v2-stress/ui-load-artifacts",
  use: { baseURL: appUrl, trace: "off", screenshot: "only-on-failure", viewport: { width: 1440, height: 1000 } },
});
