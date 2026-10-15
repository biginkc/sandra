import { classifierMigrationFiles, sq2FixLanded } from "./migration";
import { EXPECTED_UNTIL, FIX_PENDING, SPEC_QUESTIONS } from "./oracle";
import type { FamilyRun, Mismatch, MismatchKind, Timing } from "./runner";

export const P95_BUDGET_MS = 1500;

export type Stat = { n: number; p50: number; p95: number; max: number };

export function stat(xs: readonly number[]): Stat {
  if (xs.length === 0) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1]!) };
}
const round = (n: number) => Math.round(n * 10) / 10;

export function statTimings(t: Timing): Record<string, Stat> {
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, stat(v)]));
}

export type LaneResult = {
  id: string;
  title: string;
  runs: number;
  failures: number;
  /** why the lane did not run (never silently skipped: a skipped lane in a full run fails the report) */
  skipped?: string;
  samples: unknown[];
  notes?: string[];
};

export type PlanNode = { node: string; exclusiveMs: number; totalMs: number; loops: number; rows: number };
export type ScaleSize = {
  /** EXPLAIN ANALYZE of the my_leads_work_classified body at this size: top nodes by exclusive time. */
  explainTop?: PlanNode[]; leads: number; messagesPerLead: [number, number]; messages: number; seedMs: number; timings: Record<string, Stat>; worstP95Ms: number; budgetMs: number };

export type FamilyReport = {
  family: string;
  title: string;
  worlds: number;
  leads: number;
  checks: number;
  failingLeads: number;
  failureRate: number;
  byKind: Partial<Record<MismatchKind, number>>;
  bySpecQuestion: Record<string, number>;
  /** Mismatches in worlds whose only lead-level disagreements are spec questions with a fix in flight (EXPECTED_UNTIL); not gating. */
  expected: number;
  variantFailureRates: Record<string, { leads: number; failing: number; rate: number }>;
  errors: string[];
  ms: number;
  timings: Record<string, Stat>;
  samples: Mismatch[];
};

export type Criterion = { id: string; label: string; value: number | null; limit: number; pass: boolean; evaluated: boolean; note?: string };

export type Report = {
  schema: "my-leads-queue-stress/v1";
  mode: "full" | "smoke";
  startedAt: string;
  finishedAt: string;
  seed: number;
  repeats: number;
  sha: string;
  database: string;
  /** Classifier migration files every rolled-back lane applied, in order. */
  migrations: string[];
  families: FamilyReport[];
  lanes: LaneResult[];
  scale: ScaleSize[];
  specQuestions: Record<string, { text: string; mismatches: number; expectedUntil?: string; gating: boolean }>;
  criteria: Criterion[];
  verdict: "PASS" | "FAIL";
  failReasons: string[];
};

const GATED_KINDS: Array<[MismatchKind, string]> = [
  ["wrong_tab", "wrong-tab rate (oracle place vs SQL place)"],
  ["hidden_lead", "hidden-lead rate (a Your/Their-move lead in neither tab)"],
  ["count_row", "count/row mismatch (reported counts vs rows returned vs oracle)"],
  ["wrong_chip", "wrong-chip rate (right tab, wrong reason)"],
  ["wrong_row", "decision-row mismatch"],
  ["headline", "headline mismatch"],
  ["broken_actions", "Broken fix-action mismatch"],
  ["view_membership", "tab/chip view membership mismatch"],
  ["badge", "sidebar badge mismatch"],
  ["order", "sort-order mismatch"],
  ["pagination", "pagination invariant violations"],
  ["owner_view", "owner-viewing-rep view mismatch"],
  ["scope", "scope refusal (other rep / other org) mismatch"],
];

export function summarizeFamily(run: FamilyRun, samplesPerKind = 3): FamilyReport {
  const byKind: Partial<Record<MismatchKind, number>> = {};
  const bySpecQuestion: Record<string, number> = {};
  const seenKind = new Map<string, number>();
  const samples: Mismatch[] = [];
  for (const m of run.mismatches) {
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    if (m.question) bySpecQuestion[m.question] = (bySpecQuestion[m.question] ?? 0) + 1;
    const k = `${m.kind}:${m.question ?? ""}`;
    if ((seenKind.get(k) ?? 0) < samplesPerKind) { seenKind.set(k, (seenKind.get(k) ?? 0) + 1); samples.push(m); }
  }
  const failingLeads = new Set(run.mismatches.filter((m) => m.lead !== "-").map((m) => `${m.repeat}:${m.lead}`)).size;
  const variantFailureRates: FamilyReport["variantFailureRates"] = {};
  for (const [k, leads] of Object.entries(run.variantLeads)) {
    const failing = run.variantFailures[k] ?? 0;
    variantFailureRates[k] = { leads, failing, rate: leads ? failing / leads : 0 };
  }
  return {
    family: run.family, title: run.title, worlds: run.worlds, leads: run.leads, checks: run.checks, failingLeads,
    failureRate: run.leads ? failingLeads / run.leads : 0, byKind, bySpecQuestion, variantFailureRates, errors: run.errors, ms: Math.round(run.ms),
    timings: statTimings(run.timings), samples, expected: 0,
  };
}

