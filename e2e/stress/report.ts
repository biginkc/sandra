import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { StressConfig } from "./config";
import { countByScenario, MANDATORY, type Manifest } from "./manifest";
import type { Check } from "./oracle";
import type { KillReport } from "./kill-switch";
import type { TickRecord } from "./scenarios";

export type Verdict = "PASS" | "FAIL" | "PARTIAL_PASS";

export type RunSummary = {
  verdict: Verdict;
  reasons: string[];
  failingInvariant: Check | null;
  checks: Check[];
  scenarioCounts: Array<{ scenario: string; planned: number; executedReplay: number; deferredBrowser: number }>;
};

/** Verdict rules: any red check, error, egress hit, 5xx, kill or missing mandatory row is FAIL. A reduced scope/profile can only be PARTIAL_PASS, never PASS. */
export function decide(input: {
  cfg: StressConfig;
  manifest: Manifest;
  records: readonly TickRecord[];
  invariantChecks: readonly Check[];
  outcomeChecks: readonly Check[];
  egressViolations: number;
  /** The pf ring was required (STRESS_REQUIRE_OS_EGRESS=1) and its probe saw a firewall-style denial. */
  osEgressProven: boolean;
  serverProblems: string[];
  killed: KillReport | null;
  setupErrors: string[];
  browserExecuted: number;
}): RunSummary {
  const reasons: string[] = [...input.setupErrors];
  const all = [...input.invariantChecks, ...input.outcomeChecks];
  const red = all.filter((c) => !c.ok && !c.deferred);
  for (const c of red) reasons.push(`check ${c.id} (${c.name}) failed: ${c.violations.length} violation(s)`);
  if (input.egressViolations > 0) reasons.push(`${input.egressViolations} egress violation(s)`);
  for (const p of input.serverProblems) reasons.push(p);
  if (input.killed) reasons.push(`kill switch fired: ${input.killed.reason}`);
  const errored = input.records.filter((r) => r.error);
  for (const r of errored) reasons.push(`tick ${r.tick} (${r.scenario}) error: ${r.error}`);

  const planned = countByScenario(input.manifest.ticks);
  const replayDone = new Map<string, number>();
  for (const r of input.records) if (!r.error && r.actor === "replay") replayDone.set(r.scenario, (replayDone.get(r.scenario) ?? 0) + 1);
  const browserPlanned = new Map<string, number>();
  for (const t of input.manifest.ticks) if (t.actor === "browser") browserPlanned.set(t.scenario, (browserPlanned.get(t.scenario) ?? 0) + 1);
  const scenarioCounts = MANDATORY.map((m) => ({
    scenario: m.scenario,
    planned: planned[m.scenario] ?? 0,
    executedReplay: replayDone.get(m.scenario) ?? 0,
    deferredBrowser: browserPlanned.get(m.scenario) ?? 0,
  }));

  const reduced: string[] = [];
  if (!input.osEgressProven) reduced.push("OS egress ring not proven (STRESS_REQUIRE_OS_EGRESS=1 with the pf rules applied)");
  if (input.manifest.profile !== "full") reduced.push(`profile=${input.manifest.profile}`);
  if (input.cfg.scope !== "full") reduced.push(`scope=${input.cfg.scope} (browser lane deferred)`);
  if (input.cfg.scope === "full") {
    const browserPlannedTotal = input.manifest.ticks.filter((t) => t.actor === "browser").length;
    if (input.browserExecuted < browserPlannedTotal) reasons.push(`browser lane executed ${input.browserExecuted}/${browserPlannedTotal} scheduled ticks`);
  }
  const deferred = all.filter((c) => c.deferred);
  if (deferred.length > 0 && input.cfg.scope === "full") for (const c of deferred) reasons.push(`check ${c.id} deferred in a full-scope run`);

  const failing = red[0] ?? null;
  let verdict: Verdict;
  if (reasons.length > 0) verdict = "FAIL";
  else if (reduced.length > 0 || input.cfg.fault !== "none") verdict = "PARTIAL_PASS";
  else verdict = "PASS";
  if (reduced.length > 0 && verdict === "PARTIAL_PASS") reasons.push(`reduced run (${reduced.join(", ")}): not a PASS`);
  return { verdict, reasons, failingInvariant: failing, checks: all, scenarioCounts };
}

