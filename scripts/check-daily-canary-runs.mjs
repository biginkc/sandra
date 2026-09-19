import { pathToFileURL } from "node:url";

export const DAILY_BROWSER_WORKFLOWS = [
  "canary-leads-browser.yml",
  "canary-messages-browser.yml",
];

export function previousUtcDate(now = new Date()) {
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1,
  ));
  return yesterday.toISOString().slice(0, 10);
}

export function evaluateDailyRun(workflow, date, runs) {
  const matching = runs
    .filter((run) =>
      run.event === "schedule" &&
      run.head_branch === "main" &&
      typeof run.created_at === "string" &&
      run.created_at.slice(0, 10) === date,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const run = matching[0];
  if (!run) {
    return { workflow, date, status: "MISSING", url: null };
  }
  if (run.status !== "completed") {
    return { workflow, date, status: "INCOMPLETE", url: run.html_url ?? null };
  }
  return {
    workflow,
    date,
    status: run.conclusion === "success" ? "PASS" : "FAIL",
    url: run.html_url ?? null,
  };
}

async function listScheduledRuns({ repo, token, workflow, date }) {
  const params = new URLSearchParams({
    event: "schedule",
    branch: "main",
    created: `${date}T00:00:00Z..${date}T23:59:59Z`,
    per_page: "100",
  });
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?${params}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`${workflow}: GitHub returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!Array.isArray(body.workflow_runs)) {
    throw new Error(`${workflow}: GitHub returned no workflow_runs array`);
  }
  return body.workflow_runs;
}

export async function main(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  const date = env.CANARY_DATE_UTC || previousUtcDate();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("CANARY_DATE_UTC must be a UTC YYYY-MM-DD date.");
  }
  const results = await Promise.all(DAILY_BROWSER_WORKFLOWS.map(async (workflow) =>
    evaluateDailyRun(workflow, date, await listScheduledRuns({ repo, token, workflow, date })),
  ));
  const rows = results.map((result) =>
    `| ${result.workflow} | ${result.date} | ${result.status} | ${result.url ? `[Run](${result.url})` : "—"} |`,
  );
  const report = [
    "## Daily production browser canary freshness",
    "| Workflow | UTC date | Status | Evidence |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  console.log(report);
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
  if (results.some((result) => result.status !== "PASS")) {
    throw new Error("A daily production browser canary is missing, failed, or incomplete.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
