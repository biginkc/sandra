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
    if (previous.conclusion === "success") continue;
    if (run.event === "schedule" && previous.conclusion === "skipped" &&
      await fullJobWasSkipped(run, token, attempt)) continue;
    return true;
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

async function fullJobWasSkipped(run: WorkflowRun, token: string, attempt: number): Promise<boolean> {
  // Per-attempt jobs: https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt
  const path = `${API}/actions/runs/${run.id}/attempts/${attempt}/jobs`;
  const body = await githubJson(`${path}?per_page=100`, token) as {
    total_count?: number;
    jobs?: { name?: string; status?: string; conclusion?: string | null; started_at?: string | null }[];
  };
  if (!Array.isArray(body.jobs) || body.total_count !== 1 || body.jobs.length !== 1) {
    throw new Error("Ambiguous full job history");
  }
  const refreshed = await githubJson(`${API}/actions/runs/${run.id}`, token) as WorkflowRun;
  if (refreshed.id !== run.id || refreshed.run_attempt !== run.run_attempt || refreshed.status !== run.status) {
    throw new Error("Ambiguous run attempt");
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
    let newestRunNumber: number | undefined;
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
      if (page === 1) newestRunNumber = body.workflow_runs[0]?.run_number;
      runs.push(...body.workflow_runs);
      if (runs.length === totalCount) break;
      if (page === 100) throw new Error("Workflow history exceeds search limit");
    }
    const firstPageAgain = await githubJson(`${API}/actions/workflows/${WORKFLOW}/runs?per_page=100&page=1`, token) as {
      workflow_runs?: WorkflowRun[]; total_count?: number;
    };
    if (!Array.isArray(firstPageAgain.workflow_runs) || firstPageAgain.total_count !== expectedCount ||
      firstPageAgain.workflow_runs[0]?.run_number !== newestRunNumber) {
      throw new Error("Workflow history changed while paging");
    }
    const priorRuns = runs.filter(run => String(run.id) !== currentRunId);
    if (new Set(priorRuns.map(run => run.id)).size !== priorRuns.length ||
      new Set(priorRuns.map(run => run.run_number)).size !== priorRuns.length || priorRuns.some(run =>
      !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_number) || run.run_number < 1 ||
      !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1)) {
      throw new Error("Ambiguous run");
    }
    priorRuns.sort((a, b) => b.run_number - a.run_number ||
      (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0));
    const failures: { id: number; ambiguousMode: boolean }[] = [];
    for (const run of priorRuns) {
      if (run.event === "workflow_dispatch" && run.display_title === PREFLIGHT_TITLE) continue;
      if (run.status !== "completed") throw new Error(`Canary prior full run unresolved: ${run.id}`);
      const ambiguousMode = run.event !== "schedule" &&
        !(run.event === "workflow_dispatch" && run.display_title === FULL_TITLE);
      const earlierFailed = await earlierAttemptFailed(run, token);
      if (!earlierFailed && run.event === "schedule" && run.conclusion === "skipped" &&
        await fullJobWasSkipped(run, token, run.run_attempt)) continue;
      if (!ambiguousMode && run.conclusion === "success" && !earlierFailed) break;
      failures.push({ id: run.id, ambiguousMode });
    }
    if (failures.length > 0) {
      const ack = await githubJson(`${API}/actions/variables/SEQUENCE_CANARY_FAILURE_ACK_RUN_ID`, token) as { value?: string };
      const acknowledged = new Set((ack.value ?? "").split(",").map(id => id.trim()).filter(id => /^\d+$/.test(id)));
      const missing = failures.find(failure => !acknowledged.has(String(failure.id)));
      if (missing) throw new Error(`Canary prior full run ${missing.id} is not acknowledged${missing.ambiguousMode ? " (ambiguous mode)" : ""}`);
    }
  } catch (error) {
    if (error instanceof Error && (/not acknowledged|prior full run unresolved/.test(error.message))) throw error;
    throw new Error("Canary history unavailable or ambiguous");
  }
}
