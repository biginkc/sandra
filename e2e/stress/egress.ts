import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { LaneRefusal } from "./guards";

/**
 * Egress denial, fail closed. Two rings:
 *  1. In-process guard (egress-guard.cjs), preloaded via NODE_OPTIONS into every process of the run.
 *  2. OS firewall (egress-pf.conf), proven by a probe when STRESS_REQUIRE_OS_EGRESS=1.
 * `proveEgressDenied` is a T0 precondition: it must SEE a denial, otherwise the run is refused.
 */

export const GUARD_PATH = path.resolve(__dirname, "egress-guard.cjs");

export function egressNodeOptions(existing = process.env.NODE_OPTIONS ?? ""): string {
  const req = `--require "${GUARD_PATH}"`;
  return existing.includes(GUARD_PATH) ? existing : `${existing} ${req}`.trim();
}

/** The env a child process (Next server, Playwright, replay) must be started with. */
export function egressChildEnv(logFile: string): Record<string, string> {
  return { NODE_OPTIONS: egressNodeOptions(), STRESS_EGRESS_LOG: logFile };
}

/** Child that tries to reach a non-loopback address under the guard. Exit 0 = the guard denied it (good). */
export function proveInProcessDenial(logFile: string): void {
  const probe = `try { require("node:net").connect({ host: "192.0.2.1", port: 80 }).on("error", () => {}); process.exit(3); } catch (e) { process.exit(e && e.code === "EGRESS_DENIED" ? 0 : 4); }`;
  const r = spawnSync(process.execPath, ["-e", probe], {
    env: { ...process.env, ...egressChildEnv(logFile), STRESS_EGRESS_PROBE: "1" },
    timeout: 10_000,
  });
  if (r.status !== 0) throw new LaneRefusal("EGRESS_GUARD_INEFFECTIVE", `the in-process egress guard did not deny a non-loopback connect (exit ${r.status}); refusing to run.`);
}

export type OsProbeOutcome = "connected" | "timeout" | `error:${string}`;

/**
 * A silent timeout is what `block drop` looks like; an immediate "unreachable" is an offline machine, which cannot
 * tell blocked from not-blocked. Only a timeout proves the ring (and a connect proves it is open).
 */
export function classifyOsProbe(outcome: OsProbeOutcome): "denied" | "open" | "inconclusive" {
  if (outcome === "connected") return "open";
  if (outcome === "timeout") return "denied";
  return "inconclusive";
}

/**
 * OS ring probe, run in a child WITHOUT the in-process guard (the guard would throw first and the pf ring would
 * never be exercised). It dials a routable public address (a TCP SYN to Cloudflare's resolver, never a provider):
 * TEST-NET addresses are blackholed with or without pf, so they prove nothing.
 */
export function proveOsDenial(): void {
  const code = `const s=require("node:net").connect({host:"1.1.1.1",port:443});s.setTimeout(3000,()=>{console.log("timeout");process.exit(0)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",(e)=>{console.log("error:"+(e&&e.code||"unknown"));process.exit(0)});`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["-e", code], { env, timeout: 10_000, encoding: "utf8" });
  const outcome = (r.stdout ?? "").trim() as OsProbeOutcome;
  const verdict = classifyOsProbe(outcome || "error:no_output");
  if (verdict === "open") throw new LaneRefusal("OS_EGRESS_OPEN", "a non-loopback connection succeeded; run `sudo e2e/stress/egress-pf.sh apply` before the run.");
  if (verdict === "inconclusive") throw new LaneRefusal("OS_EGRESS_INCONCLUSIVE", `the OS egress probe saw "${outcome}", not a firewall-style timeout; cannot prove the pf ring (is the machine offline?).`);
}

/** Non-probe egress violations recorded during the run. Any entry fails the run. */
export function readEgressViolations(logFile: string): Array<{ at: string; kind: string; target: string; pid: number }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; target: string; pid: number; probe: boolean }).filter((e) => !e.probe);
}
