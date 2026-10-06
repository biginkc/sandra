import { execFileSync, spawnSync } from "node:child_process";
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

export const PF_ANCHOR = "com.apple/sandra-stress";

/** Runs `pfctl` with the privilege it needs (reading rules and counters needs root). Throws when it cannot. Injected in tests. */
export type PfRunner = (args: string[]) => string;
export const sudoPfctl: PfRunner = (args) => execFileSync("sudo", ["-n", "pfctl", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export type PfRule = { text: string; packets: number | null; uid: number | null; proto: string | null };

/** Parses `pfctl -vsr` (rules, each followed by `[ Evaluations: n  Packets: n  Bytes: n  States: n ]`). */
export function parsePfRules(output: string): PfRule[] {
  const rules: PfRule[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (/^(block|pass)\b/.test(line)) {
      rules.push({ text: line, packets: null, uid: Number(/\buser = (\d+)/.exec(line)?.[1] ?? NaN) || null, proto: /\bproto (\w+)/.exec(line)?.[1] ?? null });
    } else if (rules.length && rules[rules.length - 1]!.packets === null) {
      const m = /Packets:\s*(\d+)/.exec(line);
      if (m) rules[rules.length - 1]!.packets = Number(m[1]);
    }
  }
  return rules;
}

const blockPackets = (rules: readonly PfRule[], uid: number) => rules.filter((r) => r.text.startsWith("block") && r.uid === uid && r.text.includes(" out ")).reduce((n, r) => n + (r.packets ?? 0), 0);

/**
 * A timeout is not proof: an upstream filter, a dead route or a down network produce the same silence. The ring is proven only when pf itself
 * says so: enabled, the anchor holds a blocking `out` rule for every uid that must be covered (the harness and the app listener), a loopback
 * pass is present, and the probe's SYN moved a block rule's packet counter. All of it is pure over the pfctl text, so it is unit-tested.
 */
export function pfProofProblems(input: { statusText: string; rulesBefore: string; rulesAfter: string; uids: readonly number[]; probe: OsProbeOutcome }): string[] {
  const p: string[] = [];
  if (!/Status:\s*Enabled/i.test(input.statusText)) p.push("pf is not enabled (`pfctl -si` does not say Enabled)");
  const before = parsePfRules(input.rulesBefore);
  const after = parsePfRules(input.rulesAfter);
  if (!after.length) p.push(`the anchor ${PF_ANCHOR} holds no rules`);
  if (!after.some((r) => r.text.startsWith("pass") && /\bon lo0\b/.test(r.text))) p.push("the anchor has no loopback pass rule");
  for (const uid of input.uids) {
    if (!after.some((r) => r.text.startsWith("block") && r.uid === uid && r.text.includes(" out ") && /\bproto (tcp|udp)\b/.test(r.text))) p.push(`no blocking out rule covers uid ${uid}`);
    else if (blockPackets(after, uid) <= blockPackets(before, uid)) p.push(`the probe did not move the pf block counter for uid ${uid} (before ${blockPackets(before, uid)}, after ${blockPackets(after, uid)}): the silence is not the firewall's`);
  }
  if (input.probe === "connected") p.push("a non-loopback connection succeeded");
  else if (input.probe !== "timeout") p.push(`the probe saw "${input.probe}", not a firewall-style timeout`);
  return p;
}

/** Runs the probe in a child WITHOUT the in-process guard (it would throw first and the ring would never be exercised). A TCP SYN to a public resolver, never a provider. */
export function runOsProbe(): OsProbeOutcome {
  const code = `const s=require("node:net").connect({host:"1.1.1.1",port:443});s.setTimeout(3000,()=>{console.log("timeout");process.exit(0)});s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",(e)=>{console.log("error:"+(e&&e.code||"unknown"));process.exit(0)});`;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["-e", code], { env, timeout: 10_000, encoding: "utf8" });
  return ((r.stdout ?? "").trim() || "error:no_output") as OsProbeOutcome;
}

/**
 * The OS ring proof: read pf state and counters, probe, read again, and require pf's own evidence (see pfProofProblems). Needs root for `pfctl`
 * (`sudo -n`); when pf state cannot be read the ring is unverifiable and the run is refused (the caller only asks when the ring is required).
 */
export function proveOsDenial(opts: { uids: readonly number[]; runner?: PfRunner; probe?: () => OsProbeOutcome }): void {
  const run = opts.runner ?? sudoPfctl;
  let statusText: string, rulesBefore: string, rulesAfter: string, probe: OsProbeOutcome;
  try {
    statusText = run(["-si"]);
    rulesBefore = run(["-a", PF_ANCHOR, "-vsr"]);
    probe = (opts.probe ?? runOsProbe)();
    rulesAfter = run(["-a", PF_ANCHOR, "-vsr"]);
  } catch (e) {
    throw new LaneRefusal("OS_EGRESS_UNVERIFIABLE", `cannot read the pf state (${(e as Error).message.split("\n")[0]}): the ring needs \`sudo -n pfctl\` (passwordless for pfctl) to be proven.`);
  }
  const problems = pfProofProblems({ statusText, rulesBefore, rulesAfter, uids: opts.uids, probe });
  if (problems.length) throw new LaneRefusal("OS_EGRESS_NOT_PROVEN", problems.join(" | ") + " (apply with `sudo e2e/stress/egress-pf.sh apply <uid>`)");
}

/** Non-probe egress violations recorded during the run. Any entry fails the run. */
export function readEgressViolations(logFile: string): Array<{ at: string; kind: string; target: string; pid: number }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; kind: string; target: string; pid: number; probe: boolean }).filter((e) => !e.probe);
}
