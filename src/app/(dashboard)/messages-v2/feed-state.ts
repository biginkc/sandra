import { MAX_RUNS } from "./queries";
import type { PipelineRun, PipelineRunStep, RunWithSteps } from "./types";

const byStartedDesc = (a: PipelineRun, b: PipelineRun) =>
  Date.parse(b.started_at) - Date.parse(a.started_at);

/** Merge a streamed run row (INSERT or UPDATE) into the newest-first list. */
export function upsertRun(
  runs: readonly RunWithSteps[],
  incoming: PipelineRun,
): RunWithSteps[] {
  const existing = runs.find((r) => r.id === incoming.id);
  const next = existing
    ? runs.map((r) =>
        r.id === incoming.id ? { ...r, ...incoming, steps: r.steps } : r,
      )
    : [{ ...incoming, steps: [] as PipelineRunStep[] }, ...runs];
  return next.sort(byStartedDesc).slice(0, MAX_RUNS);
}

/**
 * Append a streamed step to its run's card. `unknownRun` is true when the
 * run is not in memory so the caller can fall back to a throttled refresh.
 */
export function appendStep(
  runs: readonly RunWithSteps[],
  step: PipelineRunStep,
): { runs: RunWithSteps[]; unknownRun: boolean } {
  if (!runs.some((r) => r.id === step.run_id)) {
    return { runs: [...runs], unknownRun: true };
  }
  return {
    unknownRun: false,
    runs: runs.map((r) => {
      if (r.id !== step.run_id) return r;
      if (r.steps.some((s) => s.id === step.id)) return r;
      return { ...r, steps: [...r.steps, step].sort((a, b) => a.seq - b.seq) };
    }),
  };
}
