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

describe("coach realtime authorization CI security contract", () => {
  it("never exposes privileged Supabase credentials to the PR-controlled npm install/test job", () => {
    // Job-level isolation, not in-job sandboxing: coach-realtime-test is a
    // SEPARATE job/runner from coach-realtime-setup and coach-realtime-cleanup
    // (which hold the privileged secrets). `npm ci` — which can execute a
    // PR-modified package.json's postinstall scripts — runs in this job with
    // no privileged secret anywhere in scope, not merely masked or scoped to
    // a later step.
    const testJob = workflowJob("coach-realtime-test");
    expect(testJob).toMatch(/environment:\s*coach-realtime-authorization/);
    expect(testJob).toContain("run: npm ci");
    expect(testJob).not.toMatch(/SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|DB_PASSWORD/);

    const canaryStep = workflowStep(testJob, "Run the coach realtime authorization canary");
    expect(canaryStep).toContain("TEST_SUPABASE_URL");
    expect(canaryStep).toContain("TEST_SUPABASE_ANON_KEY");
    expect(canaryStep).not.toMatch(/SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|DB_PASSWORD/);
  });

  it("keeps the privileged setup/cleanup jobs behind the protected environment, separate from the test job", () => {
    const setupJob = workflowJob("coach-realtime-setup");
    const cleanupJob = workflowJob("coach-realtime-cleanup");
    expect(setupJob).toMatch(/environment:\s*coach-realtime-authorization/);
    expect(cleanupJob).toMatch(/environment:\s*coach-realtime-authorization/);
    // These jobs hold the privileged secrets — they must never run `npm ci`
    // (or any other step that could execute PR-controlled install scripts)
    // in the same job/runner scope as those secrets.
    expect(setupJob).not.toContain("npm ci");
    expect(cleanupJob).not.toContain("npm ci");
    expect(setupJob).toContain("SUPABASE_ACCESS_TOKEN");
    expect(setupJob).toContain("TEST_SUPABASE_DB_PASSWORD");
  });

  it("gates the privileged jobs to same-repo PRs and documents the required protected-environment repo setting", () => {
    const setupJob = workflowJob("coach-realtime-setup");
    expect(setupJob).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(coachWorkflow).toContain("REQUIRED REPO SETTING");
    expect(coachWorkflow).toContain("refs/pull/*/merge");
    expect(coachWorkflow).toMatch(/disable administrator bypass/i);
  });

  it("always rolls back unmerged DDL and serializes with the migration and E2E workflows", () => {
    const cleanupJob = workflowJob("coach-realtime-cleanup");
    const cleanupStep = workflowStep(cleanupJob, "Always remove coach canary schema and rows");
    expect(cleanupJob).toMatch(/if:\s*always\(\)/);
    expect(cleanupStep).toContain("20260826170000_coach_call_index.rollback.sql");
    expect(coachWorkflow).toContain("group: e2e-shared-test-project");
    expect(migrationWorkflow).toContain("group: e2e-shared-test-project");
    for (const workflow of [coachWorkflow, migrationWorkflow, e2eWorkflow]) {
      expect(workflow).toContain("queue: max");
    }
  });

  it("does not drop an already-merged coach schema on later pull-request reruns", () => {
    const setupJob = workflowJob("coach-realtime-setup");
    const cleanupJob = workflowJob("coach-realtime-cleanup");
    const replayStep = workflowStep(setupJob, "Reset any prior canary residue and replay the reviewed migration");
    const cleanupStep = workflowStep(cleanupJob, "Always remove coach canary schema and rows");

    expect(coachWorkflow).toContain("id: coach_schema_state");
    expect(replayStep).toContain("steps.coach_schema_state.outputs.needs_replay == 'true'");
    expect(cleanupStep).toContain("delete from public.coach_call_index");
    expect(cleanupStep).toContain("steps.coach_schema_state.outputs.needs_replay");
  });

  it("retries the migration reset/replay instead of leaving the run red on one transient failure", () => {
    const setupJob = workflowJob("coach-realtime-setup");
    const replayStep = workflowStep(setupJob, "Reset any prior canary residue and replay the reviewed migration");
    expect(replayStep).toMatch(/for attempt in 1 2 3/);
  });

  it("reuses a stable run marker so a rerun removes residue from an earlier attempt", () => {
    const setupJob = workflowJob("coach-realtime-setup");
    const cleanupJob = workflowJob("coach-realtime-cleanup");
    const provisionStep = workflowStep(setupJob, "Provision temporary least-privilege canary users");
    const deleteStep = workflowStep(cleanupJob, "Always delete temporary canary users");

    expect(provisionStep).toContain('marker="$GITHUB_RUN_ID"');
    expect(deleteStep).toContain('marker="$GITHUB_RUN_ID"');
    expect(provisionStep).not.toContain("GITHUB_RUN_ATTEMPT");
    expect(deleteStep).not.toContain("GITHUB_RUN_ATTEMPT");
  });

  it("requires the setup write to succeed and a same-client owned-channel success control before the non-owner denial", () => {
    const setupJob = workflowJob("coach-realtime-setup");
    const seedStep = workflowStep(setupJob, "Seed the two ownership rows");
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
});
