import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "sandra-esign-restart-mutations-"));
chmodSync(sandbox, 0o700);

let cleaned = false;
function cleanupSandbox() {
  if (cleaned) return;
  cleaned = true;
  rmSync(sandbox, { recursive: true, force: true });
}
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    cleanupSandbox();
    process.exit(exitCode);
  });
}

const unit = (...files) => ["vitest", "run", ...files, "--reporter=json"];
const rtl = (...files) => [
  "vitest",
  "run",
  "--config",
  "vitest.rtl.config.ts",
  ...files,
  "--reporter=json",
];

const mutations = [
  {
    name: "restart classifier requires HTTP 404",
    file: "src/lib/esign/provider-failure.ts",
    from: "error.details?.statusCode === 404",
    to: "error.details?.statusCode === 400",
    command: unit("src/lib/esign/template-orchestrator.test.ts"),
  },
  {
    name: "restart classifier requires provider not_found",
    file: "src/lib/esign/provider-failure.ts",
    from: 'error.details?.providerCode === "not_found"',
    to: 'error.details?.providerCode === "bad_request"',
    command: unit("src/lib/esign/template-orchestrator.test.ts"),
  },
  {
    name: "restart classifier rejects explicitly retryable errors",
    file: "src/lib/esign/provider-failure.ts",
    from: "error.details?.retryable !== true",
    to: "error.details?.retryable === true",
    command: unit("src/lib/esign/template-orchestrator.test.ts"),
  },
  {
    name: "provider create keeps HTTP 408 ambiguous",
    file: "src/lib/esign/provider-failure.ts",
    from: "status === 408 ||",
    to: "false ||",
    command: unit("src/lib/esign/initial-template-provider-create.test.ts"),
  },
  {
    name: "provider create keeps HTTP 429 ambiguous",
    file: "src/lib/esign/provider-failure.ts",
    from: "status === 429\n",
    to: "false\n",
    command: unit("src/lib/esign/initial-template-provider-create.test.ts"),
  },
  {
    name: "SDK normalization preserves provider error_name",
    file: "src/lib/esign/dropbox-sign.ts",
    from: "providerCode: error.body?.error?.errorName,",
    to: "providerCode: undefined,",
    command: unit("src/lib/esign/dropbox-sign-template.test.ts"),
  },
  {
    name: "template preflight classifies a lost initial draft",
    file: "src/lib/esign/template-orchestrator.ts",
    from: "ports.provider.isRestartableEditorSessionError(error)",
    to: "false",
    expected: 2,
    command: unit("src/lib/esign/template-orchestrator.test.ts"),
  },
  {
    name: "original retirement runs before replacement provider create",
    file: "src/lib/esign/template-initial-runtime.ts",
    from: "if (input.beforeProviderCreate) {",
    to: "if (false && input.beforeProviderCreate) {",
    command: unit("src/lib/esign/template-initial-runtime.test.ts"),
  },
  {
    name: "restart records durable local retirement",
    file: "src/lib/esign/template-orchestrator.ts",
    from: "if (!(await ports.repository.markAbandoned(access.data.orgId, templateId))) {",
    to: "if (false) {",
    command: unit("src/lib/esign/template-orchestrator.test.ts"),
  },
  {
    name: "abandoned replay remains cleanup-only",
    file: "src/lib/esign/template-orchestrator.ts",
    from: 'if (draft.lifecycle === "abandoned") {\n        return cleanupSource(ports, draft);\n      }',
    to: 'if (draft.lifecycle === "abandoned") {\n        return success(null);\n      }',
    command: unit("src/lib/esign/template-orchestrator.test.ts"),
  },
  {
    name: "post-retirement restart can resume",
    file: "src/lib/esign/template-initial-runtime.ts",
    from: '![' + '"editing", "abandoned"' + '].includes(draft.lifecycle_state)',
    to: 'draft.lifecycle_state !== "editing"',
    command: unit("src/lib/esign/template-initial-runtime.test.ts"),
  },
  {
    name: "one original uses one durable replacement reservation",
    file: "src/lib/esign/template-initial-runtime.ts",
    from: "const replacementSourceId = templateId;",
    to: 'const replacementSourceId = "different-reservation";',
    command: unit("src/lib/esign/template-initial-runtime.test.ts"),
  },
  {
    name: "placement-restart lookup is org scoped",
    file: "src/lib/esign/template-foundation-adapter.ts",
    from: '.select("staging_source_id")\n          .eq("org_id", orgId)',
    to: '.select("staging_source_id")',
    command: unit("src/lib/esign/template-foundation-adapter.test.ts"),
  },
  {
    name: "concurrent provider claim never reinvokes",
    file: "src/lib/esign/initial-template-provider-create.ts",
    from: 'if (claim.outcome === "already_in_progress") {',
    to: 'if (false && claim.outcome === "already_in_progress") {',
    command: unit("src/lib/esign/initial-template-provider-create.test.ts"),
  },
  {
    name: "definitive 4xx uses the released-attempt transition",
    file: "src/lib/esign/initial-template-provider-create.ts",
    from: 'if (classifyProviderFailure(error) === "definitive_failure") {',
    to: "if (false) {",
    command: unit("src/lib/esign/initial-template-provider-create.test.ts"),
  },
  {
    name: "SQL update keeps the exact token fence",
    file: "supabase/migrations/20260901181004_record_definitive_esign_template_provider_create_failure.sql",
    from: "template.provider_create_claim_token_hash = v_token_hash;",
    to: "template.provider_create_claim_token_hash is not null;",
    command: unit("src/lib/esign/definitive-provider-failure-migration.test.ts"),
  },
  {
    name: "SQL retry listing requires the tagged unknown attempt fence",
    file: "supabase/migrations/20260901181004_record_definitive_esign_template_provider_create_failure.sql",
    from: "and template.provider_create_claim_token_hash is not null\n    and template.provider_create_last_released_token_hash is null",
    to: "and template.provider_create_claim_token_hash is null\n    and template.provider_create_last_released_token_hash is null",
    command: unit("src/lib/esign/definitive-provider-failure-migration.test.ts"),
  },
  {
    name: "SQL retry begins without a stranded claimed gap",
    file: "supabase/migrations/20260901181004_record_definitive_esign_template_provider_create_failure.sql",
    from: "set provider_create_state = 'invoking',",
    to: "set provider_create_state = 'claimed',",
    command: unit("src/lib/esign/definitive-provider-failure-migration.test.ts"),
  },
  {
    name: "runtime retry rechecks the definitive-failure tag",
    file: "src/lib/esign/template-initial-runtime.ts",
    from: 'draft.provider_create_error_code !== "PROVIDER_REQUEST_REJECTED" ||',
    to: "false ||",
    command: unit("src/lib/esign/template-initial-runtime.test.ts"),
  },
  {
    name: "Retry setup stores the session before routing",
    file: "src/app/(dashboard)/settings/esign-templates/pending-template-copies.tsx",
    from: "sessions.put(\n            result.data.templateId,\n            result.data.initialEditorSession,\n          );",
    to: "void result.data.initialEditorSession;",
    command: rtl("src/app/(dashboard)/settings/esign-templates/pending-template-copies.test.tsx"),
  },
  {
    name: "retry refuses a missing one-time editor session",
    file: "src/lib/esign/template-initial-runtime.ts",
    from: "if (!result.data.initialEditorSession) {",
    to: "if (false && !result.data.initialEditorSession) {",
    command: unit("src/lib/esign/template-initial-runtime.test.ts"),
  },
];

