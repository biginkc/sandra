/**
 * Jev -> Luna fallback cascade evaluation (LOCAL, offline). Reads a masked replay export, runs Jev
 * (and Luna on the messages Jev would hold for a human, or on all with headToHead), and scores both
 * against what a human decided. Opens no database and sends no SMS. Luna is never used in production.
 */
import { createHash } from "node:crypto";

import { resolveThresholdDecision, type ThresholdMap, type ThresholdableOutcome } from "../../../src/lib/sms-classification/thresholds";
import { classifyWithJev } from "../../../src/lib/sms-classification/providers/jev-gateway";
import { JEV_MODEL, JEV_SCHEMA_VERSION } from "../../../src/lib/sms-classification/questions";
import type { JevOutcome } from "../../../src/lib/sms-classification/types";
import type { CompareCache } from "./compare-cache";
import {
  CUTOFFS, agreementAtCutoffs, cascadeAtCutoff, jevAlone, modelStats, percentile, rate,
  type CascadeOptions, type Pred, type Row,
} from "./compare-scoring";
import { buildThread, type ThreadMessage } from "./compare-thread";
import { deriveGroundTruth } from "./ground-truth";
import { lunaSystemPrompt } from "./classifiers/luna-prompt";
import type { LunaResult } from "./classifiers/luna";
import type { ReplayExport } from "./schema";

/** Current defaults (PLAN.md Q5, decided 2026-10-08), used only when the export carries no threshold rows. */
export const DEFAULT_THRESHOLDS: ThresholdMap = {
  not_interested: { minConfidence: 0.9, version: 0, automationEnabled: true },
  wrong_number: { minConfidence: 0.9, version: 0, automationEnabled: true },
  nurture: { minConfidence: 0.95, version: 0, automationEnabled: true },
  opted_out: { minConfidence: 0.95, version: 0, automationEnabled: true },
  new_lead: { minConfidence: 0.9, version: 0, automationEnabled: false },
};

export function thresholdsFromExport(exp: ReplayExport): { map: ThresholdMap; source: "export" | "defaults" } {
  const rows = exp.tables.jev_outcome_thresholds ?? [];
  if (!rows.length) return { map: DEFAULT_THRESHOLDS, source: "defaults" };
  const map: ThresholdMap = {};
  for (const r of rows) {
    const o = String(r.outcome) as ThresholdableOutcome;
    const min = Number(r.min_confidence);
    if (Number.isFinite(min)) map[o] = { minConfidence: min, version: Number(r.version) || 0, automationEnabled: r.automation_enabled === true };
  }
  return { map, source: "export" };
}

export type JevCall =
  | { status: "ok"; outcome: JevOutcome; confidence: number | null; escalationReason: string | null; latencyMs: number; usage: { inputTokens: number | null; outputTokens: number | null } | null }
  | { status: "error"; error: string; latencyMs: number };

export type CompareDeps = {
  jev: (args: { thread: ThreadMessage[]; propertyId: string; conversationId: string }) => Promise<JevCall>;
  luna: ((thread: ThreadMessage[]) => Promise<LunaResult>) | null;
  cache: CompareCache;
  lunaModel: string | null;
  lunaApi: string | null;
  log?: (line: string) => void;
};

export type CompareOptions = {
  concurrency: number;
  limit: number | null;
  headToHead: boolean;
  scope: CascadeOptions["scope"];
  /** "policy": Luna may only apply outcomes Jev policy would auto-apply for this org. "any": any thresholdable outcome. */
  eligibility: "policy" | "any";
  lunaPrices: { inputPerMTok: number; outputPerMTok: number } | null;
  /** Luna runs only on messages with an explicit human decision (they are the only ones that can be scored). */
  truthOnly?: boolean;
};

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

export async function mapPool<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export function jevDeps(apiKey: string, fetchImpl: typeof fetch): CompareDeps["jev"] {
  return async ({ thread, propertyId, conversationId }) => {
    const started = Date.now();
    try {
      const d = await classifyWithJev(
        { conversationId, thread, state: { propertyId }, includeReplyIntent: false },
        { fetch: fetchImpl, apiKey },
      );
      return { status: "ok", outcome: d.outcome, confidence: d.outcomeConfidence ?? null, escalationReason: d.escalationReason, latencyMs: d.latencyMs, usage: d.usage };
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : "unknown error", latencyMs: Date.now() - started };
    }
  };
}

export type ComparedMessage = Row & {
  receivedAt: string;
  jevCall: JevCall;
  lunaCall: LunaResult | null;
  truthSource: string | null;
  contextDegraded: boolean;
};

