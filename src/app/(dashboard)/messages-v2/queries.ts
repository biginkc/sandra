import type {
  HeaderStats,
  ModeBadge,
  PipelineRun,
  PipelineRunStep,
  RunWithSteps,
} from "./types";

export const MAX_RUNS = 200;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Held / escalated runs that nobody has followed up on, oldest first. A hold
 * is "open" until a later run exists on the same conversation (the seller
 * texted again, or a human acted and the pipeline re-ran). Runs without a
 * conversation id cannot be superseded.
 */
export function deriveOpenHolds<T extends PipelineRun>(runs: readonly T[]): T[] {
  const latestByConversation = new Map<string, number>();
  for (const run of runs) {
    if (!run.conversation_id) continue;
    const t = Date.parse(run.started_at);
    const prev = latestByConversation.get(run.conversation_id);
    if (prev === undefined || t > prev) latestByConversation.set(run.conversation_id, t);
  }
  return runs
    .filter((run) => {
      if (run.status !== "held" && run.status !== "escalated") return false;
      if (!run.conversation_id) return true;
      return latestByConversation.get(run.conversation_id) === Date.parse(run.started_at);
    })
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
}

export function computeHeaderStats(
  runs: readonly PipelineRun[],
  nowMs: number,
): HeaderStats {
  const cutoff = nowMs - HOUR_MS;
  return {
    runsLastHour: runs.filter((r) => Date.parse(r.started_at) >= cutoff).length,
    openHolds: deriveOpenHolds(runs).length,
  };
}

export function buildModeBadges(
  config: { classifier_provider: string; classifier_mode: string } | null,
  thresholds: ReadonlyArray<{ outcome: string }>,
): ModeBadge[] {
  const mode: ModeBadge["mode"] =
    config?.classifier_provider === "jev"
      ? config.classifier_mode === "automatic"
        ? "AUTO"
        : "SHADOW"
      : "LEGACY";
  return thresholds.map((t) => ({ label: t.outcome, mode }));
}

export function groupStepsByRun(
  steps: readonly PipelineRunStep[],
): Map<string, PipelineRunStep[]> {
  const grouped = new Map<string, PipelineRunStep[]>();
  for (const step of steps) {
    const list = grouped.get(step.run_id) ?? [];
    list.push(step);
    grouped.set(step.run_id, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq);
  return grouped;
}

// pipeline_runs is not in the generated Database type yet; a loose client keeps
// this page independent of types.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type LooseSupabase = { from(table: string): any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type MessagesV2Data = {
  runs: RunWithSteps[];
  holds: RunWithSteps[];
  stats: HeaderStats;
  badges: ModeBadge[];
  nowMs: number;
};

/**
 * Server loader. Every query is org-scoped explicitly (RLS also applies).
 * Holds come from the newest-200 window plus a separate held/escalated
 * query so an old unanswered hold does not fall off the page. Known limit:
 * a superseding run older than the window start is not seen.
 */
export async function loadMessagesV2Data(
  supabase: LooseSupabase,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<MessagesV2Data> {
  const [windowRes, holdRes, configRes, thresholdRes] = await Promise.all([
    supabase
      .from("pipeline_runs")
      .select("*")
      .eq("org_id", orgId)
      .order("started_at", { ascending: false })
      .limit(MAX_RUNS),
    supabase
      .from("pipeline_runs")
      .select("*")
      .eq("org_id", orgId)
      .in("status", ["held", "escalated"])
      .order("started_at", { ascending: false })
      .limit(MAX_RUNS),
    supabase
      .from("ai_responder_configs")
      .select("classifier_provider, classifier_mode")
      .eq("org_id", orgId)
      .eq("active", true)
      .limit(1),
    supabase
      .from("jev_outcome_thresholds")
      .select("outcome")
      .eq("org_id", orgId)
      .order("outcome", { ascending: true }),
  ]);

  const windowRuns = (windowRes.data ?? []) as PipelineRun[];
  const holdRuns = (holdRes.data ?? []) as PipelineRun[];
  const pool = new Map<string, PipelineRun>();
  for (const run of [...windowRuns, ...holdRuns]) pool.set(run.id, run);
  const poolRuns = [...pool.values()];

  let stepsByRun = new Map<string, PipelineRunStep[]>();
  if (poolRuns.length > 0) {
    const oldest = poolRuns.reduce(
      (min, r) => (Date.parse(r.started_at) < Date.parse(min) ? r.started_at : min),
      poolRuns[0].started_at,
    );
    const stepsRes = await supabase
      .from("pipeline_run_steps")
      .select("*")
      .eq("org_id", orgId)
      .gte("created_at", oldest)
      .order("created_at", { ascending: true })
      .limit(5000);
    stepsByRun = groupStepsByRun((stepsRes.data ?? []) as PipelineRunStep[]);
  }
  const withSteps = (run: PipelineRun): RunWithSteps => ({
    ...run,
    steps: stepsByRun.get(run.id) ?? [],
  });

  const configRow = (configRes.data ?? [])[0] ?? null;
  return {
    runs: windowRuns.map(withSteps),
    holds: deriveOpenHolds(poolRuns).map(withSteps),
    stats: computeHeaderStats(poolRuns, nowMs),
    badges: buildModeBadges(configRow, (thresholdRes.data ?? []) as Array<{ outcome: string }>),
    nowMs,
  };
}
