import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

// js-yaml is an explicit devDependency; it ships no types and @types/js-yaml is not installed.
const { load } = createRequire(__filename)("js-yaml") as { load: (source: string) => unknown };

/**
 * Every CI step that runs a config guarded by src/lib/testing/isolated-db-env.ts
 * must supply all env that guard needs, or the guard (correctly) refuses it.
 * Env counts from workflow, job and step `env:`, inline `FOO=` assignments, and
 * the GITHUB_ENV values a provisioning step publishes, but only for steps that
 * run AFTER that provisioning step, and only when the provisioning step is
 * unconditional (or carries the identical `if:` as the guarded step).
 */
const root = path.resolve(__dirname, "../../..");
const workflowsDir = path.join(root, ".github/workflows");

const FULL = ["LOCAL_SUPABASE_URL", "LOCAL_SUPABASE_SERVICE_ROLE_KEY", "TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_SUPABASE_DB_URL"];
const PUBLISHED = ["TEST_SUPABASE_URL", "TEST_SUPABASE_ANON_KEY", "TEST_SUPABASE_SERVICE_ROLE_KEY", "E2E_CI_SUPABASE_DB_URL", "E2E_DISPOSABLE_DATABASE"];
const PROVISION = /provision-(e2e-local-database|disposable-stack)\.mjs/;

// globalSetup file → env sets (any one set satisfies the guard).
const GUARDS: Record<string, string[][]> = {
  "isolated-db-env.global-setup.ts": [FULL],
  "isolated-db-url.global-setup.ts": [["TEST_SUPABASE_DB_URL"]],
  "isolated-norma-stress.global-setup.ts": [["NORMA_STRESS_SOURCE_DB_URL"], ["TEST_SUPABASE_DB_URL"]],
  "isolated-slack-local.global-setup.ts": [["SLACK_LOCAL_API_URL", "SLACK_LOCAL_SERVICE_KEY", "SLACK_LOCAL_DB_URL"]],
};

/** Derive guarded configs from the config files: own globalSetup, or inherited via `import base from "./vitest.X"`. */
function guardedConfigs(): Map<string, string[][]> {
  const files = readdirSync(root).filter((f) => /^vitest\..*\.ts$/.test(f));
  const read = (f: string) => readFileSync(path.join(root, f), "utf8");
  const resolve = (f: string, seen = new Set<string>()): string[][] | undefined => {
    if (seen.has(f)) return undefined;
    seen.add(f);
    const src = read(f);
    for (const [setup, sets] of Object.entries(GUARDS)) if (src.includes(`src/lib/testing/${setup}`)) return sets;
    const base = src.match(/import base from "\.\/(vitest\.[\w.-]+?)(?:\.ts)?"/);
    return base ? resolve(`${base[1]}.ts`, seen) : undefined;
  };
  const out = new Map<string, string[][]>();
  for (const f of files) {
    const sets = resolve(f);
    if (sets) out.set(f, sets);
  }
  return out;
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

/** Requirements for one `run:` script, following npm scripts that invoke a guarded config. */
function requirementsFor(run: string, guarded: Map<string, string[][]>): string[][][] {
  const reqs: string[][][] = [];
  const scan = (text: string, depth = 0) => {
    for (const [config, sets] of guarded) if (text.includes(config)) reqs.push(sets);
    if (depth > 2) return;
    for (const m of text.matchAll(/npm run ([\w:-]+)/g)) if (pkg.scripts[m[1]]) scan(pkg.scripts[m[1]], depth + 1);
  };
  scan(run);
  return reqs;
}

type Step = { name?: string; run?: string; if?: unknown; env?: Record<string, unknown> };
type Job = { env?: Record<string, unknown>; steps?: Step[] };
type Workflow = { env?: Record<string, unknown>; jobs?: Record<string, Job> };
type Case = { where: string; reqs: string[][][]; env: Set<string> };

export function collectCases(source: string, file: string, guarded: Map<string, string[][]>): Case[] {
  const wf = (load(source) ?? {}) as Workflow;
  const cases: Case[] = [];
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    const provisionedUnder: (string | null)[] = []; // null = unconditional; string = that exact `if:`
    for (const step of job.steps ?? []) {
      const run = step.run ?? "";
      const cond = step.if === undefined ? null : String(step.if);
      const reqs = run ? requirementsFor(run, guarded) : [];
      if (reqs.length > 0) {
        const env = new Set([...Object.keys(wf.env ?? {}), ...Object.keys(job.env ?? {}), ...Object.keys(step.env ?? {})]);
        if (provisionedUnder.some((c) => c === null || c === cond)) for (const k of PUBLISHED) env.add(k);
        for (const m of run.matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=/g)) env.add(m[1]);
        cases.push({ where: `${file} › ${jobName} › ${step.name ?? run.slice(0, 60)}`, reqs, env });
      }
      if (PROVISION.test(run)) provisionedUnder.push(cond);
    }
  }
  return cases;
}

