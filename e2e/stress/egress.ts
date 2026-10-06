import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { LaneRefusal } from "./guards";
import { expandEvaluation, labelledPackets, OS_EGRESS_NOTES, parseInterfaces, pfAnchorPolicyProblems, pfCoverageProblems, probeProblems, type EvalInput, type Proto, type ProbeResult } from "./pf-proof";

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

export const PF_ANCHOR = "com.apple/sandra-stress";

/** Runs `pfctl` with the privilege it needs (reading rules and counters needs root). Throws when it cannot. Injected in tests. */
export type PfRunner = (args: string[]) => string;
export const sudoPfctl: PfRunner = (args) => execFileSync("sudo", ["-n", "pfctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Reads the WHOLE effective ruleset: main plus every anchor spliced where pf evaluates it. Throws when any listed anchor cannot be read (fail closed). */
export function collectRuleset(run: PfRunner): EvalInput {
  const main = run(["-sr"]);
  const anchorRules: Record<string, string> = {};
  const children: Record<string, string[]> = {};
  const visit = (text: string, depth: number) => {
    if (depth > 8) throw new Error("anchor nesting too deep");
    for (const line of text.split("\n")) {
      const m = /^\s*anchor\s+"([^"]+)"/.exec(line);
      if (!m) continue;
      const path = m[1]!;
      const paths: string[] = [];
      if (path.endsWith("/*")) {
        const parent = path.slice(0, -2);
        const names = run(["-a", parent, "-sA"]).split("\n").map((x) => x.trim()).filter(Boolean);
        children[parent] = names.map((n) => (n.startsWith(`${parent}/`) ? n : `${parent}/${n}`));
        paths.push(...children[parent]!);
      } else paths.push(path);
      for (const pth of paths) {
        if (pth in anchorRules) continue;
        anchorRules[pth] = run(["-a", pth, "-sr"]);
        visit(anchorRules[pth]!, depth + 1);
      }
    }
  };
  visit(main, 0);
  return { main, anchorRules, children };
}

export type ProbeSpec = { name: string; proto: Proto; family: 4 | 6; host: string; port: number; required: boolean };
export const PROBES: readonly ProbeSpec[] = [
  { name: "tcp4 1.1.1.1:443", proto: "tcp", family: 4, host: "1.1.1.1", port: 443, required: true },
  { name: "tcp4 9.9.9.9:80", proto: "tcp", family: 4, host: "9.9.9.9", port: 80, required: true },
  { name: "udp4 9.9.9.9:53", proto: "udp", family: 4, host: "9.9.9.9", port: 53, required: true },
  { name: "tcp6 [2606:4700:4700::1111]:443", proto: "tcp", family: 6, host: "2606:4700:4700::1111", port: 443, required: false },
];

/** Runs one probe in a child WITHOUT the in-process guard (it would throw first and the ring would never be exercised). Public resolvers, never a provider. */
export function runProbe(spec: ProbeSpec): string {
  const code = spec.proto === "udp"
    ? `const s=require("node:dgram").createSocket("udp${spec.family}");s.send(Buffer.from("x"),${spec.port},${JSON.stringify(spec.host)},()=>{console.log("sent");process.exit(0)});s.on("error",(e)=>{console.log("error:"+(e&&e.code||"unknown"));process.exit(0)});setTimeout(()=>{console.log("sent");process.exit(0)},2000)`
    : `const s=require("node:net").connect({host:${JSON.stringify(spec.host)},port:${spec.port},family:${spec.family}});s.setTimeout(3000,()=>{console.log("timeout");process.exit(0)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",(e)=>{console.log("error:"+(e&&e.code||"unknown"));process.exit(0)});`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["-e", code], { env, timeout: 10_000, encoding: "utf8" });
  return (r.stdout ?? "").trim() || "error:no_output";
}

export function hasIpv6Route(): boolean {
  try { execFileSync("route", ["-n", "get", "-inet6", "default"], { stdio: "ignore" }); return true; } catch { return false; }
}

/**
 * The OS ring proof. STRUCTURE is the proof (the whole effective ruleset covers every uid x {inet, inet6} x {tcp, udp} with a reached blocking out
 * rule for any destination, no interface skipped); the probes corroborate that the loaded rules are live: each required probe must time out AND move
 * the labelled block counter of its protocol. Needs root for `pfctl` (`sudo -n`); when pf state cannot be read the ring is unverifiable and the run
 * is refused. Returns report notes (what "proven" does and does not cover).
 */
export function proveOsDenial(opts: { uids: readonly number[]; runner?: PfRunner; probe?: (s: ProbeSpec) => string; ipv6Route?: () => boolean }): string[] {
  const run = opts.runner ?? sudoPfctl;
  const probe = opts.probe ?? runProbe;
  const problems: string[] = [];
  const notes: string[] = [OS_EGRESS_NOTES.dns, OS_EGRESS_NOTES.icmp];
  try {
    const statusText = run(["-si"]);
    const ifaces = parseInterfaces(run(["-vsI"]));
    const ruleset = collectRuleset(run);
    const anchorProblems = pfAnchorPolicyProblems(ruleset);
    if (anchorProblems.length) throw new LaneRefusal("OS_EGRESS_UNVERIFIABLE", `the pf ruleset has anchors the proof does not model, so it fails closed: ${anchorProblems.join(" | ")}`);
    const sequence = expandEvaluation(ruleset);
    problems.push(...pfCoverageProblems({ sequence, uids: opts.uids, skippedIfaces: ifaces.skipped, listedInterfaces: ifaces.listed, statusText }));
    const results: ProbeResult[] = [];
    const v6 = (opts.ipv6Route ?? hasIpv6Route)();
    for (const spec of PROBES) {
      if (spec.family === 6 && !v6) { notes.push(OS_EGRESS_NOTES.inet6NoRoute); continue; }
      const before = labelledPackets(run(["-a", PF_ANCHOR, "-vsr"]), spec.proto);
      const outcome = probe(spec);
      const after = labelledPackets(run(["-a", PF_ANCHOR, "-vsr"]), spec.proto);
      results.push({ name: spec.name, proto: spec.proto, outcome, required: true, countersBefore: before, countersAfter: after });
    }
    problems.push(...probeProblems(results));
  } catch (e) {
    throw new LaneRefusal("OS_EGRESS_UNVERIFIABLE", `cannot read the pf state (${(e as Error).message.split("\n")[0]}): the ring needs \`sudo -n pfctl\` (passwordless for pfctl) and every anchor readable to be proven.`);
  }
  if (problems.length) throw new LaneRefusal("OS_EGRESS_NOT_PROVEN", problems.join(" | ") + " (apply with `sudo e2e/stress/egress-pf.sh apply <uid>`)");
  return [...new Set(notes)];
}

/** Non-probe egress violations recorded during the run. Any entry fails the run. */
export function readEgressViolations(logFile: string): Array<{ at: string; kind: string; target: string; pid: number }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; target: string; pid: number; probe: boolean }).filter((e) => !e.probe);
}
