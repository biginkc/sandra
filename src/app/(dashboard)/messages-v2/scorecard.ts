/**
 * Pure aggregation for the Messages v2 shadow scorecard. The SQL function
 * fn_messages_v2_scorecard does the joins; everything here is display math.
 * Nothing in this module writes thresholds or flags: the suggestion is text
 * for a human to approve.
 */

export const SCORECARD_OUTCOMES = [
  "new_lead",
  "wrong_number",
  "not_interested",
  "nurture",
  "opted_out",
] as const;
export type ScorecardOutcome = (typeof SCORECARD_OUTCOMES)[number];

/** [native confidence 0..1, agreed 1 | 0] */
export type Sample = [number, 0 | 1];

/** One row of fn_messages_v2_scorecard, with numbers coerced. */
export type ScorecardRow = {
  outcome: string;
  runs: number;
  auto_applied: number;
  held: number;
  auto_settled: number;
  auto_agreed: number;
  held_decided: number;
  held_agreed: number;
  threshold: number | null;
  automation_enabled: boolean | null;
  samples: Sample[];
};

export const MIN_SUGGESTION_SAMPLES = 30;
/** Target tail agreement, as an integer percent (avoids float edge cases). */
export const TARGET_AGREEMENT_PERCENT = 95;

export type Suggestion =
  | { kind: "insufficient"; samples: number }
  | { kind: "none"; samples: number }
  | { kind: "suggested"; threshold: number; samples: number; agreement: number };

export type OutcomeScorecard = {
  outcome: ScorecardOutcome;
  runs: number;
  autoApplied: number;
  held: number;
  autoSettled: number;
  autoAgreed: number;
  heldDecided: number;
  heldAgreed: number;
  autoAgreementRate: number | null;
  heldAgreementRate: number | null;
  threshold: number | null;
  automationEnabled: boolean | null;
  suggestion: Suggestion;
};

const ceil3 = (x: number) => Math.ceil(x * 1000 - 1e-9) / 1000;

/**
 * Lowest cutoff x (3 decimals, rounded UP so the rule text is exactly what was
 * evaluated) such that samples with confidence >= x number at least 30 and
 * agree at least 95% of the time. "insufficient" under 30 samples overall;
 * "none" when there is enough data but no cutoff reaches the target.
 */
export function suggestThreshold(samples: readonly Sample[]): Suggestion {
  const valid = samples
    .filter(([c]) => Number.isFinite(c) && c >= 0 && c <= 1)
    .sort((a, b) => a[0] - b[0]);
  if (valid.length < MIN_SUGGESTION_SAMPLES) {
    return { kind: "insufficient", samples: valid.length };
  }

  // suffixAgreed[i] = agreements among valid[i..]
  const suffixAgreed = new Array<number>(valid.length + 1).fill(0);
  for (let i = valid.length - 1; i >= 0; i--) {
    suffixAgreed[i] = suffixAgreed[i + 1] + valid[i][1];
  }

  const candidates = [...new Set(valid.map(([c]) => ceil3(c)))].sort(
    (a, b) => a - b,
  );
  let start = 0;
  for (const cand of candidates) {
    while (start < valid.length && valid[start][0] < cand) start++;
    const n = valid.length - start;
    if (n < MIN_SUGGESTION_SAMPLES) break; // tails only shrink from here
    const agreed = suffixAgreed[start];
    if (agreed * 100 >= n * TARGET_AGREEMENT_PERCENT) {
      return { kind: "suggested", threshold: cand, samples: n, agreement: agreed / n };
    }
  }
  return { kind: "none", samples: valid.length };
}

/** The exact rule text copied for approval. Nothing is applied by copying. */
export function formatRuleText(outcome: string, threshold: number): string {
  return `${outcome}: auto-apply at native confidence ≥ ${ceil3(threshold).toFixed(3)}`;
}

const rate = (num: number, den: number) => (den > 0 ? num / den : null);

export function buildScorecard(rows: readonly ScorecardRow[]): OutcomeScorecard[] {
  const byOutcome = new Map(rows.map((r) => [r.outcome, r]));
  return SCORECARD_OUTCOMES.map((outcome) => {
    const r = byOutcome.get(outcome);
    return {
      outcome,
      runs: r?.runs ?? 0,
      autoApplied: r?.auto_applied ?? 0,
      held: r?.held ?? 0,
      autoSettled: r?.auto_settled ?? 0,
      autoAgreed: r?.auto_agreed ?? 0,
      heldDecided: r?.held_decided ?? 0,
      heldAgreed: r?.held_agreed ?? 0,
      autoAgreementRate: rate(r?.auto_agreed ?? 0, r?.auto_settled ?? 0),
      heldAgreementRate: rate(r?.held_agreed ?? 0, r?.held_decided ?? 0),
      threshold: r?.threshold ?? null,
      automationEnabled: r?.automation_enabled ?? null,
      suggestion: suggestThreshold(r?.samples ?? []),
    };
  });
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

function parseSamples(v: unknown): Sample[] {
  if (!Array.isArray(v)) return [];
  const out: Sample[] = [];
  for (const s of v) {
    if (!Array.isArray(s) || s.length < 2) continue;
    const [c, a] = s;
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    if (a !== 0 && a !== 1) continue;
    out.push([c, a]);
  }
  return out;
}

/** Coerces the RPC payload (bigint strings, numerics as strings) defensively. */
export function parseScorecardRows(data: unknown): ScorecardRow[] {
  if (!Array.isArray(data)) return [];
  return data
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      outcome: String(r.outcome ?? ""),
      runs: num(r.runs),
      auto_applied: num(r.auto_applied),
      held: num(r.held),
      auto_settled: num(r.auto_settled),
      auto_agreed: num(r.auto_agreed),
      held_decided: num(r.held_decided),
      held_agreed: num(r.held_agreed),
      threshold: r.threshold == null ? null : num(r.threshold),
      automation_enabled:
        typeof r.automation_enabled === "boolean" ? r.automation_enabled : null,
      samples: parseSamples(r.samples),
    }));
}

export type ScorecardWindow = 7 | 30;

export type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/** Loads and parses the scorecard rows; throws on an RPC error. */
export async function fetchScorecardRows(
  supabase: RpcClient,
  orgId: string,
  windowDays: ScorecardWindow,
): Promise<ScorecardRow[]> {
  const { data, error } = await supabase.rpc("fn_messages_v2_scorecard", {
    p_org_id: orgId,
    p_window_days: windowDays,
  });
  if (error) throw new Error(error.message);
  return parseScorecardRows(data);
}
