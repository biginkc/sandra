/** Pure scoring math for the Jev vs Luna comparison. No I/O. */

export type Pred = { label: string; confidence: number | null };
export type Row = {
  id: string;
  text: string;
  truth: { label: string; kind: "explicit" | "implicit" } | null;
  jev: Pred | null; // null = Jev errored
  jevDecision: { status: "auto_apply" | "hold"; reason: string }; // reason: needs_decision | dnc | ... | jev_error
  luna: Pred | null; // null = not run, or errored
  lunaErrored: boolean;
};

export const CUTOFFS = Array.from({ length: 20 }, (_, i) => Math.round((0.8 + i * 0.01) * 100) / 100);
const rate = (n: number, d: number) => (d === 0 ? null : n / d);

export type TruthFilter = { includeImplicit: boolean };
const hasTruth = (r: Row, f: TruthFilter) => r.truth !== null && (f.includeImplicit || r.truth.kind === "explicit");

export type ModelStats = {
  n: number; // rows with truth and a prediction
  agreed: number;
  agreement: number | null;
  perOutcome: Record<string, { predicted: number; actual: number; truePositive: number; precision: number | null; recall: number | null }>;
  confusion: Record<string, Record<string, number>>; // truth -> predicted -> count
};

export function modelStats(rows: Row[], pick: (r: Row) => Pred | null, f: TruthFilter): ModelStats {
  const scored = rows.filter((r) => hasTruth(r, f) && pick(r));
  const labels = new Set<string>();
  const confusion: ModelStats["confusion"] = {};
  let agreed = 0;
  for (const r of scored) {
    const truth = r.truth!.label, pred = pick(r)!.label;
    labels.add(truth); labels.add(pred);
    (confusion[truth] ??= {})[pred] = (confusion[truth][pred] ?? 0) + 1;
    if (truth === pred) agreed++;
  }
  const perOutcome: ModelStats["perOutcome"] = {};
  for (const l of [...labels].sort()) {
    const predicted = scored.filter((r) => pick(r)!.label === l).length;
    const actual = scored.filter((r) => r.truth!.label === l).length;
    const tp = scored.filter((r) => r.truth!.label === l && pick(r)!.label === l).length;
    perOutcome[l] = { predicted, actual, truePositive: tp, precision: rate(tp, predicted), recall: rate(tp, actual) };
  }
  return { n: scored.length, agreed, agreement: rate(agreed, scored.length), perOutcome, confusion };
}

/** Agreement among predictions at or above each confidence cutoff. */
export function agreementAtCutoffs(rows: Row[], pick: (r: Row) => Pred | null, f: TruthFilter, cutoffs: readonly number[] = CUTOFFS) {
  const scored = rows.filter((r) => hasTruth(r, f) && pick(r) && pick(r)!.confidence !== null);
  return cutoffs.map((c) => {
    const at = scored.filter((r) => pick(r)!.confidence! >= c);
    const agreed = at.filter((r) => pick(r)!.label === r.truth!.label).length;
    return { cutoff: c, n: at.length, agreed, agreement: rate(agreed, at.length), coverage: rate(at.length, scored.length) };
  });
}

export type CascadeOptions = {
  /** Outcomes Luna may auto-apply (the ones Jev policy would auto-apply for this org). Empty set = nothing eligible. */
  eligible: ReadonlySet<string>;
  /** below_threshold: only Jev holds caused by confidence under the per-outcome threshold. all_holds: every hold. */
  scope: "below_threshold" | "all_holds";
  includeImplicit: boolean;
};

export type CascadeBucket = {
  resolved: number; // holds Luna would resolve (applied)
  resolvedWithTruth: number;
  agreed: number;
  wrong: number; // KEY RISK: applied label differs from the human's; Jev-alone would have sent these to a human
  jevAgreedOnResolved: number; // of resolvedWithTruth, how often Jev's own (below-threshold) label matched the human
  noTruth: number; // resolved but no human decision to score against
};

export type CascadeRow = CascadeBucket & { cutoff: number | null; scopeHolds: number; remainingHuman: number; byOutcome: Record<string, CascadeBucket> };

const emptyBucket = (): CascadeBucket => ({ resolved: 0, resolvedWithTruth: 0, agreed: 0, wrong: 0, jevAgreedOnResolved: 0, noTruth: 0 });

export function inCascadeScope(r: Row, scope: CascadeOptions["scope"]): boolean {
  if (r.jevDecision.status !== "hold") return false;
  return scope === "all_holds" ? true : r.jevDecision.reason === "needs_decision";
}

/** Would Luna's call be applied at this cutoff? (null cutoff = no confidence requirement.) */
export function lunaApplies(r: Row, cutoff: number | null, o: CascadeOptions): boolean {
  if (!r.luna || r.luna.confidence === null) return false;
  if (cutoff !== null && r.luna.confidence < cutoff) return false;
  return o.eligible.has(r.luna.label);
}

export function cascadeAtCutoff(rows: Row[], cutoff: number | null, o: CascadeOptions): CascadeRow {
  const holds = rows.filter((r) => inCascadeScope(r, o.scope));
  const total = emptyBucket();
  const byOutcome: Record<string, CascadeBucket> = {};
  for (const r of holds) {
    if (!lunaApplies(r, cutoff, o)) continue;
    const label = r.luna!.label;
    const b = (byOutcome[label] ??= emptyBucket());
    for (const x of [total, b]) {
      x.resolved++;
      if (!hasTruth(r, { includeImplicit: o.includeImplicit })) { x.noTruth++; continue; }
      x.resolvedWithTruth++;
      if (label === r.truth!.label) x.agreed++; else x.wrong++;
      if (r.jev && r.jev.label === r.truth!.label) x.jevAgreedOnResolved++;
    }
  }
  return { cutoff, scopeHolds: holds.length, remainingHuman: holds.length - total.resolved, ...total, byOutcome };
}

/** Jev on its own: above-threshold calls auto-applied, the rest go to a human (who is right by definition). */
export function jevAlone(rows: Row[], f: TruthFilter) {
  const auto = rows.filter((r) => r.jevDecision.status === "auto_apply");
  const holds = rows.filter((r) => r.jevDecision.status === "hold");
  const autoScored = auto.filter((r) => hasTruth(r, f));
  const agreed = autoScored.filter((r) => r.jev!.label === r.truth!.label).length;
  const holdReasons: Record<string, number> = {};
  for (const r of holds) holdReasons[r.jevDecision.reason] = (holdReasons[r.jevDecision.reason] ?? 0) + 1;
  return {
    messages: rows.length,
    autoApplied: auto.length,
    autoScored: autoScored.length,
    autoAgreed: agreed,
    autoWrong: autoScored.length - agreed,
    autoAgreement: rate(agreed, autoScored.length),
    heldForHuman: holds.length,
    holdReasons,
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export { rate };