export async function runCompare(exp: ReplayExport, opts: CompareOptions, deps: CompareDeps) {
  const log = deps.log ?? (() => undefined);
  const { map: thresholds, source: thresholdSource } = thresholdsFromExport(exp);
  const truth = deriveGroundTruth(exp);
  const inbound = opts.limit ? exp.inbound.slice(0, opts.limit) : exp.inbound;
  const promptHash = sha(lunaSystemPrompt());
  let jevCached = 0, lunaCached = 0, jevCalls = 0, lunaCalls = 0;

  const prepared = inbound.map((m) => {
    const { thread, missingOutboundBodies } = buildThread(exp, m);
    return { m, thread, degraded: missingOutboundBodies > 0, threadHash: sha(thread) };
  });

  const rows: ComparedMessage[] = await mapPool(prepared, opts.concurrency, async ({ m, thread, degraded, threadHash }, i) => {
    // 1. Jev
    const jevKey = `jev|${JEV_MODEL}|${JEV_SCHEMA_VERSION}|${m.id}|${threadHash}`;
    let jevCall = deps.cache.get(jevKey) as JevCall | undefined;
    if (jevCall) jevCached++;
    else {
      jevCall = await deps.jev({ thread, propertyId: m.propertyId ?? "unknown", conversationId: m.conversationId ?? m.propertyId ?? m.id });
      jevCalls++;
      if (jevCall.status === "ok") deps.cache.set(jevKey, jevCall);
    }
    const jev: Pred | null = jevCall.status === "ok" ? { label: jevCall.outcome, confidence: jevCall.confidence } : null;
    const jevDecision: Row["jevDecision"] = jevCall.status === "ok"
      ? (() => {
          const d = resolveThresholdDecision({ outcome: jevCall.outcome, outcomeConfidence: jevCall.confidence }, thresholds);
          return d.status === "auto_apply" ? { status: "auto_apply" as const, reason: "auto_apply" }
            : d.status === "needs_decision" ? { status: "hold" as const, reason: "needs_decision" }
            : { status: "hold" as const, reason: d.reason };
        })()
      : { status: "hold", reason: "jev_error" };

    // 2. Luna: on every Jev hold (the cascade population), or on everything with headToHead.
    let lunaCall: LunaResult | null = null;
    if (deps.luna && (!opts.truthOnly || truth.get(m.id)?.kind === "explicit") && (opts.headToHead || (jevDecision.status === "hold" && (opts.scope === "all_holds" || jevDecision.reason === "needs_decision")))) {
      const key = `luna|${deps.lunaModel}|${deps.lunaApi}|${promptHash}|${m.id}|${threadHash}`;
      const cached = deps.cache.get(key) as LunaResult | undefined;
      if (cached) { lunaCached++; lunaCall = cached; }
      else {
        lunaCall = await deps.luna(thread);
        lunaCalls++;
        if (lunaCall.status === "ok") deps.cache.set(key, lunaCall);
      }
    }
    if ((i + 1) % 25 === 0) log(`[${i + 1}/${prepared.length}] jev calls ${jevCalls} (cached ${jevCached}), luna calls ${lunaCalls} (cached ${lunaCached})`);
    const tr = truth.get(m.id) ?? null;
    return {
      id: m.id, text: m.body, receivedAt: m.receivedAt,
      truth: tr ? { label: tr.label, kind: tr.kind } : null,
      truthSource: tr?.source ?? null,
      jev, jevDecision, jevCall,
      luna: lunaCall?.status === "ok" ? { label: lunaCall.outcome, confidence: lunaCall.confidence } : null,
      lunaErrored: lunaCall?.status === "error",
      lunaCall, contextDegraded: degraded,
    };
  });

  return { rows, thresholds, thresholdSource, stats: { jevCalls, jevCached, lunaCalls, lunaCached } };
}

const SHOW_CUTOFFS = [0.8, 0.85, 0.9, 0.95, 0.99];

