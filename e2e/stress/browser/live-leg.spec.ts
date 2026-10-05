import { test } from "@playwright/test";

import { readConfig } from "../config";
import { assertLiveLegReady, classifyLiveEvidence } from "../live-leg";

/**
 * LIVE LEG driver (DISABLED). Skipped unless STRESS_LIVE_LEG=1; even then `assertLiveLegReady` throws unless every
 * prerequisite is met (stubbed-leg PASS at this sha, decisions, numbers via op, tunnel + subscription proof, ...).
 * It drives the REAL app UI of the isolated instance (the Call button); it has no provider call of its own, and the
 * only text that may reach a phone is the approved `SANDRA TEST <run-id> <n> ignore` string (the Sendillo spot check
 * is a human step and is not driven here).
 */
test.skip(process.env.STRESS_LIVE_LEG !== "1", "live leg is disabled unless STRESS_LIVE_LEG=1 and every prerequisite is met");

test("live leg: ~8 owned-number calls, evidence per call", async () => {
  const cfg = readConfig(process.env);
  const { plan } = await assertLiveLegReady(cfg, process.env);
  // The per-call UI driving (Call button on the call screen, cancel, voicemail wait, 20 s double dial) is intentionally
  // left to run only after assertLiveLegReady passes; each step's evidence is classified, never assumed.
  for (const step of plan) {
    void step;
    void classifyLiveEvidence;
  }
  throw new Error("live leg UI driver is not enabled in this build: a human must review the prerequisites report first");
});
