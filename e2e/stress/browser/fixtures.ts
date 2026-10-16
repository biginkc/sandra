import { test as base } from "@playwright/test";

import { assertLiveRecheck, assertRunBoundAppProof, type AppProof } from "../proof-guard";
import { loadRun, type Run } from "./support";

export { expect } from "@playwright/test";

/**
 * The ONLY `test` the chaos and parity specs may use. `proof` is an auto worker fixture (runs for every worker even if no test asks for it) and
 * verifies the engine's signed proof and the live app; `liveRecheck` is an auto per-test fixture that re-verifies the live app before every test, so an
 * app restarted mid-run, a replaced log or a new denial stops the next mutation. `run` (database, stub control) cannot be built without the proof.
 */
export const test = base.extend<{ liveRecheck: void }, { proof: AppProof; run: Run }>({
  proof: [async ({}, use) => { await use(assertRunBoundAppProof()); }, { scope: "worker", auto: true }],
  run: [async ({ proof }, use) => { const r = loadRun(proof); await use(r); await r.db.end(); }, { scope: "worker" }],
  liveRecheck: [async ({ proof }, use) => { assertLiveRecheck(proof); await use(); }, { auto: true }],
});