function replaceExactly(source, mutation) {
  const occurrences = source.split(mutation.from).length - 1;
  const expected = mutation.expected ?? (mutation.all ? 2 : 1);
  if (occurrences !== expected) {
    throw new Error(
      `${mutation.name}: expected ${expected} mutation target(s), found ${occurrences}`,
    );
  }
  return mutation.all
    ? source.split(mutation.from).join(mutation.to)
    : source.replace(mutation.from, mutation.to);
}

function parseVitestReport(stdout) {
  const output = String(stdout ?? "").trim();
  const candidates = [output, ...output.split("\n").reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const report = JSON.parse(candidate);
      if (
        typeof report.success === "boolean" &&
        typeof report.numFailedTests === "number"
      ) {
        return report;
      }
    } catch {
      // A test may log before Vitest emits its single-line JSON report.
    }
  }
  return null;
}

function runOwningTests(command) {
  const options = {
    cwd: sandbox,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  };
  try {
    const stdout = execFileSync("npx", command, options);
    const report = parseVitestReport(stdout);
    if (!report) {
      throw new Error(
        `Owning test command completed without a Vitest JSON report: npx ${command.join(" ")}`,
      );
    }
    return { exitCode: 0, report };
  } catch (error) {
    if (error.signal || error.killed) {
      throw new Error(
        `Owning test command timed out or was killed: npx ${command.join(" ")}`,
      );
    }
    const report = parseVitestReport(error.stdout);
    if (!report) {
      throw new Error(
        `Owning test command failed without a Vitest JSON report: npx ${command.join(" ")}`,
      );
    }
    return { exitCode: Number(error.status ?? 1), report };
  }
}

try {
  execFileSync(
    "rsync",
    [
      "-a",
      "--exclude=.git",
      "--exclude=.next",
      "--exclude=.env*",
      "--exclude=.vercel",
      "--exclude=node_modules",
      "--exclude=test-results",
      "--exclude=*.pem",
      "--exclude=*.key",
      "--exclude=*.p12",
      "--exclude=*.pfx",
      "--exclude=credentials*.json",
      "--exclude=service-account*.json",
      `${root}/`,
      `${sandbox}/`,
    ],
    { stdio: "ignore" },
  );
  symlinkSync(join(root, "node_modules"), join(sandbox, "node_modules"));

  const baselineCommands = new Map(
    mutations.map((mutation) => [mutation.command.join("\0"), mutation.command]),
  );
  for (const command of baselineCommands.values()) {
    const baseline = runOwningTests(command);
    if (baseline.exitCode !== 0 || baseline.report.success !== true) {
      throw new Error(
        `Baseline test command failed before mutation: npx ${command.join(" ")}`,
      );
    }
  }
  console.log(`BASELINE OK: ${baselineCommands.size} owning test commands`);

  for (const [index, mutation] of mutations.entries()) {
    const target = join(sandbox, mutation.file);
    const original = readFileSync(target, "utf8");
    writeFileSync(target, replaceExactly(original, mutation));
    let result;
    try {
      result = runOwningTests(mutation.command);
    } finally {
      writeFileSync(target, original);
    }
    if (result.exitCode === 0) {
      throw new Error(`SURVIVED ${index + 1}/${mutations.length}: ${mutation.name}`);
    }
    if (result.report.numFailedTests < 1) {
      throw new Error(
        `INVALID KILL ${index + 1}/${mutations.length}: ${mutation.name} failed without an assertion failure`,
      );
    }
    console.log(`KILLED ${index + 1}/${mutations.length}: ${mutation.name}`);
  }
  console.log(`OK: ${mutations.length}/${mutations.length} mutations killed`);
} finally {
  cleanupSandbox();
}