export function writeReport(dir: string, input: {
  cfg: StressConfig;
  manifest: Manifest;
  summary: RunSummary;
  pending: string[];
  osEgressProven: boolean;
  appGuardPid: number | null;
  levers: Array<{ lever: string; ok: boolean; detail: string }>;
  killed: KillReport | null;
  stubCounts: { dials: number; sends: number };
  elapsedMs: number;
  repro: string;
}): void {
  const { cfg, manifest, summary } = input;
  const lines: string[] = [];
  lines.push(`# Chaos day ${cfg.runId}: ${summary.verdict}`, "");
  lines.push(`- SHA: ${cfg.sha}`, `- Seed: ${cfg.seed}`, `- Profile: ${manifest.profile}, scope: ${cfg.scope}, fault: ${cfg.fault}`, `- Schedule hash: ${manifest.hash}`, `- Elapsed: ${(input.elapsedMs / 1000).toFixed(1)}s`, `- Stub traffic: ${input.stubCounts.dials} dial(s), ${input.stubCounts.sends} contract send(s)`, `- OS egress: ${input.osEgressProven ? "proven" : "NOT proven"}`, `- App egress guard: ${input.appGuardPid ? `proven in pid ${input.appGuardPid}` : "NOT proven"}`, "");
  if (summary.reasons.length) lines.push("## Why not PASS", ...summary.reasons.map((r) => `- ${r}`), "");
  lines.push("## Scenario counts", "| scenario | planned | executed (replay) | deferred (browser) |", "|---|---|---|---|");
  for (const s of summary.scenarioCounts) lines.push(`| ${s.scenario} | ${s.planned} | ${s.executedReplay} | ${s.deferredBrowser} |`);
  lines.push("", "## Oracle", "| # | tier | check | result | violations |", "|---|---|---|---|---|");
  for (const c of summary.checks) lines.push(`| ${c.id} | ${c.tier} | ${c.name} | ${c.deferred ? `DEFERRED: ${c.deferred}` : c.ok ? "ok" : "FAIL"} | ${c.violations.length} |`);
  if (summary.failingInvariant) lines.push("", `## First failing check: ${summary.failingInvariant.id} ${summary.failingInvariant.name}`, "```json", JSON.stringify(summary.failingInvariant.violations.slice(0, 10), null, 2), "```");
  lines.push("", "## Time levers", ...input.levers.map((l) => `- ${l.ok ? "ok" : "FAIL"} ${l.lever}: ${l.detail}`));
  lines.push("", "## Pending Jarrad (observed, never asserted, not counted in PASS)", ...input.pending.map((p) => `- ${p}`));
  if (input.killed) lines.push("", "## Kill switch", ...input.killed.steps.map((s) => `- step ${s.step} ${s.name}: ${s.ok ? "ok" : "FAILED"} (${s.detail})`), `- Cannot be recalled: ${input.killed.cannotRecall.smsAccepted} accepted SMS, ${input.killed.cannotRecall.contractsSent} contract(s), ${input.killed.cannotRecall.callsDialled} call(s).`);
  lines.push("", "## Repro", "```", input.repro, "```", "");
  writeFileSync(path.join(dir, "REPORT.md"), lines.join("\n"));
}

export const hashConfig = (cfg: StressConfig): string => {
  const safe = { ...cfg, cronSecret: "***", webhookSecret: "***", dbUrl: cfg.dbUrl.replace(/:[^:@/]*@/, ":***@") };
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex");
};