/** A scale size counts only if it has timing samples and every one is finite. */
function measured(x: ScaleSize): boolean {
  const stats = Object.entries(x.timings).filter(([k]) => !k.startsWith("projection:")).map(([, v]) => v);
  return stats.length > 0 && stats.every((v) => v.n > 0 && Number.isFinite(v.p95) && Number.isFinite(v.p50)) && Number.isFinite(x.worstP95Ms);
}

export function buildReport(input: {
  mode: "full" | "smoke"; seed: number; repeats: number; sha: string; database: string; startedAt: string;
  runs: FamilyRun[]; lanes: LaneResult[]; scale: ScaleSize[];
}): Report {
  // Mismatches the runner proved are exactly a routed SQL fix's disagreement (expectedUntil) are reported, not gating.
  const families = input.runs.map((r) => {
    const expected = r.mismatches.filter((m) => m.expectedUntil);
    const summary = summarizeFamily({ ...r, mismatches: r.mismatches.filter((m) => !m.expectedUntil) });
    for (const m of expected) if (m.question) summary.bySpecQuestion[m.question] = (summary.bySpecQuestion[m.question] ?? 0) + 1;
    summary.expected = expected.length;
    return summary;
  });
  const total = (kind: MismatchKind) => families.reduce((a, f) => a + (f.byKind[kind] ?? 0), 0);
  const criteria: Criterion[] = GATED_KINDS.map(([kind, label]) => ({ id: kind, label, value: total(kind), limit: 0, pass: total(kind) === 0, evaluated: families.length > 0 }));
  const raceLanes = input.lanes.filter((l) => l.id.startsWith("race:") || l.id.startsWith("refresh:"));
  const raceFailures = raceLanes.reduce((a, l) => a + l.failures, 0);
  const raceRan = raceLanes.filter((l) => !l.skipped);
  criteria.push({ id: "race", label: "race lanes: newer replies marked handled / placement wrong at refresh", value: raceFailures, limit: 0, pass: raceFailures === 0 && (input.mode === "smoke" || raceRan.length === raceLanes.length && raceLanes.length > 0), evaluated: raceRan.length > 0,
    note: raceLanes.some((l) => l.skipped) ? `skipped: ${raceLanes.filter((l) => l.skipped).map((l) => `${l.id} (${l.skipped})`).join("; ")}` : undefined });
  // Gate (master acceptance 2.19, kept by the root coordinator): p95 < 1.5 s at BOTH 400 and 2,000 leads.
  // Every measured size is gated too (e.g. --scale-sizes 1000), not just the two required ones.
  for (const size of [...new Set([400, 2000, ...input.scale.map((y) => y.leads)])].sort((a, b) => a - b)) {
    const x = input.scale.find((y) => y.leads === size);
    criteria.push({ id: `p95_${size}`, label: `scale p95 within ${P95_BUDGET_MS} ms at ${size} leads`, value: x ? x.worstP95Ms : null, limit: P95_BUDGET_MS,
      pass: x ? measured(x) && x.worstP95Ms < P95_BUDGET_MS : input.mode === "smoke", evaluated: !!x,
      note: x && !measured(x) ? "no usable timing samples (empty or non-finite): fails" : undefined });
  }
  const errors = families.reduce((a, f) => a + f.errors.length, 0);
  criteria.push({ id: "errors", label: "worlds that failed to run (setup or SQL errors)", value: errors, limit: 0, pass: errors === 0, evaluated: true });
  const fullRunNeeds: string[] = [];
  // Zero work never passes: every family that ran must have executed worlds and checks, every lane that is not skipped must have runs.
  for (const f of families) if (f.worlds === 0 || f.checks === 0) fullRunNeeds.push(`family ${f.family} executed ${f.worlds} worlds / ${f.checks} checks`);
  for (const l of input.lanes) if (!l.skipped && l.runs === 0) fullRunNeeds.push(`lane ${l.id} executed 0 runs`);
  if (input.mode === "full") {
    if (families.length < 31) fullRunNeeds.push(`only ${families.length} of 31 families ran`);
    if (input.scale.length < 2) fullRunNeeds.push("the scale lane did not run at both 400 and 2,000 leads");
    if (raceRan.length === 0) fullRunNeeds.push("no race lane ran");
    if (!raceRan.some((l) => l.id.startsWith("race:dispatch_"))) fullRunNeeds.push("the dispatchRepSms race lanes did not run (npm run stress:my-leads-queue:dispatch writes dispatch-lanes.json into --out first)");
  }
  const specQuestions: Report["specQuestions"] = Object.fromEntries(Object.entries(SPEC_QUESTIONS).map(([id, text]) => [id, { text, mismatches: families.reduce((a, f) => a + (f.bySpecQuestion[id] ?? 0), 0), expectedUntil: (sq2FixLanded() ? undefined : EXPECTED_UNTIL[id]) ?? FIX_PENDING[id], gating: sq2FixLanded() || !EXPECTED_UNTIL[id] }]));
  const failReasons = [...criteria.filter((c) => !c.pass).map((c) => `${c.label}: ${c.value ?? "not measured"}`), ...fullRunNeeds];
  return {
    schema: "my-leads-queue-stress/v1", mode: input.mode, startedAt: input.startedAt, finishedAt: new Date().toISOString(), seed: input.seed, repeats: input.repeats,
    sha: input.sha, database: input.database, migrations: classifierMigrationFiles(), families, lanes: input.lanes, scale: input.scale, specQuestions, criteria,
    verdict: failReasons.length === 0 ? "PASS" : "FAIL", failReasons,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

export function renderMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(`# My Leads unified queue stress report`, "");
  L.push(`**Verdict: ${r.verdict}** (${r.mode} run, seed ${r.seed}, ${r.repeats} repeat${r.repeats === 1 ? "" : "s"}, ${r.sha}, ${r.database})`, "");
  L.push(`Classifier SQL applied (in order): ${r.migrations.map((m) => `\`${m}\``).join(", ")}`, "");
  if (r.failReasons.length) { L.push("Blocking:"); for (const f of r.failReasons) L.push(`- ${f}`); L.push(""); }
  L.push("## Exit criteria", "", "| Criterion | Value | Limit | Result |", "|---|---:|---:|---|");
  for (const c of r.criteria) L.push(`| ${c.label}${c.note ? ` — ${c.note}` : ""} | ${c.value ?? "n/a"} | ${c.id === "p95" ? `< ${c.limit} ms` : c.limit} | ${!c.evaluated ? "not evaluated" : !c.pass ? "FAIL" : c.note?.startsWith("WARN") ? "WARN" : "pass"} |`);
  L.push("", "## Per-family failure rates (leads with any mismatch / leads checked)", "", "| Family | Worlds | Leads | Checks | Failing | Rate | Mismatch kinds | p95 All-tab page (ms) |", "|---|---:|---:|---:|---:|---:|---|---:|");
  for (const f of r.families) {
    const kinds = Object.entries(f.byKind).map(([k, n]) => `${k}:${n}`).join(", ") || "-";
    L.push(`| ${f.family} | ${f.worlds} | ${f.leads} | ${f.checks} | ${f.failingLeads} | ${pct(f.failureRate)} | ${kinds} | ${f.timings["page:all:all"]?.p95 ?? "-"} |`);
  }
  const sq = Object.entries(r.specQuestions);
  L.push("", "## Spec questions (design text and SQL disagree; the oracle follows the text)", "");
  const expectedTotal = r.families.reduce((a, f) => a + f.expected, 0);
  if (expectedTotal) L.push(`${expectedTotal} mismatches are expected until their SQL fix lands and do not fail the run.`, "");
  for (const [id, q] of sq) L.push(`- **${id}**${q.expectedUntil ? ` (expected_until: ${q.expectedUntil}${q.gating ? ", still fails the run" : ", excused"})` : ""} (${q.mismatches} mismatch${q.mismatches === 1 ? "" : "es"}): ${q.text}`);
  L.push("", "## Race and refresh lanes", "");
  if (r.lanes.length === 0) L.push("(not run)");
  for (const l of r.lanes) L.push(`- **${l.id}** ${l.title}: ${l.skipped ? `SKIPPED — ${l.skipped}` : `${l.runs} runs, ${l.failures} failure${l.failures === 1 ? "" : "s"}`}${l.notes?.length ? ` (${l.notes.join("; ")})` : ""}`);
  L.push("", "## Scale", "");
  if (r.scale.length === 0) L.push("(not run)");
  for (const s of r.scale) {
    L.push(`### ${s.leads} leads, ${s.messagesPerLead[0]}-${s.messagesPerLead[1]} messages each (${s.messages} messages, seeded in ${Math.round(s.seedMs)} ms)`, "", "| Call | n | p50 ms | p95 ms | max ms |", "|---|---:|---:|---:|---:|");
    for (const [k, v] of Object.entries(s.timings)) L.push(`| ${k} | ${v.n} | ${v.p50} | ${v.p95} | ${v.max} |`);
    L.push("");
    if (s.explainTop?.length) {
      L.push("EXPLAIN ANALYZE of `my_leads_work_classified` (top nodes by exclusive time):", "", "| Node | exclusive ms | total ms | loops | rows |", "|---|---:|---:|---:|---:|");
      for (const n of s.explainTop) L.push(`| ${n.node} | ${n.exclusiveMs} | ${n.totalMs} | ${n.loops} | ${n.rows} |`);
      L.push("");
    }
  }
  const withSamples = r.families.filter((f) => f.samples.length);
  if (withSamples.length) {
    L.push("## Sample mismatches (first few per family and kind)", "");
    for (const f of withSamples) {
      L.push(`### ${f.family}`, "");
      for (const m of f.samples) L.push(`- \`${m.kind}\` repeat ${m.repeat} lead \`${m.lead}\`${m.question ? ` [${m.question}]` : ""}: expected ${JSON.stringify(m.expected)}; got ${JSON.stringify(m.actual)}`);
      L.push("");
    }
  }
  return L.join("\n");
}