export function buildReport(
  exp: ReplayExport,
  run: Awaited<ReturnType<typeof runCompare>>,
  opts: CompareOptions,
  meta: { generatedAt: string; lunaModel: string | null },
) {
  const { rows, thresholds } = run;
  const eligible = new Set<string>(
    opts.eligibility === "any"
      ? ["not_interested", "wrong_number", "nurture", "opted_out", "new_lead"]
      : Object.entries(thresholds).filter(([, v]) => v?.automationEnabled).map(([k]) => k),
  );
  const mk = (includeImplicit: boolean) => {
    const o: CascadeOptions = { eligible, scope: opts.scope, includeImplicit };
    const f = { includeImplicit };
    const lunaRan = rows.some((r) => r.lunaCall);
    return {
      jevAlone: jevAlone(rows, f),
      cascade: lunaRan ? [cascadeAtCutoff(rows, null, o), ...CUTOFFS.map((c) => cascadeAtCutoff(rows, c, o))] : [],
      headToHead: opts.headToHead && lunaRan ? {
        jev: { ...modelStats(rows, (r) => r.jev, f), atCutoffs: agreementAtCutoffs(rows, (r) => r.jev, f) },
        luna: { ...modelStats(rows, (r) => r.luna, f), atCutoffs: agreementAtCutoffs(rows, (r) => r.luna, f) },
      } : null,
    };
  };
  const explicit = mk(false);
  const withImplicit = mk(true);

  const truthCounts = { explicit: 0, implicit: 0, none: 0 };
  const truthSources: Record<string, number> = {};
  for (const r of rows) {
    if (!r.truth) truthCounts.none++; else { truthCounts[r.truth.kind]++; truthSources[r.truthSource!] = (truthSources[r.truthSource!] ?? 0) + 1; }
  }
  const scopeHolds = rows.filter((r) => r.jevDecision.status === "hold" && (opts.scope === "all_holds" || r.jevDecision.reason === "needs_decision"));

  const lunaCalls = rows.map((r) => r.lunaCall).filter((x): x is LunaResult => !!x);
  const lat = lunaCalls.map((c) => c.latencyMs);
  const tokensIn = lunaCalls.reduce((a, c) => a + (c.status === "ok" ? c.usage?.inputTokens ?? 0 : 0), 0);
  const tokensOut = lunaCalls.reduce((a, c) => a + (c.status === "ok" ? c.usage?.outputTokens ?? 0 : 0), 0);
  const cost = opts.lunaPrices ? (tokensIn * opts.lunaPrices.inputPerMTok + tokensOut * opts.lunaPrices.outputPerMTok) / 1e6 : null;
  const jevLat = rows.map((r) => r.jevCall.latencyMs);
  const jevOk = rows.filter((r) => r.jevCall.status === "ok");
  const jevTokens = jevOk.reduce((a, r) => a + ((r.jevCall as Extract<typeof r.jevCall, { status: "ok" }>).usage?.inputTokens ?? 0) + ((r.jevCall as Extract<typeof r.jevCall, { status: "ok" }>).usage?.outputTokens ?? 0), 0);

  const cutoffForDisagreements = 0.9;
  const disagreements = rows
    .filter((r) => r.truth && (r.jev?.label !== r.truth.label || (r.luna && r.luna.label !== r.truth.label)))
    .map((r) => ({
      id: r.id, text: r.text, human: r.truth!.label, humanKind: r.truth!.kind, humanSource: r.truthSource,
      jev: r.jev, jevDecision: r.jevDecision, luna: r.luna, lunaError: r.lunaErrored ? (r.lunaCall as { error: string }).error : null,
      cascadeWrongAt90: scopeHolds.includes(r) && r.luna !== null && (r.luna.confidence ?? 0) >= cutoffForDisagreements && eligible.has(r.luna.label) && r.luna.label !== r.truth!.label,
    }))
    .sort((a, b) => Number(b.cascadeWrongAt90) - Number(a.cascadeWrongAt90));

  return {
    batchId: exp.batchId,
    generatedAt: meta.generatedAt,
    sampleSizes: {
      inboundMessages: rows.length,
      jevOk: jevOk.length,
      jevErrors: rows.length - jevOk.length,
      withHumanTruthExplicit: truthCounts.explicit,
      withHumanTruthImplicit: truthCounts.implicit,
      noHumanDecisionExcluded: truthCounts.none,
      cascadePopulation: scopeHolds.length,
      cascadePopulationWithExplicitTruth: scopeHolds.filter((r) => r.truth?.kind === "explicit").length,
      lunaOk: lunaCalls.filter((c) => c.status === "ok").length,
      lunaErrors: lunaCalls.filter((c) => c.status === "error").length,
      contextDegradedMessages: rows.filter((r) => r.contextDegraded).length,
    },
    config: {
      scope: opts.scope, eligibility: opts.eligibility, eligibleOutcomes: [...eligible].sort(), headToHead: opts.headToHead,
      thresholdSource: run.thresholdSource, thresholds, lunaModel: meta.lunaModel,
      jevModel: JEV_MODEL, jevSchemaVersion: JEV_SCHEMA_VERSION, cutoffs: CUTOFFS,
    },
    truthDefinition: { sources: truthSources },
    explicit, withImplicit,
    cost: {
      luna: { calls: lunaCalls.length, errors: lunaCalls.filter((c) => c.status === "error").length, inputTokens: tokensIn, outputTokens: tokensOut, totalUsd: cost,
        perCallUsd: cost !== null && lunaCalls.length ? cost / lunaCalls.length : null, latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), mean: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null } },
      jev: { calls: rows.length, tokens: jevTokens, latencyMs: { p50: percentile(jevLat, 50), p95: percentile(jevLat, 95) }, note: "Jev is billed by TypeSafe, not per token; tokens and latency only." },
    },
    disagreements,
    run: run.stats,
  };
}

