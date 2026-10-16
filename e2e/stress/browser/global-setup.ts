import { assertRunBoundAppProof } from "../proof-guard";

/**
 * Config-level guard for `playwright.stress.config.ts`: runs for ANY spec selection (a `--no-deps` or `--grep` cannot skip it, unlike a setup
 * project). Refuses unless the engine wrote a signed, fresh proof for this run and the proven app is still the one listening. The live-leg spec is the
 * one exemption (its app intentionally reaches real providers and is gated by `assertLiveLegReady`); the chaos and parity specs ALSO verify in their
 * own fixtures, so setting STRESS_LIVE_LEG=1 does not unlock them.
 */
export default async function globalSetup(): Promise<void> {
  if (process.env.STRESS_LIVE_LEG === "1") return;
  assertRunBoundAppProof();
}
