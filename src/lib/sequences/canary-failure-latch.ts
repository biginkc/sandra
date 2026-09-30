const API = "https://api.github.com/repos/biginkc/sandra";
const WORKFLOW = "canary-sequences.yml";
const FULL_TITLE = "Sequences V1 Prod Canary full";
const PREFLIGHT_TITLE = "Sequences V1 Prod Canary preflight-only";
const FULL_JOB = "Sequences V1 Prod Canary";

type WorkflowRun = {
  id: number;
  run_number: number;
  run_attempt: number;
  created_at?: string;
  event: string;
  status: string;
  conclusion: string | null;
  display_title?: string;
};

async function earlierAttemptFailed(run: WorkflowRun, token: string): Promise<boolean> {
  // https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt
  for (let attempt = 1; attempt < run.run_attempt; attempt++) {
    const previous = await githubJson(`${API}/actions/runs/${run.id}/attempts/${attempt}`, token) as {
      id?: number; run_attempt?: number; status?: string; conclusion?: string | null;
    };
    if (previous.id !== run.id || previous.run_attempt !== attempt || previous.status !== "completed" ||
      typeof previous.conclusion !== "string") throw new Error("Ambiguous run attempt");
    if (previous.conclusion !== "success") return true;
  }
  return false;
}

async function githubJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    cache: "no-store", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("GitHub read failed");
  return response.json();
}

async function fullJobWasSkipped(runId: number, token: string): Promise<boolean> {
  const body = await githubJson(`${API}/actions/runs/${runId}/jobs?per_page=100`, token) as {
    total_count?: number;
    jobs?: { name?: string; status?: string; conclusion?: string | null; started_at?: string | null }[];
  };
  if (!Array.isArray(body.jobs) || body.total_count !== 1 || body.jobs.length !== 1) {
    throw new Error("Ambiguous full job history");
  }
  const job = body.jobs[0];
  return job.name === FULL_JOB && job.status === "completed" &&
    job.conclusion === "skipped" && job.started_at === null;
}

/** Read only. Unknown run metadata is ambiguous and stops the canary. */
export async function assertNoUnacknowledgedCanaryFailure(currentRunId: string, token: string): Promise<void> {
  if (!/^\d+$/.test(currentRunId) || !token) throw new Error("Canary history unavailable");
  try {
    const runs: WorkflowRun[] = [];
    let expectedCount: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const url = `${API}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=${page}`;
      const body = await githubJson(url, token) as { workflow_runs?: WorkflowRun[]; total_count?: number };
      const totalCount = body.total_count;
      if (!Array.isArray(body.workflow_runs) || totalCount === undefined || !Number.isSafeInteger(totalCount) ||
        totalCount < 0 || totalCount > 10_000 ||
        (expectedCount !== undefined && totalCount !== expectedCount) ||
        runs.length + body.workflow_runs.length > totalCount ||
        (page * 100 < totalCount && body.workflow_runs.length !== 100)) {
        throw new Error("Invalid workflow history");
      }
      expectedCount = totalCount;
      runs.push(...body.workflow_runs);
      if (runs.length === totalCount) break;
      if (page === 100) throw new Error("Workflow history exceeds search limit");
    }
    const priorRuns = runs.filter(run => String(run.id) !== currentRunId);
    if (new Set(priorRuns.map(run => run.id)).size !== priorRuns.length ||
      new Set(priorRuns.map(run => run.run_number)).size !== priorRuns.length || priorRuns.some(run =>
      !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_number) || run.run_number < 1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      !["queued", "in_progress", "waiting", "requested", "completed"].includes(run.status))) {
      throw new Error("Ambiguous run");
    }
    priorRuns.sort((a, b) => b.run_number - a.run_number ||
      (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0));
    for (const run of priorRuns) {
      if (run.event === "workflow_dispatch" && run.display_title === PREFLIGHT_TITLE) continue;
      if (run.status !== "completed") throw new Error(`Canary prior full run unresolved: ${run.id}`);
      const ambiguousMode = run.event !== "schedule" &&
        !(run.event === "workflow_dispatch" && run.display_title === FULL_TITLE);
      if (run.event === "schedule" && run.conclusion === "skipped" && await fullJobWasSkipped(run.id, token)) continue;
      if (!ambiguousMode && run.conclusion === "success" && !await earlierAttemptFailed(run, token)) return;
      const ack = await githubJson(`${API}/actions/variables/SEQUENCE_CANARY_FAILURE_ACK_RUN_ID`, token) as { value?: string };
      if (ack.value === String(run.id)) return;
      throw new Error(`Canary prior full run ${run.id} is not acknowledged${ambiguousMode ? " (ambiguous mode)" : ""}`);
    }
  } catch (error) {
    if (error instanceof Error && (/not acknowledged|prior full run unresolved/.test(error.message))) throw error;
    throw new Error("Canary history unavailable or ambiguous");
  }
}
