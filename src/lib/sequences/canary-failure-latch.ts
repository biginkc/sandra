const API = "https://api.github.com/repos/biginkc/sandra";
const WORKFLOW = "canary-sequences.yml";
const FULL_TITLE = "Sequences V1 Prod Canary full";
const PREFLIGHT_TITLE = "Sequences V1 Prod Canary preflight-only";
const FULL_JOB = "Sequences V1 Prod Canary";

type WorkflowRun = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  display_title?: string;
};

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
    for (let page = 1; page <= 100; page++) {
      const url = `${API}/actions/workflows/${WORKFLOW}/runs?status=completed&per_page=100&page=${page}`;
      const body = await githubJson(url, token) as { workflow_runs?: WorkflowRun[]; total_count?: number };
      const totalCount = body.total_count;
      if (!Array.isArray(body.workflow_runs) || totalCount === undefined || !Number.isSafeInteger(totalCount)) {
        throw new Error("Invalid workflow history");
      }
      for (const run of body.workflow_runs) {
        if (String(run.id) === currentRunId) continue;
        if (run.status !== "completed" || !Number.isSafeInteger(run.id)) throw new Error("Ambiguous run");
        if (run.event === "workflow_dispatch" && run.display_title === PREFLIGHT_TITLE) continue;
        if (run.event !== "schedule" && !(run.event === "workflow_dispatch" && run.display_title === FULL_TITLE)) {
          const ack = await githubJson(`${API}/actions/variables/SEQUENCE_CANARY_FAILURE_ACK_RUN_ID`, token) as { value?: string };
          if (ack.value === String(run.id)) return;
          throw new Error(`Canary prior full run ${run.id} is not acknowledged (ambiguous mode)`);
        }
        if (run.event === "schedule" && run.conclusion === "skipped" && await fullJobWasSkipped(run.id, token)) continue;
        if (run.conclusion === "success") return;
        const ack = await githubJson(`${API}/actions/variables/SEQUENCE_CANARY_FAILURE_ACK_RUN_ID`, token) as { value?: string };
        if (ack.value === String(run.id)) return;
        throw new Error(`Canary prior full run ${run.id} is not acknowledged`);
      }
      if (page * 100 >= totalCount) return;
    }
    throw new Error("Workflow history exceeds search limit");
  } catch (error) {
    if (error instanceof Error && error.message.includes("not acknowledged")) throw error;
    throw new Error("Canary history unavailable or ambiguous");
  }
}
