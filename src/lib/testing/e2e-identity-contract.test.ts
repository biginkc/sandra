import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function executableTypescriptFilesUnder(relativeDirectory: string): string[] {
  const absoluteDirectory = path.join(process.cwd(), relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory())
        return executableTypescriptFilesUnder(relativePath);
      return entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)
        ? [relativePath]
        : [];
    },
  );
}

describe("E2E identity source contract", () => {
  it("emits one identity before preflight and cleans it after all five invocations", () => {
    const workflow = source(".github/workflows/e2e.yml");
    const emit = workflow.indexOf("e2e-identity-lifecycle.ts emit");
    const preflight = workflow.indexOf("e2e-identity-lifecycle.ts preflight");
    const run = workflow.indexOf("Run Playwright E2E suite");
    const cleanup = workflow.indexOf("e2e-identity-lifecycle.ts cleanup");

    expect(emit).toBeGreaterThan(-1);
    expect(preflight).toBeGreaterThan(emit);
    expect(run).toBeGreaterThan(preflight);
    expect(cleanup).toBeGreaterThan(run);
    expect(workflow.match(/e2e-identity-lifecycle\.ts emit/g)).toHaveLength(1);
    expect(workflow.match(/npm run test:e2e/g)).toHaveLength(5);
    expect(workflow).toMatch(
      /Clean up exact-run E2E identities and verify browser-QA isolation\n\s+if: always\(\)/,
    );
  });

  it("retains shared serialization and simulated-provider boundaries", () => {
    const workflow = source(".github/workflows/e2e.yml");
    expect(workflow).toContain("group: e2e-shared-test-project");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain('NEXT_PUBLIC_SOFTPHONE_TRANSPORT: "simulated"');
    expect(workflow).toContain('SKIP_INTENT_GATE: "1"');
  });

  it("binds only the dedicated e2e-ci environment and credentials", () => {
    const workflow = source(".github/workflows/e2e.yml");
    expect(workflow).toContain("environment: e2e-ci");
    expect(workflow).toContain(
      "E2E_CI_SUPABASE_PROJECT_REF: ${{ vars.E2E_CI_SUPABASE_PROJECT_REF }}",
    );
    expect(workflow).toContain(
      "TEST_SUPABASE_URL: ${{ secrets.E2E_CI_SUPABASE_URL }}",
    );
    expect(workflow).toContain(
      "TEST_SUPABASE_ANON_KEY: ${{ secrets.E2E_CI_SUPABASE_ANON_KEY }}",
    );
    expect(workflow).toContain(
      "TEST_SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.E2E_CI_SUPABASE_SERVICE_ROLE_KEY }}",
    );
    const runtimeSecretBindings = [
      ...workflow.matchAll(
        /TEST_SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY):\s*\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g,
      ),
    ].map((match) => [match[1], match[2]]);
    expect(runtimeSecretBindings).toEqual([
      ["URL", "E2E_CI_SUPABASE_URL"],
      ["SERVICE_ROLE_KEY", "E2E_CI_SUPABASE_SERVICE_ROLE_KEY"],
      ["URL", "E2E_CI_SUPABASE_URL"],
      ["ANON_KEY", "E2E_CI_SUPABASE_ANON_KEY"],
      ["SERVICE_ROLE_KEY", "E2E_CI_SUPABASE_SERVICE_ROLE_KEY"],
      ["URL", "E2E_CI_SUPABASE_URL"],
      ["SERVICE_ROLE_KEY", "E2E_CI_SUPABASE_SERVICE_ROLE_KEY"],
    ]);
    expect(workflow).not.toMatch(/secrets\.TEST_SUPABASE_/);
  });

  it("does not expose Supabase credentials to install or browser checks", () => {
    const workflow = source(".github/workflows/e2e.yml");
    const jobEnv = workflow.slice(
      workflow.indexOf("    env:"),
      workflow.indexOf("    steps:"),
    );
    expect(jobEnv).not.toContain("secrets.");

    const installStep = workflow.slice(
      workflow.indexOf("- name: Install dependencies"),
      workflow.indexOf("- name: Generate job-scoped E2E identity"),
    );
    expect(installStep).not.toContain("TEST_SUPABASE_");
  });

  it("contains no E2E password repair or shared default password path", () => {
    const executableFiles = [
      ...executableTypescriptFilesUnder("e2e"),
      ...readdirSync(path.join(process.cwd(), "scripts"))
        .filter((name) => /^e2e-.*\.(?:ts|tsx|mts|cts)$/.test(name))
        .map((name) => path.join("scripts", name)),
      ...readdirSync(process.cwd()).filter((name) =>
        /^playwright.*\.config\.(?:ts|mts|cts)$/.test(name),
      ),
    ].sort();

    const forbiddenTokens = [
      "repairPassword",
      "updateUserById",
      "test12345",
      "e2e-test@bmhgroupkc.com",
      "e2e-assignee@bmhgroupkc.com",
      "e2e-leads-teammate@bmhgroupkc.com",
    ];
    for (const relativePath of executableFiles) {
      const contents = source(relativePath);
      for (const token of forbiddenTokens) {
        expect(contents, `${relativePath} contains ${token}`).not.toContain(
          token,
        );
      }
    }

    const authMutationCalls = executableFiles.flatMap((relativePath) =>
      [...source(relativePath).matchAll(/\b(createUser|deleteUser)\s*\(/g)].map(
        (match) => `${relativePath}:${match[1]}`,
      ),
    );
    expect(authMutationCalls).toEqual([
      "e2e/fixtures.ts:createUser",
      "scripts/e2e-identity-lifecycle.ts:deleteUser",
    ]);
  });

  it("masks the generated password before writing it to GITHUB_ENV", () => {
    const lifecycle = source("scripts/e2e-identity-lifecycle.ts");
    const mask = lifecycle.indexOf("::add-mask::${primary.password}");
    const write = lifecycle.indexOf(
      'appendGitHubEnvironment("E2E_TEST_USER_PASSWORD", primary.password)',
    );
    expect(mask).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(mask);
  });

  it("routes every runtime target through the environment exact-ref guard", () => {
    for (const relativePath of [
      "scripts/e2e-identity-lifecycle.ts",
      "e2e/fixtures.ts",
      "playwright.config.ts",
    ]) {
      const runtimeSource = source(relativePath);
      expect(runtimeSource).toContain(
        "assertSafeE2ESupabaseTargetFromEnvironment",
      );
      expect(runtimeSource).not.toMatch(/\bassertSafeE2ESupabaseTarget\(/);
    }
  });

  it("rewires ADMIN_EMAILS to only the run-scoped primary identity", () => {
    const config = source("playwright.config.ts");
    expect(config).toContain("ADMIN_EMAILS: e2ePrimaryIdentity.email");
    expect(config).not.toMatch(/ADMIN_EMAILS:\s*["']/);
  });

  it("requires exact cleanup and before/after browser-QA checks", () => {
    const lifecycle = source("scripts/e2e-identity-lifecycle.ts");
    expect(lifecycle.match(/assertBrowserQaSnapshotUnchanged\(/g)).toHaveLength(
      2,
    );
    expect(lifecycle).toContain("assertCleanupCandidate(candidate, identity)");
    expect(lifecycle).toContain("deleteUser(candidate.id)");
    expect(lifecycle).not.toMatch(/deleteUsers|removeAll|sweep/i);
  });
});