export type CompareReport = ReturnType<typeof buildReport>;

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "n/a (set LUNA_PRICE_INPUT_PER_MTOK / LUNA_PRICE_OUTPUT_PER_MTOK)" : `$${x.toFixed(4)}`);
const ms = (x: number | null) => (x === null ? "n/a" : `${Math.round(x)} ms`);

export function renderMarkdown(r: CompareReport): string {
  const s = r.sampleSizes, L: string[] = [];
  L.push(`# Jev -> Luna fallback cascade evaluation (batch ${r.batchId})`, "", `Generated ${r.generatedAt}. Local replay only; nothing here is wired into production. Masked data, still treat as seller PII.`, "");
  L.push("## Sample sizes", "");
  L.push(`- Inbound texts: ${s.inboundMessages} (Jev ok ${s.jevOk}, Jev errors ${s.jevErrors})`);
  L.push(`- With a human decision (explicit): ${s.withHumanTruthExplicit}; implicit (auto-applied, uncorrected 72h): ${s.withHumanTruthImplicit}; no human decision, excluded from all scores: ${s.noHumanDecisionExcluded}`);
  L.push(`- Cascade population (Jev ${r.config.scope === "below_threshold" ? "below its per-outcome threshold" : "held for any reason"}): ${s.cascadePopulation}, of which ${s.cascadePopulationWithExplicitTruth} have an explicit human decision`);
  L.push(`- Luna calls ok ${s.lunaOk}, errors ${s.lunaErrors}. Messages whose context lacks outbound bodies (old export): ${s.contextDegradedMessages}`, "");
  if (s.cascadePopulationWithExplicitTruth < 30) L.push("> Warning: fewer than 30 scored cascade cases. Rates below are anecdotal, not calibration-grade.", "");
  L.push("## What counts as human truth", "", "Per inbound text, first match within 72h: corrected review; corrected decision; a human dispo change that differs from Jev's (needs_sequence after nurture is agreement); human-confirmed review/decision; auto-applied and uncorrected after 72h (implicit, shown separately). Messages with no human decision are excluded. Sources in this batch: " + (Object.entries(r.truthDefinition.sources).map(([k, v]) => `${k}=${v}`).join(", ") || "none"), "");
  L.push("## Thresholds in force", "", `Source: ${r.config.thresholdSource}.`, "", "| outcome | min confidence | automation |", "|---|---|---|");
  for (const [k, v] of Object.entries(r.config.thresholds)) L.push(`| ${k} | ${v!.minConfidence} | ${v!.automationEnabled ? "on" : "off"} |`);
  L.push("", `Luna may auto-apply only: ${r.config.eligibleOutcomes.join(", ") || "nothing"} (eligibility=${r.config.eligibility}).`, "");

  for (const [title, part] of [["Explicit human decisions only (headline)", r.explicit], ["Including implicit agreement", r.withImplicit]] as const) {
    const ja = part.jevAlone;
    L.push(`## ${title}`, "", "### Jev alone", "");
    L.push(`Auto-applied ${ja.autoApplied}; scored ${ja.autoScored}; agreed ${ja.autoAgreed}; wrong ${ja.autoWrong}; agreement ${pct(ja.autoAgreement)}. Held for a human ${ja.heldForHuman} (${Object.entries(ja.holdReasons).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}).`, "");
    if (part.cascade.length) {
      L.push("### Cascade: Luna asked only about Jev's holds", "", "`wrong` is the key risk: Luna's call would have been applied, it disagrees with the human, and Jev alone would have sent it to a human.", "");
      L.push("| Luna min confidence | resolved of holds | resolved + human-decided | agreed | wrong (key risk) | agreement | Jev's own label right on same set | still to human | resolved, no truth |", "|---|---|---|---|---|---|---|---|---|");
      for (const c of part.cascade) {
        L.push(`| ${c.cutoff === null ? "none" : c.cutoff.toFixed(2)} | ${c.resolved}/${c.scopeHolds} | ${c.resolvedWithTruth} | ${c.agreed} | ${c.wrong} | ${pct(rate(c.agreed, c.resolvedWithTruth))} | ${c.jevAgreedOnResolved} | ${c.remainingHuman} | ${c.noTruth} |`);
      }
      L.push("", "Per applied outcome (resolved / human-decided / agreed / wrong):", "");
      L.push("| Luna outcome | " + SHOW_CUTOFFS.map((c) => c.toFixed(2)).join(" | ") + " |", "|---|" + SHOW_CUTOFFS.map(() => "---").join("|") + "|");
      const outs = [...new Set(part.cascade.flatMap((c) => Object.keys(c.byOutcome)))].sort();
      for (const o of outs) {
        L.push(`| ${o} | ` + SHOW_CUTOFFS.map((cut) => {
          const b = part.cascade.find((c) => c.cutoff === cut)?.byOutcome[o];
          return b ? `${b.resolved} / ${b.resolvedWithTruth} / ${b.agreed} / ${b.wrong}` : "0";
        }).join(" | ") + " |");
      }
      L.push("");
    }
    if (part.headToHead) {
      for (const [name, m] of [["Jev", part.headToHead.jev], ["Luna", part.headToHead.luna]] as const) {
        L.push(`### Head-to-head: ${name} (n=${m.n}, agreement ${pct(m.agreement)})`, "", "| outcome | predicted | actual | precision | recall |", "|---|---|---|---|---|");
        for (const [k, v] of Object.entries(m.perOutcome)) L.push(`| ${k} | ${v.predicted} | ${v.actual} | ${pct(v.precision)} | ${pct(v.recall)} |`);
        const labels = [...new Set(Object.entries(m.confusion).flatMap(([t, row]) => [t, ...Object.keys(row)]))].sort();
        L.push("", `Confusion (rows = human, columns = ${name}):`, "", "| human \\ pred | " + labels.join(" | ") + " |", "|---|" + labels.map(() => "---").join("|") + "|");
        for (const t of labels) L.push(`| ${t} | ` + labels.map((p) => m.confusion[t]?.[p] ?? 0).join(" | ") + " |");
        L.push("", `Agreement at confidence cutoff (${name}):`, "", "| cutoff | n | agreed | agreement | coverage |", "|---|---|---|---|---|");
        for (const a of m.atCutoffs) L.push(`| ${a.cutoff.toFixed(2)} | ${a.n} | ${a.agreed} | ${pct(a.agreement)} | ${pct(a.coverage)} |`);
        L.push("");
      }
    }
  }
  const c = r.cost;
  L.push("## Cost and latency", "", `- Luna (${r.config.lunaModel ?? "not run"}): ${c.luna.calls} calls (${c.luna.errors} errors), ${c.luna.inputTokens} in / ${c.luna.outputTokens} out tokens, total ${usd(c.luna.totalUsd)}, per call ${usd(c.luna.perCallUsd)}; latency p50 ${ms(c.luna.latencyMs.p50)}, p95 ${ms(c.luna.latencyMs.p95)}, mean ${ms(c.luna.latencyMs.mean)}`);
  L.push(`- Jev: ${c.jev.calls} calls, ${c.jev.tokens} tokens; latency p50 ${ms(c.jev.latencyMs.p50)}, p95 ${ms(c.jev.latencyMs.p95)}. ${c.jev.note}`, "");
  const shown = r.disagreements.slice(0, 200);
  L.push(`## Disagreements for spot review (${r.disagreements.length}; first ${shown.length} shown, all in the JSON)`, "", "Cascade-wrong cases at Luna >= 0.90 are listed first.", "");
  L.push("| id | text (masked) | human | Jev | Luna | cascade wrong @0.90 |", "|---|---|---|---|---|---|");
  const cell = (p: { label: string; confidence: number | null } | null) => (p ? `${p.label} ${p.confidence === null ? "?" : p.confidence.toFixed(2)}` : "-");
  for (const d of shown) L.push(`| ${d.id.slice(0, 8)} | ${d.text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200)} | ${d.human} (${d.humanKind}) | ${cell(d.jev)} (${d.jevDecision.reason}) | ${d.lunaError ? `error: ${d.lunaError}` : cell(d.luna)} | ${d.cascadeWrongAt90 ? "YES" : ""} |`);
  L.push("");
  return L.join("\n");
}
