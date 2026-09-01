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
const ciTestProjectSetup = readFileSync(
  path.join(repoRoot, "supabase/ci/coach_ci_test_project_setup.sql"),
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
 * explanatory YAML comments mention secret names (to document why they
 * DON'T appear elsewhere), which would otherwise false-positive a naive
 * substring check against actual `env:`/`${{ secrets.X }}` usage. */
function withoutComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/** Same idea, `--`-prefixed SQL comment lines — the reference SQL script's
 * own prose explains the round-9 bug using the exact vulnerable pattern
 * it fixed, which would otherwise false-positive a naive "the bad pattern
 * is gone" check against the real, executable SQL below it. */
function withoutSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

describe("coach realtime authorization CI security contract", () => {
  it("requires explicit Coach CI owner-purpose markers and collision preflight", () => {
    expect(coachWorkflow).toContain("Assert Coach identities are explicitly isolated");
    expect(coachWorkflow).toContain("Coach CI identity collision");
    expect(withoutSqlComments(ciTestProjectSetup)).toContain("raw_app_meta_data->>'owner'");
    expect(withoutSqlComments(ciTestProjectSetup)).toContain("raw_app_meta_data->>'purpose'");
    expect(withoutSqlComments(ciTestProjectSetup)).toContain("email in ('coach-ci-owner@bmhgroupkc.com', 'coach-ci-foreign@bmhgroupkc.com')");
    expect(withoutSqlComments(ciTestProjectSetup)).toContain("coach-realtime-authorization");
  });

  it("keeps Playwright service-role access on the dedicated CI project", () => {
    expect(e2eWorkflow).toMatch(/playwright:[\s\S]*environment:\s*e2e-ci/);
    expect(e2eWorkflow).toContain("E2E_CI_SUPABASE_URL");
    expect(e2eWorkflow).toContain("E2E_CI_SUPABASE_SERVICE_ROLE_KEY");
    expect(e2eWorkflow).not.toContain("secrets.TEST_SUPABASE_SERVICE_ROLE_KEY");
    expect(e2eWorkflow).toContain("E2E_CI_SUPABASE_PROJECT_REF");
    expect(e2eWorkflow).toContain("BROWSER_QA_SUPABASE_PROJECT_REF");
    expect(e2eWorkflow).toContain("new URL(ciUrl)");
    expect(e2eWorkflow).toContain("parsed.hostname !== `${ciRef}.supabase.co`");
    expect(e2eWorkflow).not.toContain("ciUrl.includes");
    expect(e2eWorkflow).toContain('E2E_DEDICATED_CI: "1"');
  });
  it("masks the generated CI password before writing it to the runner environment", () => {
    const passwordAssignment = e2eWorkflow.indexOf('password="$(openssl rand -base64 36');
    const mask = e2eWorkflow.indexOf('echo "::add-mask::$password"');
    const passwordWrite = e2eWorkflow.indexOf("E2E_TEST_USER_PASSWORD=%s", mask);
    expect(passwordAssignment).toBeGreaterThan(-1);
    expect(mask).toBeGreaterThan(passwordAssignment);
    expect(passwordWrite).toBeGreaterThan(mask);
    expect(e2eWorkflow).not.toContain("printf 'E2E_TEST_USER_PASSWORD=%s\\n' \"$(openssl");
  });
  it("is a single job — not split across jobs that would each need their own environment approval", () => {
    const jobsBlockStart = coachWorkflow.indexOf("\njobs:\n");
    expect(jobsBlockStart).toBeGreaterThan(0);
    const jobsBlock = coachWorkflow.slice(jobsBlockStart);
    const jobNameLines = jobsBlock.match(/^  [a-z][a-z0-9_-]*:\s*$/gm) ?? [];
    expect(jobNameLines).toHaveLength(1);
    expect(coachWorkflow).toContain("coach-realtime-canary:");
  });

  it("round 8 — never references a service-role key, database password, or Supabase account token anywhere in this workflow", () => {
    // Rounds 6-7 kept hardening privilege ISOLATION on a shared runner
    // (step-scoped env, then materializing reviewed SQL outside the PR's
    // own checkout). The final review called that fight unwinnable: a
    // PR-controlled process (npm ci, the test file itself) runs on the
    // SAME runner as any privileged step, in the same process tree — it
    // can mutate a materialized file or simply observe a later step's env
    // vars, regardless of how carefully the YAML scopes things.
    //
    // The actual fix: hold nothing worth protecting. This workflow now
    // authenticates only as two permanent, narrowly-scoped Supabase Auth
    // users via two SECURITY DEFINER RPCs that let each seed/delete only
    // its OWN row in coach_call_index — no service-role key, no database
    // password, no Supabase account token, anywhere. If a compromised
    // runtime does anything at all with these credentials, the worst case
    // is "touch a row it already owns" — nothing worth defending against.
    const withoutCommentary = withoutComments(coachWorkflow);
    expect(withoutCommentary).not.toMatch(/SUPABASE_ACCESS_TOKEN/);
    expect(withoutCommentary).not.toMatch(/SERVICE_ROLE/);
    expect(withoutCommentary).not.toMatch(/DB_PASSWORD/);
    expect(withoutCommentary).not.toMatch(/supabase\/setup-cli/);
    expect(withoutCommentary).not.toMatch(/supabase\s+link/);
    // No more raw Postgres connection at all — psql/pooler are gone along
    // with the credential that justified them.
    expect(withoutCommentary).not.toMatch(/psql/);
    expect(withoutCommentary).not.toMatch(/postgresql-client/);
    // No more admin-API user provisioning (auth/v1/admin/users) — the two
    // test identities are permanent and pre-provisioned, not created or
    // deleted at runtime.
    expect(withoutCommentary).not.toMatch(/auth\/v1\/admin\/users/);
  });

  it("authenticates only as the two static test users and the anon key — nothing else — in the test run and cleanup steps", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const installStep = workflowStep(canaryJob, "Install coach canary dependencies");
    const testStep = withoutComments(workflowStep(canaryJob, "Run the coach realtime authorization canary"));
    const cleanupStep = withoutComments(workflowStep(canaryJob, "Always clean up this run's ownership rows"));

    // Step-level isolation still matters even though the credential is
    // low-stakes now: `npm ci` (which can execute a PR-modified
    // package.json's postinstall scripts) gets no env at all.
    expect(installStep).toContain("run: npm ci");
    expect(installStep).not.toMatch(/env:/);

    for (const step of [testStep, cleanupStep]) {
      expect(step).toContain("TEST_SUPABASE_URL");
      expect(step).toContain("TEST_SUPABASE_ANON_KEY");
      expect(step).toContain("COACH_CI_OWNER_EMAIL");
      expect(step).toContain("COACH_CI_OWNER_PASSWORD");
      expect(step).toContain("COACH_CI_FOREIGN_EMAIL");
      expect(step).toContain("COACH_CI_FOREIGN_PASSWORD");
      expect(step).not.toMatch(/SUPABASE_ACCESS_TOKEN|SERVICE_ROLE|DB_PASSWORD/);
    }
  });

  it("keeps the whole canary job behind the protected environment, gated to same-repo PRs", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    expect(canaryJob).toMatch(/environment:\s*coach-realtime-authorization/);
    expect(canaryJob).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("serializes with the migration and E2E workflows against the shared test project", () => {
    expect(coachWorkflow).toContain("group: e2e-shared-test-project");
    expect(migrationWorkflow).toContain("group: e2e-shared-test-project");
    for (const workflow of [coachWorkflow, migrationWorkflow, e2eWorkflow]) {
      expect(workflow).toContain("queue: max");
    }
  });

  it("cleanup runs unconditionally in the same job — no separate approval gate, and no schema DDL left to protect", () => {
    const canaryJob = workflowJob("coach-realtime-canary");
    const cleanupStep = workflowStep(canaryJob, "Always clean up this run's ownership rows");
    expect(cleanupStep).toMatch(/if:\s*always\(\)/);
    // Both RPCs this step (and the test's own afterAll) call are
    // self-scoped deletes — cleanup can never need to touch schema,
    // because this job never creates or drops any.
    expect(cleanupStep).toContain("coach_ci_delete_own_ownership");
  });

  it("round 9 — neither RPC accepts a caller-supplied call id; row identity is derived server-side from auth.uid()", () => {
    // A caller-supplied p_call_id plus an unconditional ON CONFLICT DO
    // UPDATE let either CI account claim ownership of ANY named row and
    // create unlimited rows. Both RPCs now take NO argument at all — the
    // workflow no longer generates or threads a call id through anywhere.
    expect(withoutComments(coachWorkflow)).not.toMatch(/call_id/i);
    expect(withoutComments(coachWorkflow)).not.toMatch(/crypto\.randomUUID/);
    // The reference script keeps its round-8 definitions as history (an
    // honest audit trail of what was actually applied, in order) — the
    // round-9 block that supersedes them must come AFTER, and define the
    // no-argument signature.
    const round9Start = ciTestProjectSetup.indexOf("Round-9 hardening");
    expect(round9Start).toBeGreaterThan(0);
    const round9 = ciTestProjectSetup.slice(round9Start);
    expect(round9).toContain("create or replace function public.coach_ci_seed_ownership()");
    expect(round9).toContain("create or replace function public.coach_ci_delete_own_ownership()");
    expect(round9).toContain("'coach-ci-' || auth.uid()::text");
    expect(round9).not.toMatch(/create or replace function public\.coach_ci_seed_ownership\(p_call_id/);
  });

  it("round 9 — the allowlist check can't fail open on a NULL account lookup", () => {
    // `auth.uid()::text NOT IN (subquery, subquery)` is NULL — not TRUE —
    // if either subquery returns no row, and plpgsql treats a NULL `if`
    // condition as false: the exception was silently skipped, letting ANY
    // authenticated TEST-project user through. The fix is a NOT EXISTS
    // check (never NULL) plus a separate assertion that both known
    // accounts still exist.
    const round9Start = ciTestProjectSetup.indexOf("Round-9 hardening");
    expect(round9Start).toBeGreaterThan(0);
    const round9 = withoutSqlComments(ciTestProjectSetup.slice(round9Start));
    expect(round9).not.toMatch(/auth\.uid\(\)::text not in/i);
    const matches = round9.match(/not exists \(\s*select 1 from auth\.users/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // one per RPC
    expect(round9).toContain("expected exactly 2 known CI test accounts");
  });

  it("requires a same-client owned-channel success control before the non-owner denial, seeded via the narrow RPCs", () => {
    expect(realtimeTest).toContain("coach_ci_seed_ownership");
    expect(realtimeTest).toContain("coach_ci_delete_own_ownership");
    // Each of the two static users signs in and seeds/deletes only its own
    // row — never a client-supplied operator id the caller could spoof.
    expect(realtimeTest.match(/createClient\(/g)?.length).toBe(2);

    const ownedSuccess = realtimeTest.indexOf("expect(owned.status).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED)");
    const foreignDenial = realtimeTest.indexOf("expect(foreign.status).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR)");
    expect(ownedSuccess).toBeGreaterThan(0);
    expect(foreignDenial).toBeGreaterThan(ownedSuccess);
    expect(realtimeTest).toContain("expect(foreign.error).toBeInstanceOf(Error)");

    // Round-9: a direct, untyped fetch proves the server itself rejects a
    // caller-supplied identifier — not merely that the typed client
    // happens not to send one.
    expect(realtimeTest).toContain("could not find the function");
  });

  it("the CI test-fixture setup script lives outside supabase/migrations/ — it must never reach production", () => {
    // supabase/ci/ (not supabase/migrations/) is deliberate: db-migrate-
    // test.yml and db-migrate-prod.yml only ever apply files under
    // supabase/migrations/, so this reference copy of the two static test
    // users + the narrow RPCs can't be picked up by either pipeline —
    // these fixtures have no reason to exist anywhere near production.
    expect(ciTestProjectSetup).toContain("TEST PROJECT ONLY");
    expect(ciTestProjectSetup).toContain("coach_ci_seed_ownership");
    expect(ciTestProjectSetup).toContain("coach_ci_delete_own_ownership");
    expect(ciTestProjectSetup).toContain("revoke all on function public.coach_ci_seed_ownership() from anon");

    // The RPC names the workflow and test actually call must match what
    // this reference script defines, so the two can't silently diverge.
    // Seeding only ever happens inside the test file itself (each of the
    // two users seeds its own row); the workflow's own cleanup step only
    // ever needs the delete RPC.
    for (const rpcName of ["coach_ci_seed_ownership", "coach_ci_delete_own_ownership"]) {
      expect(realtimeTest).toContain(rpcName);
      expect(ciTestProjectSetup).toContain(`create or replace function public.${rpcName}`);
    }
    expect(coachWorkflow).toContain("coach_ci_delete_own_ownership");
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
});
