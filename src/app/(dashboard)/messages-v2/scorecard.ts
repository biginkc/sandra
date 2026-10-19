/**
 * Reads fn_messages_v2_scorecard for the header's one-line week summary.
 * (PR 4: the scorecard card, threshold suggestions and Luna stats were removed
 * from the page; only the read the header uses remains.)
 */

/**
 * [native confidence 0..1, agreed 1 | 0, route]. Route is "a" (auto-applied,
 * settled) or "h" (held, then human-decided); absent on legacy payloads.
 */
export type Sample = [number, 0 | 1] | [number, 0 | 1, "a" | "h"];

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
    const route = s[2];
    out.push(route === "a" || route === "h" ? [c, a, route] : [c, a]);
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

/** One row of fn_luna_suggestion_stats, numbers coerced. */
