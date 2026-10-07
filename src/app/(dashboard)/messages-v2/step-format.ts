import type { PipelineRunStep } from "./types";

export type JevScore = { label: string; pct: number };

function toPct(value: number): number {
  return Math.round(value <= 1 ? value * 100 : value);
}

/**
 * Read Jev outcome confidences from a jev step's detail. Accepted shapes
 * (the writer owns the real one, see report): `scores: {label: n}`,
 * `top: [{outcome|label, confidence|score}]`, or `outcome` + `confidence`.
 * Values are 0..1 (or 0..100). Returns the top `limit`, highest first.
 */
export function readJevScores(
  detail: Record<string, unknown> | null,
  limit = 3,
): JevScore[] {
  if (!detail) return [];
  const out: JevScore[] = [];
  // The bridge writes Jev's full distribution as `probabilities`
  // (src/lib/sms-classification/dispatch-bridge.ts, "classify" step).
  const scores = detail.probabilities ?? detail.scores;
  if (scores && typeof scores === "object" && !Array.isArray(scores)) {
    for (const [label, v] of Object.entries(
      scores as Record<string, unknown>,
    )) {
      if (typeof v === "number") out.push({ label, pct: toPct(v) });
    }
  } else if (Array.isArray(detail.top)) {
    for (const item of detail.top as Array<Record<string, unknown>>) {
      const label = item.outcome ?? item.label;
      const v = item.confidence ?? item.score;
      if (typeof label === "string" && typeof v === "number")
        out.push({ label, pct: toPct(v) });
    }
  } else if (
    typeof detail.outcome === "string" &&
    typeof detail.confidence === "number"
  ) {
    out.push({ label: detail.outcome, pct: toPct(detail.confidence) });
  }
  return out.sort((a, b) => b.pct - a.pct).slice(0, limit);
}

export function replyPersona(step: PipelineRunStep): string | null {
  const d = step.detail ?? {};
  for (const key of ["persona", "sender_name", "as"]) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Best short human reason for why a run/step was held. */
export function holdReason(
  steps: readonly PipelineRunStep[],
  runReason: string | null,
): string | null {
  const step = [...steps].reverse().find((s) => s.kind === "hold");
  if (step) {
    const r = step.detail?.reason;
    return typeof r === "string" && r ? `${step.name}: ${r}` : step.name;
  }
  return runReason;
}
