import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");
const coachWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/coach-realtime-authorization.yml"),
  "utf8",
);
const migrationWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/db-migrate-test.yml"),
  "utf8",
);
const e2eWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/e2e.yml"), "utf8");
const realtimeTest = readFileSync(
  path.join(repoRoot, "tests/coach-realtime/authorization.test.ts"),
  "utf8",
);
const localIntegrationTest = readFileSync(
  path.join(repoRoot, "supabase/migrations/20260826170000_coach_call_index.integration.test.ts"),
  "utf8",
);
const migrationSql = readFileSync(
  path.join(repoRoot, "supabase/migrations/20260826170000_coach_call_index.sql"),
  "utf8",
);
const rollbackSql = readFileSync(
  path.join(repoRoot, "supabase/migrations/20260826170000_coach_call_index.rollback.sql"),
  "utf8",
);

/** Slices one top-level job block (2-space-indented `name:` key) out of the
 * coach workflow, up to (not including) the next top-level job key. */
function workflowJob(name: string): string {
  const start = coachWorkflow.indexOf(`\n  ${name}:`);
  if (start < 0) throw new Error(`missing workflow job: ${name}`);
  const remainder = coachWorkflow.slice(start + 1);
  const next = remainder.slice(`  ${name}:`.length).search(/\n  [a-z0-9_-]+:\s*\n/i);
  return next < 0 ? remainder : remainder.slice(0, `  ${name}:`.length + next);
}

/** Slices one `- name: <name>` step out of a job block, up to the next
 * `- name:` at the same indentation. */
function workflowStep(job: string, name: string): string {
  const marker = `- name: ${name}`;
  const start = job.indexOf(marker);
  if (start < 0) throw new Error(`missing workflow step: ${name}`);
  const next = job.indexOf("- name:", start + marker.length);
  return next < 0 ? job.slice(start) : job.slice(start, next);
}

/** Strips `#`-comment lines before a secret-name scan — this file's own
 * explanatory YAML comments mention secret names (to document why a step
 * DOESN'T have them), which would otherwise false-positive a naive
 * substring check against actual `env:`/`${{ secrets.X }}` usage. */
function withoutComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** Extracts a `cat > file <<'DELIMITER' ... DELIMITER` heredoc body embedded
 * in the workflow's YAML block-literal `run:` text, undoing the uniform
 * indentation the surrounding YAML block scalar requires every line to
 * carry (bare `<<'DELIMITER'`, unlike `<<-`, does NOT strip that
 * indentation itself at shell-execution time — the terminator line's own
 * leading whitespace is what the workflow's indentation actually is, so
 * that's what gets stripped from every body line here too). */
function extractHeredoc(source: string, delimiter: string): string {
  const openMarker = `<<'${delimiter}'`;
  const openIdx = source.indexOf(openMarker);
  if (openIdx < 0) throw new Error(`heredoc open marker not found: ${delimiter}`);
  const bodyStart = source.indexOf("\n", openIdx) + 1;
  const lines = source.slice(bodyStart).split("\n");
  const bodyLines: string[] = [];
  let indent: string | null = null;
  for (const line of lines) {
    if (line.trim() === delimiter) {
      indent = line.slice(0, line.indexOf(delimiter));
      break;
    }
    bodyLines.push(line);
  }
  if (indent === null) throw new Error(`heredoc terminator not found: ${delimiter}`);
  const stripped = bodyLines.map((line) => {
    if (line === "") return "";
    if (line.startsWith(indent as string)) return line.slice((indent as string).length);
    throw new Error(`heredoc body line does not match the terminator's indentation: ${JSON.stringify(line)}`);
  });
  return `${stripped.join("\n")}\n`;
}

describe("coach realtime authorization CI security contract", () => {
  it("is a single job — not split across jobs that would each need their own environment approval", () => {
    // Round-6 finding: three separate jobs (setup/test/cleanup) each
    // referencing the same protected environment each triggered their OWN
    // reviewer approval gate (GitHub environment protection is per-job, not
    // per-environment-name). Cleanup's approval request only appeared after
    // setup+test had already finished, by which point a reviewer who
    // approved the first gate had typically moved on — an unapproved
    // cleanup job means the canary's schema changes, rows, and temporary
    // users could outlive the run indefinitely. One job means one approval
    // for the whole provision -> test -> cleanup lifecycle.
    const jobsBlockStart = coachWorkflow.indexOf("\njobs:\n");
    expect(jobsBlockStart).toBeGreaterThan(0);
    const jobsBlock = coachWorkflow.slice(jobsBlockStart);
    const jobNameLines = jobsBlock.match(/^  [a-z][a-z0-9_-]*:\s*$/gm) ?? [];
    expect(jobNameLines).toHaveLength(1);
    expect(coachWorkflow).toContain("coach-realtime-canary:");
    expect(coachWorkflow).not.toContain("coach-realtime-setup:");
    expect(coachWorkflow).not.toContain("coach-realtime-test:");
    expect(coachWorkflow).not.toContain("coach-realtime-cleanup:");
  });

  it("never exposes privileged Supabase credentials to the PR-controlled npm install/test steps", () => {
    // Step-level isolation, not job-level: `npm ci` (which can execute a
    // PR-modified package.json's postinstall scripts) and the actual test
    // run share a job with steps that DO hold privileged secrets, but
    // neither of THESE two steps' own env: blocks reference them — GitHub
    // Actions doesn't ambiently inject secrets into a job's shared process
    // environment, only into the specific step that references them.
    const canaryJob = workflowJob("coach-realtime-canary");
    const installStep = workflowStep(canaryJob, "Install coach canary dependencies");
    const testStep = withoutComments(workflowStep(canaryJob, "Run the coach realtime authorization canary"));
    expect(installStep).toContain("run: npm ci");
    expect(installStep).not.toMatch(/env:/);
    expect(testStep).toContain("TEST_SUPABASE_URL");
    expect(testStep).toContain("TEST_SUPABASE_ANON_KEY");
    expect(testStep).not.toMatch(/SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|DB_PASSWORD/);
  });

  it("keeps the whole canary job behind the protected environment, gated to same-repo PRs, with the required repo setting documented", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    expect(canaryJob).toMatch(/environment:\s*coach-realtime-authorization/);
    expect(canaryJob).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(canaryJob).toContain("SUPABASE_ACCESS_TOKEN");
    expect(canaryJob).toContain("TEST_SUPABASE_DB_PASSWORD");
    expect(coachWorkflow).toContain("REQUIRED REPO SETTING");
    expect(coachWorkflow).toContain("refs/pull/*/merge");
    expect(coachWorkflow).toMatch(/disable administrator bypass/i);
  });

  it("always rolls back unmerged DDL and serializes with the migration and E2E workflows", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const cleanupStep = workflowStep(canaryJob, "Always remove coach canary schema and rows");
    expect(cleanupStep).toMatch(/if:\s*always\(\)/);
    expect(cleanupStep).toContain("$RUNNER_TEMP/coach-migration/rollback.sql");
    expect(coachWorkflow).toContain("group: e2e-shared-test-project");
    expect(migrationWorkflow).toContain("group: e2e-shared-test-project");
    for (const workflow of [coachWorkflow, migrationWorkflow, e2eWorkflow]) {
      expect(workflow).toContain("queue: max");
    }
  });

  it("cleanup steps run unconditionally within the job — no separate approval gate can stall them", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const schemaCleanupStep = workflowStep(canaryJob, "Always remove coach canary schema and rows");
    const usersCleanupStep = workflowStep(canaryJob, "Always delete temporary canary users");
    // Both cleanup steps are steps in the SAME job as provisioning/test, not
    // a separate job with its own `needs:`/environment reference — the
    // `if: always()` guarantee only holds within one job's step sequence.
    expect(schemaCleanupStep).toMatch(/if:\s*always\(\)/);
    expect(usersCleanupStep).toMatch(/if:\s*always\(\)/);
  });

  it("checks actual database schema state, not merely whether the migration file is on the PR's base ref", () => {
    // A migration file being present on `main` doesn't guarantee
    // db-migrate-test.yml has actually applied it to this shared project
    // yet — querying to_regclass() directly checks ground truth instead of
    // inferring it from git history.
    const canaryJob = workflowJob("coach-realtime-canary");
    const schemaCheckStep = workflowStep(canaryJob, "Check whether the coach schema already exists in the database");
    expect(schemaCheckStep).toContain("to_regclass('public.coach_call_index')");
    expect(schemaCheckStep).not.toMatch(/git cat-file/);
  });

  it("does not drop an already-merged coach schema on later pull-request reruns", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const replayStep = workflowStep(canaryJob, "Reset any prior canary residue and replay the reviewed migration");
    const cleanupStep = workflowStep(canaryJob, "Always remove coach canary schema and rows");

    expect(coachWorkflow).toContain("id: coach_schema_state");
    expect(replayStep).toContain("steps.coach_schema_state.outputs.needs_replay == 'true'");
    expect(cleanupStep).toContain("delete from public.coach_call_index");
    expect(cleanupStep).toContain("steps.coach_schema_state.outputs.needs_replay");
  });

  it("retries the migration reset/replay instead of leaving the run red on one transient failure", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const replayStep = workflowStep(canaryJob, "Reset any prior canary residue and replay the reviewed migration");
    expect(replayStep).toMatch(/for attempt in 1 2 3/);
  });

  it("reuses a stable run marker so a rerun removes residue from an earlier attempt", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const provisionStep = workflowStep(canaryJob, "Provision temporary least-privilege canary users");
    const deleteStep = workflowStep(canaryJob, "Always delete temporary canary users");

    expect(provisionStep).toContain('marker="$GITHUB_RUN_ID"');
    expect(deleteStep).toContain('marker="$GITHUB_RUN_ID"');
    expect(provisionStep).not.toContain("GITHUB_RUN_ATTEMPT");
    expect(deleteStep).not.toContain("GITHUB_RUN_ATTEMPT");
  });

  it("requires the setup write to succeed and a same-client owned-channel success control before the non-owner denial", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const seedStep = workflowStep(canaryJob, "Seed the two ownership rows");
    expect(seedStep).toContain("ON_ERROR_STOP=1");
    expect(seedStep).toContain("insert into public.coach_call_index");
    expect(seedStep).toContain("COACH_CANARY_OWNED_CALL_ID");
    expect(seedStep).toContain("COACH_CANARY_FOREIGN_CALL_ID");

    expect(realtimeTest.match(/const client = createClient/g)).toHaveLength(1);
    const ownedSuccess = realtimeTest.indexOf("expect(owned.status).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED)");
    const foreignDenial = realtimeTest.indexOf("expect(foreign.status).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR)");
    expect(ownedSuccess).toBeGreaterThan(0);
    expect(foreignDenial).toBeGreaterThan(ownedSuccess);
    expect(realtimeTest).toContain("expect(foreign.error).toBeInstanceOf(Error)");
  });

  it("the local integration test never re-applies or drops schema it didn't create this run", () => {
    // Round-6 finding: an earlier version of this file unconditionally
    // rolled back and replayed the migration in beforeAll, and always
    // dropped it again in afterAll. Fine before this branch merges — but
    // once merged, db-migrate-test.yml applies this migration for real and
    // it becomes PERMANENT shared schema. A routine `npm run
    // test:integration` run after that would delete the real
    // coach_call_index table and its realtime.messages policies from the
    // shared project. The fix: check existence first, only create if
    // missing, and only roll back what this run itself created.
    expect(localIntegrationTest).toContain("createdSchemaThisRun");
    expect(localIntegrationTest).toContain("to_regclass('public.coach_call_index')");
    expect(localIntegrationTest).toMatch(/if\s*\(!createdSchemaThisRun\)\s*return;/);
    expect(localIntegrationTest).not.toMatch(/beforeAll\([\s\S]{0,80}rollback/);
  });

  it("no privileged step reads migration/rollback SQL from the PR's own checkout", () => {
    // Round-7 finding: the replay and cleanup steps used to run `psql -f
    // supabase/migrations/...sql`, reading SQL straight out of this job's
    // checkout of the PR's own tree — content a same-repo PR fully
    // controls. Both privileged steps now read from a path materialized
    // OUTSIDE the checkout ($RUNNER_TEMP) from SQL embedded directly in
    // this workflow file's own text, so editing the PR's migration files
    // alone can no longer change what a privileged step executes.
    const canaryJob = workflowJob("coach-realtime-canary");
    expect(withoutComments(canaryJob)).not.toMatch(/supabase\/migrations\//);

    const materializeStep = workflowStep(canaryJob, "Materialize the reviewed migration/rollback SQL outside the PR checkout");
    expect(materializeStep).not.toMatch(/env:/);
    expect(materializeStep).toContain("$RUNNER_TEMP/coach-migration");

    const replayStep = workflowStep(canaryJob, "Reset any prior canary residue and replay the reviewed migration");
    const cleanupStep = workflowStep(canaryJob, "Always remove coach canary schema and rows");
    expect(replayStep).toContain('-f "$RUNNER_TEMP/coach-migration/rollback.sql"');
    expect(replayStep).toContain('-f "$RUNNER_TEMP/coach-migration/migration.sql"');
    expect(cleanupStep).toContain('-f "$RUNNER_TEMP/coach-migration/rollback.sql"');

    // The materialize step must run before anything that consumes its
    // output — it has no credential dependency, so nothing else forces
    // this ordering.
    expect(canaryJob.indexOf(materializeStep)).toBeLessThan(canaryJob.indexOf(replayStep));
    expect(canaryJob.indexOf(materializeStep)).toBeLessThan(canaryJob.indexOf(cleanupStep));
  });

  it("the SQL embedded in the workflow is byte-identical to the real migration/rollback files — the two can't silently drift apart", () => {
    const embeddedMigrationSql = extractHeredoc(coachWorkflow, "MIGRATION_SQL");
    const embeddedRollbackSql = extractHeredoc(coachWorkflow, "ROLLBACK_SQL");
    expect(embeddedMigrationSql).toBe(migrationSql);
    expect(embeddedRollbackSql).toBe(rollbackSql);
  });
});
