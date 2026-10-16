import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every CI step that runs a config guarded by src/lib/testing/isolated-db-env.ts
 * must supply all env that guard requires, or the guard (correctly) refuses it.
 * Values may come from the step env or the job/workflow env.
 */
// js-yaml is a hoisted transitive dependency (eslint) with no bundled types.
const { load } = createRequire(__filename)("js-yaml") as { load: (source: string) => unknown };

const root = path.resolve(__dirname, "../../..");
const workflowsDir = path.join(root, ".github/workflows");

const FULL = ["LOCAL_SUPABASE_URL", "LOCAL_SUPABASE_SERVICE_ROLE_KEY", "TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_SUPABASE_DB_URL"];
// Published to GITHUB_ENV by the disposable-stack provisioning scripts, so steps inherit them.
const PUBLISHED = ["TEST_SUPABASE_URL", "TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_SERVICE_ROLE_KEY", "E2E_CI_SUPABASE_DB_URL", "E2E_DISPOSABLE_DATABASE"];

type Requirement = { config: RegExp; anyOf?: string[][] };
const REQUIREMENTS: Requirement[] = [
  { config: /vitest\.local-integration\.config\.ts|test:integration:local|test:search-local|stress:my-leads-queue:dispatch/, anyOf: [FULL] },
  { config: /vitest\.slack-local\.config\.ts|test:slack-local/, anyOf: [["SLACK_LOCAL_API_URL", "SLACK_LOCAL_SERVICE_KEY", "SLACK_LOCAL_DB_URL"]] },
  { config: /vitest\.norma-stress\.config\.ts|vitest\.norma-queue-stress[\w-]*\.config\.ts|test:norma-stress/, anyOf: [["NORMA_STRESS_SOURCE_DB_URL"], ["TEST_SUPABASE_DB_URL"]] },
  { config: /vitest\.norma-(queue|queue-fullchain|queue-prequeue|inbound|recordings)\.config\.ts/, anyOf: [["TEST_SUPABASE_DB_URL"]] },
];

type Step = { name?: string; run?: string; env?: Record<string, unknown> };
type Job = { env?: Record<string, unknown>; steps?: Step[] };
type Workflow = { env?: Record<string, unknown>; jobs?: Record<string, Job> };

const cases: { where: string; run: string; env: Set<string> }[] = [];
for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
  const wf = load(readFileSync(path.join(workflowsDir, file), "utf8")) as Workflow;
  for (const [jobName, job] of Object.entries(wf?.jobs ?? {})) {
    const published = (job.steps ?? []).some((s) => /provision-(e2e-local-database|disposable-stack)\.mjs/.test(s.run ?? ""));
    for (const step of job.steps ?? []) {
      if (!step.run) continue;
      const env = new Set([...Object.keys(wf.env ?? {}), ...Object.keys(job.env ?? {}), ...Object.keys(step.env ?? {})]);
      if (published) for (const k of PUBLISHED) env.add(k);
      // Inline assignments such as `FOO=bar npx vitest ...`.
      for (const m of step.run.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=/g)) env.add(m[1]);
      cases.push({ where: `${file} › ${jobName} › ${step.name ?? step.run.slice(0, 60)}`, run: step.run, env });
    }
  }
}

describe("CI steps that run guarded DB configs supply the env the guard needs", () => {
  it("finds guarded steps", () => {
    expect(cases.filter((c) => REQUIREMENTS.some((r) => r.config.test(c.run))).length).toBeGreaterThan(10);
  });

  for (const c of cases) {
    const reqs = REQUIREMENTS.filter((r) => r.config.test(c.run));
    if (reqs.length === 0) continue;
    it(c.where, () => {
      for (const req of reqs) {
        const satisfied = req.anyOf!.some((set) => set.every((k) => c.env.has(k)));
        const missing = req.anyOf!.map((set) => set.filter((k) => !c.env.has(k)).join(", ")).join(" | or | ");
        expect(satisfied, `missing: ${missing}`).toBe(true);
      }
    });
  }
});