function missing(c: Case): string[] {
  const out: string[] = [];
  for (const sets of c.reqs) {
    if (!sets.some((set) => set.every((k) => c.env.has(k)))) out.push(sets.map((set) => set.filter((k) => !c.env.has(k)).join(", ")).join(" | or | "));
  }
  return out;
}

const guarded = guardedConfigs();

describe("guarded config discovery", () => {
  it("derives the guarded configs from their globalSetup wiring", () => {
    for (const f of [
      "vitest.local-integration.config.ts",
      "vitest.slack-local.config.ts",
      "vitest.norma-queue.config.ts",
      "vitest.norma-queue-fullchain.config.ts",
      "vitest.norma-queue-prequeue.config.ts",
      "vitest.norma-stress.config.ts",
      "vitest.norma-queue-stress.config.ts",
      "vitest.norma-inbound.config.ts",
      "vitest.norma-recordings.config.ts",
    ]) expect(guarded.has(f), f).toBe(true);
    expect(guarded.has("vitest.integration.config.ts")).toBe(false);
    expect(guarded.has("vitest.config.ts")).toBe(false);
  });
});

describe("order-aware provisioning credit (synthetic workflows)", () => {
  const g = new Map([["vitest.local-integration.config.ts", [FULL]]]);
  const provision = "      - run: node scripts/provision-e2e-local-database.mjs\n";
  const guardedStep = (extra = "") =>
    `      - name: guarded\n${extra}        env:\n          TEST_SUPABASE_DB_URL: x\n          LOCAL_SUPABASE_URL: x\n          LOCAL_SUPABASE_SERVICE_ROLE_KEY: x\n        run: npx vitest run --config vitest.local-integration.config.ts\n`;
  const wf = (steps: string) => `jobs:\n  j:\n    steps:\n${steps}`;
  const only = (src: string) => {
    const cases = collectCases(src, "synthetic.yml", g);
    expect(cases).toHaveLength(1);
    return missing(cases[0]);
  };

  it("fails when the guarded step runs BEFORE provisioning", () => {
    expect(only(wf(guardedStep() + provision))).not.toEqual([]);
  });
  it("passes when the guarded step runs AFTER provisioning", () => {
    expect(only(wf(provision + guardedStep()))).toEqual([]);
  });
  it("does not credit a conditional provisioning step", () => {
    const steps = "      - if: github.event_name == 'push'\n        run: node scripts/provision-e2e-local-database.mjs\n" + guardedStep();
    expect(only(wf(steps))).not.toEqual([]);
  });
  it("credits a conditional provisioning step for a guarded step with the identical if", () => {
    const cond = "github.event_name == 'push'";
    const steps = `      - if: ${cond}\n        run: node scripts/provision-e2e-local-database.mjs\n` + guardedStep(`        if: ${cond}\n`);
    expect(only(wf(steps))).toEqual([]);
  });
});

const cases = readdirSync(workflowsDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) => collectCases(readFileSync(path.join(workflowsDir, f), "utf8"), f, guarded));

describe("CI steps that run guarded DB configs supply the env the guard needs", () => {
  it("finds guarded steps", () => {
    expect(cases.length).toBeGreaterThan(10);
  });
  for (const c of cases) {
    it(c.where, () => {
      expect(missing(c), "missing env").toEqual([]);
    });
  }
});
