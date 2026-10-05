import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";

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

/** OS ring: a guard-less child tries TEST-NET-1. A completed connect means the firewall is not blocking. */
export async function proveOsDenial(): Promise<void> {
  const connected = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "192.0.2.1", port: 80 });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(2500, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
  if (connected) throw new LaneRefusal("OS_EGRESS_OPEN", "a non-loopback connection succeeded; apply egress-pf.conf before the run.");
}

/** Non-probe egress violations recorded during the run. Any entry fails the run. */
export function readEgressViolations(logFile: string): Array<{ at: string; kind: string; target: string; pid: number }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; target: string; pid: number; probe: boolean }).filter((e) => !e.probe);
}
