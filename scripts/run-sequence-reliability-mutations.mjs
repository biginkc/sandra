#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE_CLI_VERSION = "2.116.0";
const LOOPBACK_API_URL = "http://127.0.0.1:54321";
const LOOPBACK_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
// Supabase composes service names from the project name with a realtime
// prefix. Keep a conservative 45-character project bound for generated names
// while preserving the unique suffix; this does not prove a startup cause.
const MAX_SUPABASE_PROJECT_NAME_LENGTH = 45;
const SUPABASE_EXCLUDES = [
  "studio",
  "postgres-meta",
  "realtime",
  "edge-runtime",
  "logflare",
  "vector",
  "mailpit",
  "imgproxy",
];

const mutationDefinitions = {
  "claim-uniqueness-removed": {
    kind: "postflight-ddl",
    name: "remove active sequence claim uniqueness",
    target: {
      file: "src/lib/sequences/reliability.integration.test.ts",
      pattern: "uses one provider invocation in 20 synchronized two-client claim trials",
      expectedFullName: /uses one provider invocation in 20 synchronized two-client claim trials/,
      expectedFailure: /(?:length of 1|to be 1|provider invocation|claim)/i,
      expectedFailureMarkers: [
        "      expect(\n        summaries.reduce((count, summary) => count + (summary.outcomes.sent ?? 0), 0),\n      ).toBe(1);",
        "expect(providerInvocations).toHaveLength(trial + 1);",
        "expect(runCount).toBe(1);",
      ],
    },
    controls: [
      {
        file: "src/lib/sequences/reliability.integration.test.ts",
        pattern: "fires two SMS steps and a due status-change step",
      },
      {
        file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
        pattern: "repairs a missing referenced template through resume",
      },
    ],
    sql: "drop index if exists public.idx_step_runs_active_enrollment_step",
    restore: "supabase db reset --yes",
  },
  "advancement-suppressed": {
    kind: "source",
    name: "suppress successful native advancement",
    file: "src/lib/sequences/tick.ts",
    from: "const advanceError = await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);",
    to: "const advanceError = null;",
    expected: 2,
    anchor: "Message ${messageId} accepted;",
    target: {
      file: "src/lib/sequences/reliability.integration.test.ts",
      pattern: "fires two SMS steps and a due status-change step",
      expectedFullName: /fires two SMS steps and a due status-change step/,
      // Chai abbreviates the actual/expected objects in Vitest's diagnostic
      // (`expected { …(5) } to match object { status: 'active', …(1) }`),
      // so the source marker below carries the field-specific contract.
      expectedFailure: /(?:completed|current_step_index|next_run_at|length of 3|to match object)/i,
      expectedFailureMarker: "expect(enrollment).toMatchObject({ status: \"active\", current_step_index: 1 });",
    },
    controls: [
      {
        file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
        pattern: "fails closed for an unknown state and leaves the provider untouched",
      },
      {
        file: "src/lib/sequences/reliability.integration.test.ts",
        pattern: "does not send when a reply pauses the enrollment after the scheduler snapshot",
        sourcePattern: "does not send when a %s pauses the enrollment after the scheduler snapshot",
      },
    ],
  },
  "final-authorization-removed": {
    kind: "source",
    name: "remove native final authorization fence",
    file: "src/lib/messaging/send.ts",
    from: "  if (input.sequenceContext) {",
    to: "  if (false && input.sequenceContext) {",
    expected: 1,
    target: {
      file: "src/lib/sequences/reliability.integration.test.ts",
      pattern: "does not send when a reply pauses the enrollment after the scheduler snapshot",
      sourcePattern: "does not send when a %s pauses the enrollment after the scheduler snapshot",
      expectedFullName: /does not send when a reply pauses the enrollment after the scheduler snapshot/,
      expectedFailure: /(?:length of 0|provider|paused|definitively_rejected)/i,
      expectedFailureMarkers: [
        "expect(outcome.status).toBe(\"paused\");",
        "expect(providerInvocations).toHaveLength(0);",
      ],
    },
    controls: [
      {
        file: "src/app/api/cron/sequence-tick/route.integration.test.ts",
        pattern: "fires step 0 of a due enrollment and advances to step 1",
      },
      {
        file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
        pattern: "repairs missing sender inventory through resume",
      },
    ],
  },
  "persistence-error-ignored": {
    kind: "source",
    name: "ignore native accepted-message receipt persistence errors",
    file: "src/lib/messaging/send.ts",
    from: "    if (updateError || !updated) {",
    to: "    if (false) {",
    expected: 2,
    anchor: "pending.id",
    target: {
      file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
      pattern: "keeps an accepted provider attempt reconciliable when message receipt persistence returns a DB error",
      expectedFullName: /keeps an accepted provider attempt reconciliable when message receipt persistence returns a DB error/,
      expectedFailure: /(?:reconciliation_required|accepted|pending|failed|sent|to be 1|length of 1)/i,
      expectedFailureMarker: "expect(first.outcomes.failed).toBe(1);",
    },
    controls: [
      {
        file: "src/lib/sequences/reliability.integration.test.ts",
        pattern: "fires two SMS steps and a due status-change step",
      },
      {
        file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
        pattern: "repairs missing sender inventory through resume",
      },
    ],
  },
  "unsafe-ambiguous-retry": {
    kind: "migration",
    name: "allow retry of an ambiguous accepted or unknown claim",
    file: "supabase/migrations/20260917110000_sequence_runtime_recovery.sql",
    from: "  if prior.id is not null and (\n       prior.attempt_outcome not in ('not_attempted', 'definitively_rejected')\n     ) then",
    to: "  if false then",
    expected: 1,
    target: {
      file: "src/lib/sequences/reliability.integration.test.ts",
      pattern: "never blindly re-sends an accepted native SMS when claim receipt bookkeeping is ambiguous",
      expectedFullName: /never blindly re-sends an accepted native SMS when claim receipt bookkeeping is ambiguous/,
      expectedFailure: /(?:reconciliation_required|provider|length of 1|accepted)/i,
      expectedFailureMarker: "expect(ambiguousRetry).toMatchObject({ status: \"reconciliation_required\" });",
    },
    controls: [
      {
        file: "src/app/api/cron/sequence-tick/route.integration.test.ts",
        pattern: "fires step 0 of a due enrollment and advances to step 1",
      },
      {
        file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
        pattern: "fails closed for an unknown state and leaves the provider untouched",
      },
    ],
  },
  "suppression-bypassed": {
    kind: "source",
    name: "bypass the final automated suppression fence",
    file: "src/lib/messaging/send.ts",
    from: "  if (input.origin === \"automated\") {",
    to: "  if (false && input.origin === \"automated\") {",
    expected: 1,
    target: {
      runner: "vitest",
      file: "src/lib/messaging/send.integration.test.ts",
      pattern: "automated sends are blocked on a human-owned dispo",
      expectedFullName: /automated sends are blocked on a human-owned dispo/,
      expectedFailure: /(?:blocked_automated_suppressed|provider|length of 0|zero)/i,
      expectedFailureMarker: "expect(outcome.status).toBe(\"blocked_automated_suppressed\");",
    },
    controls: [
      {
        file: "src/lib/sequences/reliability.integration.test.ts",
        pattern: "fires two SMS steps and a due status-change step",
      },
      {
        file: "src/lib/sequences/scheduling-reliability.integration.test.ts",
        pattern: "fails closed for an unknown state and leaves the provider untouched",
      },
    ],
  },
  "ui-persistence-dropped": {
    kind: "source",
    name: "drop sequence description persistence from the UI save action",
    file: "src/app/(dashboard)/sequences/actions.ts",
    from: "    if (patch.description !== undefined) update.description = patch.description;",
    to: "    if (false && patch.description !== undefined) update.description = patch.description;",
    expected: 1,
    target: {
      runner: "playwright",
      file: "e2e/sequence-readiness.local.spec.ts",
      pattern: "create/edit/enroll then persist pause, resume, cancel, and reload",
      expectedFullName: /create\/edit\/enroll then persist pause, resume, cancel, and reload/,
      expectedFailure: /(?:Edited local description|description|persist|reload)/i,
      expectedFailureMarker: ".toBe(\"Edited local description\");",
    },
    controls: [
      {
        runner: "playwright",
        file: "e2e/sequence-readiness.local.spec.ts",
        pattern: "non-admin cannot enter sequence authoring",
        expectedFullName: /non-admin cannot enter sequence authoring/,
      },
      {
        runner: "playwright",
        file: "e2e/sequence-readiness.local.spec.ts",
        pattern: "browser context denies external HTTP before network",
        expectedFullName: /browser context denies external HTTP before network/,
      },
    ],
  },
};

function usage() {
  return [
    "Usage: node scripts/run-sequence-reliability-mutations.mjs --commit=<clean-candidate-sha> --mutation=<name>",
    "       node scripts/run-sequence-reliability-mutations.mjs --check-patches --mutation=<name>",
    "       node scripts/run-sequence-reliability-mutations.mjs --self-test-parser=<vitest-json>",
    "       node scripts/run-sequence-reliability-mutations.mjs --list",
    "",
    "This command executes one named mutant at a time in a fresh temporary worktree.",
    "It requires SANDRA_CANARY_DOCKER_HOST=unix:///path/to/dedicated/docker.sock.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = {
    artifactsDir: null,
    checkPatches: false,
    commit: null,
    list: false,
    mutation: null,
    parserReport: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--list") {
      result.list = true;
      continue;
    }
    if (argument === "--check-patches") {
      result.checkPatches = true;
      continue;
    }
    const [key, value] = argument.split("=", 2);
    if (key === "--commit") result.commit = value ?? argv[++index];
    else if (key === "--mutation") result.mutation = value ?? argv[++index];
    else if (key === "--artifacts-dir") result.artifactsDir = value ?? argv[++index];
    else if (key === "--self-test-parser") result.parserReport = value ?? argv[++index];
    else throw new Error(`Unknown argument ${argument}\n${usage()}`);
  }
  return result;
}

function scrub(value) {
  return String(value ?? "")
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:anon|service[_ -]?role|jwt[_ -]?secret|access[_ -]?token|api[_ -]?key)[^:=\n]*[:=])\s*[^\s,]+/gi, "$1 [REDACTED]");
}

function scrubJson(value) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, scrubJson(nested)]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createMutationProjectName(mutation, pid, timestamp) {
  const prefix = "seqmut-";
  const suffix = `${pid}-${timestamp}`;
  const availableLabelLength = MAX_SUPABASE_PROJECT_NAME_LENGTH - prefix.length - suffix.length - 1;
  if (availableLabelLength < 1) {
    throw new Error("Mutation project name cannot preserve its unique PID/timestamp suffix");
  }
  const label = mutation.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, availableLabelLength);
  if (!label) throw new Error("Mutation project name requires a non-empty mutation label");
  return `${prefix}${label}-${suffix}`;
}

function parseVitestReport(stdout, stderr) {
  const candidates = [
    ...String(stdout ?? "").split("\n").reverse(),
    ...String(stderr ?? "").split("\n").reverse(),
  ];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const report = JSON.parse(trimmed);
      if (
        typeof report.success === "boolean" &&
        Array.isArray(report.testResults)
      ) return normalizeVitestReport(report);
    } catch {
      // Vitest may print diagnostics around its single-line JSON report.
    }
  }
  return null;
}

function normalizeVitestReport(report) {
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults ?? []);
  const executed = assertions.filter((assertion) =>
    assertion.status === "passed" || assertion.status === "failed",
  );
  const failed = executed.filter((assertion) => assertion.status === "failed");
  // Vitest increments numFailedTestSuites for an ordinary assertion failure.
  // A failed suite is setup/import evidence only when it has no executed
  // assertion result; treating the aggregate count as setup failure would
  // reject every legitimate mutant kill.
  const failedSuitesWithoutExecutedAssertions = report.testResults.filter((suite) => {
    const suiteAssertions = suite.assertionResults ?? [];
    const hasExecutedAssertion = suiteAssertions.some((assertion) =>
      assertion.status === "passed" || assertion.status === "failed",
    );
    return !hasExecutedAssertion && suite.status === "failed";
  }).length;
  const setupFailures = failedSuitesWithoutExecutedAssertions > 0
    ? failedSuitesWithoutExecutedAssertions
    : executed.length === 0
      ? report.numFailedTestSuites ?? 0
      : 0;
  return {
    ...report,
    success: failed.length === 0 && executed.length > 0 && setupFailures === 0,
    numTotalTests: executed.length,
    numPassedTests: executed.length - failed.length,
    numFailedTests: failed.length,
    numPendingTests: assertions.length - executed.length,
    setupFailures,
    testResults: [{ assertionResults: executed }],
  };
}

function parseJsonDocument(stdout, stderr) {
  const text = `${String(stdout ?? "")}\n${String(stderr ?? "")}`.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function parsePlaywrightReport(stdout, stderr) {
  const report = parseJsonDocument(stdout, stderr);
  if (!report || !Array.isArray(report.suites)) return null;
  const assertions = [];
  function visitSuite(suite, ancestors = []) {
    const suiteTitle = typeof suite.title === "string" ? suite.title : "";
    const nextAncestors = suiteTitle ? [...ancestors, suiteTitle] : ancestors;
    for (const spec of suite.specs ?? []) {
      const fullName = [...nextAncestors, spec.title].filter(Boolean).join(" ");
      const tests = spec.tests ?? [];
      for (const test of tests) {
        if (test.outcome === "skipped" || (test.results ?? []).length === 0) continue;
        const failed =
          test.outcome === "unexpected" ||
          (test.results ?? []).some((result) => result.status !== "passed");
        const failureMessages = (test.results ?? []).flatMap((result) => {
          const error = result.error;
          if (!error) return [];
          return [error.stack ?? error.message ?? String(error)];
        });
        assertions.push({ fullName, failureMessages, failed });
      }
    }
    for (const child of suite.suites ?? []) visitSuite(child, nextAncestors);
  }
  for (const suite of report.suites) visitSuite(suite);
  const failed = assertions.filter((assertion) => assertion.failed);
  return {
    success: assertions.length > 0 && failed.length === 0 && (report.errors ?? []).length === 0,
    numTotalTests: assertions.length,
    numFailedTests: failed.length,
    setupFailures: (report.errors ?? []).length,
    testResults: [{ assertionResults: assertions }],
  };
}

function reportAssertions(report) {
  return (report?.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
}

function reportFailureMessages(report) {
  return reportAssertions(report).flatMap((assertion) => assertion.failureMessages ?? []);
}

function hasAssertionDiagnostic(messages, runner = "vitest") {
  return messages.some((message) => {
    const firstLine = String(message).split(/\r?\n/, 1)[0].trim();
    if (/^(?:TypeError|ReferenceError|SyntaxError):/i.test(firstLine)) return false;
    if (runner === "playwright") {
      return /^Error:\s*expect(?:\(|[.(]).*\.(?:to|not)[A-Za-z]*/i.test(firstLine);
    }
    return /^AssertionError:\s*expected\b/i.test(firstLine);
  });
}

function sourceLineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function sourceLinesForRange(source, start, end) {
  const first = sourceLineAt(source, start);
  const last = sourceLineAt(source, end);
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

function selectedSourceEnd(source, selectedIndex, selector) {
  const nextTestIndex = source.slice(selectedIndex + selector.length).search(
    /\n\s*(?:it|test)(?:\.each)?\s*\(/,
  );
  return nextTestIndex < 0
    ? source.length
    : selectedIndex + selector.length + nextTestIndex;
}

function assertionMarkers(spec) {
  return spec.expectedFailureMarkers ?? (spec.expectedFailureMarker ? [spec.expectedFailureMarker] : []);
}

async function validateMutationMarkers(mutation) {
  const specs = [mutation.target, ...(mutation.controls ?? [])];
  for (const spec of specs) {
    const markers = assertionMarkers(spec);
    if (markers.length === 0) continue;
    const source = await readFile(path.join(root, spec.file), "utf8");
    const selector = spec.sourcePattern ?? spec.pattern;
    const selectedIndex = source.indexOf(selector);
    const selectedEnd = selectedIndex < 0
      ? -1
      : selectedSourceEnd(source, selectedIndex, selector);
    const markerIndexes = selectedIndex < 0
      ? []
      : markers.map((marker) => source.indexOf(marker, selectedIndex))
        .filter((markerIndex) => markerIndex >= 0 && markerIndex < selectedEnd);
    if (selectedIndex < 0 || markerIndexes.length !== markers.length) {
      throw new Error(`${mutation.name}: assertion marker is not contained by ${spec.file} :: ${selector}`);
    }
  }
}

async function assertFailureAtSelectedAssertion(result, label, spec, sourceRoot = worktree) {
  const markers = assertionMarkers(spec);
  if (markers.length === 0) {
    throw new Error(`${label}: mutation manifest is missing an assertion source marker`);
  }
  const source = await readFile(path.join(sourceRoot, spec.file), "utf8");
  const selector = spec.sourcePattern ?? spec.pattern;
  const selectedIndex = source.indexOf(selector);
  if (selectedIndex < 0) {
    throw new Error(`${label}: selected source pattern is missing from ${spec.file}`);
  }
  const selectedEnd = selectedSourceEnd(source, selectedIndex, selector);
  const markerIndexes = markers.map((marker) => source.indexOf(marker, selectedIndex));
  if (markerIndexes.some((markerIndex) => markerIndex < 0 || markerIndex >= selectedEnd)) {
    throw new Error(`${label}: expected assertion marker is outside the selected test in ${spec.file}`);
  }
  const markerLines = markerIndexes.flatMap((markerIndex, index) =>
    sourceLinesForRange(source, markerIndex, markerIndex + markers[index].length),
  );
  const locations = [];
  const targetToken = spec.file.replaceAll("\\", "/");
  const locationPattern = new RegExp(
    `${escapeRegex(targetToken)}(?::|\\()([0-9]+)(?::[0-9]+)?`,
    "g",
  );
  for (const message of reportFailureMessages(result.report)) {
    const normalized = String(message).replaceAll("\\", "/");
    for (const match of normalized.matchAll(locationPattern)) locations.push(Number(match[1]));
  }
  if (!locations.some((line) => markerLines.includes(line))) {
    throw new Error(
      `${label}: failed assertion did not point at ${spec.file}:${markerLines.join(" or ")}; ` +
      `source locations were ${locations.join(", ") || "none"}`,
    );
  }
}

function assertOnePassingTest(result, label, expectedFullName) {
  if (result.exitCode !== 0 || !result.report || !result.report.success) {
    throw new Error(`${label}: positive control failed or produced no valid report`);
  }
  if (result.report.setupFailures > 0) {
    throw new Error(`${label}: setup/collection failures are not valid positive-control evidence`);
  }
  const assertions = reportAssertions(result.report);
  if (assertions.length !== 1 || result.report.numTotalTests !== 1 || result.report.numFailedTests !== 0) {
    throw new Error(`${label}: expected exactly one passing selected test`);
  }
  if (expectedFullName && !expectedFullName.test(assertions[0].fullName ?? "")) {
    throw new Error(`${label}: passing test fullName did not match the selected contract`);
  }
  if ((assertions[0].failureMessages ?? []).length > 0) {
    throw new Error(`${label}: passing test contained failure diagnostics`);
  }
}

async function assertOneAssertionFailure(result, label, expectedFailure, expectedFullName, spec, options = {}) {
  if (!result.report || result.report.numTotalTests !== 1 || result.report.numFailedTests !== 1) {
    throw new Error(`${label}: mutation did not produce exactly one selected assertion failure`);
  }
  if (result.report.setupFailures > 0) {
    throw new Error(`${label}: setup/collection failures are not mutation evidence`);
  }
  const assertions = reportAssertions(result.report);
  if (assertions.length !== 1) {
    throw new Error(`${label}: expected exactly one selected assertion diagnostic`);
  }
  if (expectedFullName && !assertions.some((assertion) => expectedFullName.test(assertion.fullName ?? ""))) {
    throw new Error(`${label}: failed assertion fullName did not match the selected contract`);
  }
  const messages = reportFailureMessages(result.report);
  if (messages.length === 0) throw new Error(`${label}: failure had no assertion diagnostics`);
  if (!hasAssertionDiagnostic(messages, spec.runner ?? "vitest")) {
    throw new Error(`${label}: failure was a plain thrown error rather than a matcher assertion`);
  }
  const infrastructure = /failed to load|cannot find module|transform failed|unexpected token|syntaxerror|compile|econnrefused|connection refused|startup|timed out|no test files/i;
  if (messages.some((message) => infrastructure.test(message))) {
    throw new Error(`${label}: mutation produced infrastructure/compile failure instead of assertion failure`);
  }
  const fixtureErrorNull = /(?:error|insert|update|delete).{0,100}(?:to be null|toBeNull|to be `null`)/is;
  if (messages.some((message) => fixtureErrorNull.test(message))) {
    throw new Error(`${label}: failure matches a fixture/database-error null assertion rather than the mutation contract`);
  }
  if (expectedFailure && !messages.some((message) => expectedFailure.test(message))) {
    throw new Error(`${label}: failure did not match the expected mutation assertion`);
  }
  await assertFailureAtSelectedAssertion(result, label, spec, options.sourceRoot);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function expectRejected(label, callback, messagePattern) {
  let caught;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error(`${label}: expected the contract check to reject`);
  if (messagePattern && !messagePattern.test(String(caught.message))) {
    throw new Error(`${label}: rejection did not identify the expected contract violation: ${caught.message}`);
  }
}

async function selfTestMutationFailureClassification(realReport) {
  const spec = mutationDefinitions["advancement-suppressed"].target;
  const source = await readFile(path.join(root, spec.file), "utf8");
  const markerIndex = source.indexOf(assertionMarkers(spec)[0]);
  if (markerIndex < 0) throw new Error("advancement mutation self-test marker is missing from the source");
  const markerLine = sourceLineAt(source, markerIndex);
  const representativeMessage = (firstLine, line = markerLine) =>
    `${firstLine}\n    at /tmp/sequence-mutation/${spec.file}:${line}:24`;
  const selectedFailure = reportAssertions(realReport).find((assertion) =>
    assertion.status === "failed" && spec.expectedFullName.test(assertion.fullName ?? ""),
  );
  const report = selectedFailure
    ? realReport
    : {
        success: false,
        numTotalTests: 1,
        numFailedTests: 1,
        setupFailures: 0,
        testResults: [{
          assertionResults: [{
            fullName: "native sequence lifecycle and due scheduling fires two SMS steps and a due status-change step, then completes the enrollment",
            status: "failed",
            failureMessages: [representativeMessage("AssertionError: expected { …(5) } to match object { status: 'active', …(1) }")],
          }],
        }],
      };
  const result = { exitCode: 1, report };
  await assertOneAssertionFailure(
    result,
    "advancement mutation assertion",
    spec.expectedFailure,
    spec.expectedFullName,
    spec,
    { sourceRoot: root },
  );

  const withMessage = (message) => {
    const mutated = cloneJson(report);
    mutated.testResults[0].assertionResults[0].failureMessages = [message];
    return { exitCode: 1, report: mutated };
  };
  await expectRejected(
    "advancement wrong assertion line",
    () => assertOneAssertionFailure(
      withMessage(
        representativeMessage(
          "AssertionError: expected { …(5) } to match object { status: 'active', …(1) }",
          markerLine - 1,
        ),
      ),
      "advancement wrong line",
      spec.expectedFailure,
      spec.expectedFullName,
      spec,
      { sourceRoot: root },
    ),
    /failed assertion did not point/,
  );
  await expectRejected(
    "advancement plain thrown error",
    () => assertOneAssertionFailure(
      withMessage(
        representativeMessage("Error: expected { …(5) } to match object { status: 'active', …(1) }"),
      ),
      "advancement plain throw",
      spec.expectedFailure,
      spec.expectedFullName,
      spec,
      { sourceRoot: root },
    ),
    /plain thrown error/,
  );
  await expectRejected(
    "advancement infrastructure error",
    () => assertOneAssertionFailure(
      withMessage(
        representativeMessage("AssertionError: expected compile to succeed"),
      ),
      "advancement infrastructure",
      spec.expectedFailure,
      spec.expectedFullName,
      spec,
      { sourceRoot: root },
    ),
    /infrastructure\/compile failure/,
  );
  return selectedFailure ? "actual-report" : "representative-fixture";
}

function selfTestMutationProjectName() {
  const longest = createMutationProjectName(
    "final-authorization-removed",
    2286,
    "mu5jxjdm",
  );
  if (longest.length > MAX_SUPABASE_PROJECT_NAME_LENGTH ||
      !longest.endsWith("-2286-mu5jxjdm")) {
    throw new Error("Mutation project-name self-test did not preserve the bounded unique suffix");
  }
  const otherPid = createMutationProjectName(
    "final-authorization-removed",
    2287,
    "mu5jxjdm",
  );
  if (longest === otherPid) {
    throw new Error("Mutation project-name self-test collapsed distinct PID values");
  }
  return { longest, otherPid };
}

function parseStatusJson(stdout) {
  const text = String(stdout ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("Supabase status did not return JSON");
  }
}

function commandSlug(command, args) {
  return `${command}-${args.join("-")}`.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

let activeChild;
let cancelled = false;
let cleaning = false;
let commandCounter = 0;
let artifactsDir;
let supabaseStartAttempted = false;
const forceKillTimers = new Map();

function terminate(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") console.error(`Could not terminate child group: ${error.message}`);
  }
  if (!forceKillTimers.has(child.pid)) {
    const forceTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") console.error(`Could not force-terminate child group: ${error.message}`);
      }
    }, 10_000);
    forceTimer.unref();
    forceKillTimers.set(child.pid, forceTimer);
  }
}

async function run(command, args, options = {}) {
  if (cancelled && !cleaning) throw new Error("Mutation run cancelled");
  const cwd = options.cwd ?? root;
  const env = options.env ?? baseEnv;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const id = `${String(++commandCounter).padStart(3, "0")}-${options.label ?? commandSlug(command, args)}`;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, timeoutMs);
    timer.unref();
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const forceTimer = forceKillTimers.get(child.pid);
      if (forceTimer) clearTimeout(forceTimer);
      forceKillTimers.delete(child.pid);
      activeChild = undefined;
      resolve({ code: code ?? 1, signal });
    });
  });
  const safeStdout = scrub(stdout);
  const safeStderr = scrub(stderr);
  if (artifactsDir) {
    await writeFile(path.join(artifactsDir, `${id}.stdout.log`), safeStdout);
    await writeFile(path.join(artifactsDir, `${id}.stderr.log`), safeStderr);
  }
  if (timedOut) throw new Error(`${command} ${args.join(" ")} timed out`);
  if (cancelled && !cleaning) throw new Error(`${command} ${args.join(" ")} cancelled`);
  return { command, args, cwd, exitCode: result.code, signal: result.signal, stdout, stderr };
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Port ${port} availability check timed out`));
    }, 2_000);
    timeout.unref();
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error(`Port ${port} is already occupied; refusing to attach to an unknown process`));
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new Error(`Port ${port} availability check failed: ${error.message}`));
    });
  });
}

async function checkCurrentPatch(mutation) {
  const substitution = {
    file: mutation.file ?? null,
    kind: mutation.kind,
    expected: mutation.expected ?? null,
    occurrences: null,
    anchorOccurrences: null,
  };
  if (mutation.file && mutation.from) {
    const target = path.join(root, mutation.file);
    const original = await readFile(target, "utf8");
    const occurrences = original.split(mutation.from).length - 1;
    const mutantOccurrences = original.split(mutation.to).length - 1;
    substitution.occurrences = occurrences;
    if (occurrences !== (mutation.expected ?? 1)) {
      throw new Error(`${mutation.name}: dry-run expected ${mutation.expected ?? 1} exact source occurrence(s), found ${occurrences}`);
    }
    if (mutantOccurrences !== 0) {
      throw new Error(`${mutation.name}: dry-run found an already-applied mutant substitution`);
    }
    if (mutation.anchor) {
      const positions = [];
      let searchFrom = 0;
      while (true) {
        const position = original.indexOf(mutation.from, searchFrom);
        if (position < 0) break;
        positions.push(position);
        searchFrom = position + mutation.from.length;
      }
      const anchored = positions.filter((position) =>
        original.slice(position, position + 1200).includes(mutation.anchor),
      );
      substitution.anchorOccurrences = anchored.length;
      if (anchored.length !== 1) {
        throw new Error(`${mutation.name}: dry-run expected one source occurrence adjacent to anchor, found ${anchored.length}`);
      }
    }
  }
  const specs = [mutation.target, ...(mutation.controls ?? [])];
  for (const spec of specs) {
    const source = await readFile(path.join(root, spec.file), "utf8");
    const sourcePattern = spec.sourcePattern ?? spec.pattern;
    if (!source.includes(sourcePattern)) {
      throw new Error(`${mutation.name}: dry-run selected test pattern is missing: ${spec.file} :: ${sourcePattern}`);
    }
  }
  await validateMutationMarkers(mutation);
  if (mutation.kind === "postflight-ddl" && !mutation.sql) {
    throw new Error(`${mutation.name}: dry-run postflight mutation has no SQL manifest`);
  }
  console.log(`[sequence-mutation] PATCH_CHECK ${JSON.stringify({
    mutation: mutation.name,
    ...substitution,
    selectedTests: specs.map((spec) => ({ runner: spec.runner ?? "vitest", file: spec.file, pattern: spec.pattern })),
  })}`);
}

async function selfTestParser(reportPath) {
  await validateMutationMarkers({
    name: "all mutation contracts",
    target: Object.values(mutationDefinitions)[0].target,
    controls: Object.values(mutationDefinitions).flatMap((mutation) => [
      mutation.target,
    ]),
  });
  const realReport = parseVitestReport(await readFile(reportPath, "utf8"), "");
  if (!realReport || realReport.numTotalTests < 1) {
    throw new Error("Parser self-test could not normalize the real Vitest report");
  }
  const projectNameCheck = selfTestMutationProjectName();
  const mutationClassification = await selfTestMutationFailureClassification(realReport);
  if (realReport.numFailedTests > 0) {
    if (realReport.numFailedTests !== 1 || realReport.setupFailures !== 0) {
      throw new Error("Parser self-test misclassified the real assertion failure as setup/infrastructure failure");
    }
  } else if (!realReport.success) {
    throw new Error("Parser self-test could not normalize the real passing Vitest report");
  }
  const passingWithSkipped = normalizeVitestReport({
    success: true,
    numFailedTestSuites: 0,
    testResults: [{
      status: "passed",
      assertionResults: [
        { fullName: "selected passing test", status: "passed", failureMessages: [] },
        { fullName: "filtered pending test", status: "pending", failureMessages: [] },
        { fullName: "filtered todo test", status: "todo", failureMessages: [] },
      ],
    }],
  });
  if (!passingWithSkipped.success || passingWithSkipped.numTotalTests !== 1 || passingWithSkipped.numFailedTests !== 0) {
    throw new Error("Parser self-test did not exclude pending/todo Vitest assertions");
  }
  const selectedFailure = normalizeVitestReport({
    success: false,
    numFailedTestSuites: 0,
    testResults: [{
      status: "failed",
      assertionResults: [
        {
          fullName: "selected failing test",
          status: "failed",
          failureMessages: ["AssertionError: expected actual to be contract\n    at selected.test.ts:1:1"],
        },
        { fullName: "filtered skipped test", status: "skipped", failureMessages: [] },
      ],
    }],
  });
  if (selectedFailure.success || selectedFailure.numTotalTests !== 1 || selectedFailure.numFailedTests !== 1) {
    throw new Error("Parser self-test did not retain the selected Vitest failure");
  }
  if (selectedFailure.setupFailures !== 0) {
    throw new Error("Parser self-test misclassified an ordinary assertion failure as setup failure");
  }
  if (!hasAssertionDiagnostic(reportFailureMessages(selectedFailure), "vitest")) {
    throw new Error("Parser self-test did not recognize the representative Vitest matcher diagnostic");
  }
  if (hasAssertionDiagnostic(["TypeError: claim fixture unavailable\n    at reliability.integration.test.ts:1:1"], "vitest")) {
    throw new Error("Parser self-test accepted a plain fixture TypeError as matcher evidence");
  }
  if (hasAssertionDiagnostic(["Error: expected claim fixture to be available\n    at reliability.integration.test.ts:1:1"], "vitest")) {
    throw new Error("Parser self-test accepted a plain Error as matcher evidence");
  }
  const setupFailure = normalizeVitestReport({
    success: false,
    numFailedTestSuites: 1,
    testResults: [{ status: "failed", assertionResults: [], message: "beforeEach failed" }],
  });
  if (setupFailure.success || setupFailure.numTotalTests !== 0 || setupFailure.setupFailures !== 1) {
    throw new Error("Parser self-test did not reject a Vitest setup failure");
  }
  const playwright = parsePlaywrightReport(JSON.stringify({
    errors: [],
    suites: [{
      title: "browser contract",
      specs: [{
        title: "selected passing test",
        tests: [
          { outcome: "expected", results: [{ status: "passed" }] },
          { outcome: "skipped", results: [] },
        ],
      }],
    }],
  }), "");
  if (!playwright?.success || playwright.numTotalTests !== 1 || playwright.numFailedTests !== 0) {
    throw new Error("Parser self-test did not exclude skipped Playwright tests");
  }
  const playwrightFailure = parsePlaywrightReport(JSON.stringify({
    errors: [],
    suites: [{
      title: "browser contract",
      specs: [{
        title: "selected failing test",
        tests: [{
          outcome: "unexpected",
          results: [{
            status: "failed",
            error: {
              stack: "Error: expect(locator).toHaveValue(expected)\n    at e2e/sequence-readiness.local.spec.ts:213:8",
            },
          }],
        }],
      }],
    }],
  }), "");
  if (!playwrightFailure || playwrightFailure.numFailedTests !== 1 ||
      !hasAssertionDiagnostic(reportFailureMessages(playwrightFailure), "playwright")) {
    throw new Error("Parser self-test did not recognize the representative Playwright matcher diagnostic");
  }
  console.log(`[sequence-mutation] PARSER_CHECK ${JSON.stringify({
    realVitestTests: realReport.numTotalTests,
    realVitestFailures: realReport.numFailedTests,
    skippedNormalization: passingWithSkipped.numTotalTests,
    failureNormalization: selectedFailure.numFailedTests,
    setupFailureNormalization: setupFailure.setupFailures,
    playwrightTests: playwright.numTotalTests,
    mutationClassification,
    projectNameCheck,
  })}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.list) {
  console.log(Object.keys(mutationDefinitions).join("\n"));
  process.exit(0);
}
if (args.parserReport) {
  await selfTestParser(args.parserReport);
  process.exit(0);
}

const selectedMutation = args.mutation ? mutationDefinitions[args.mutation] : null;
if (!selectedMutation) {
  throw new Error(`--mutation must name exactly one of: ${Object.keys(mutationDefinitions).join(", ")}`);
}
if (args.checkPatches) {
  await checkCurrentPatch(selectedMutation);
  process.exit(0);
}
if (!args.commit || !/^[0-9a-f]{7,40}$/i.test(args.commit)) {
  throw new Error("--commit=<clean candidate commit SHA> is required");
}

const dockerHost = process.env.SANDRA_CANARY_DOCKER_HOST;
if (!dockerHost || !dockerHost.startsWith("unix:///")) {
  throw new Error("A dedicated local Docker socket is required: set SANDRA_CANARY_DOCKER_HOST=unix:///...");
}
const dockerSocketPath = decodeURIComponent(new URL(dockerHost).pathname);
const dockerSocket = await stat(dockerSocketPath).catch(() => null);
if (!dockerSocket?.isSocket()) {
  throw new Error(`Dedicated Docker socket is missing or is not a Unix socket: ${dockerSocketPath}`);
}
const imageRegistry = process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY;
if (imageRegistry && imageRegistry !== "ghcr.io") {
  throw new Error("SUPABASE_INTERNAL_IMAGE_REGISTRY must be exactly ghcr.io when set");
}
const baseEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "CI", "GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
baseEnv.DOCKER_HOST = dockerHost;
baseEnv.CI = "1";
if (imageRegistry === "ghcr.io") baseEnv.SUPABASE_INTERNAL_IMAGE_REGISTRY = imageRegistry;

if (args.artifactsDir && path.resolve(args.artifactsDir).startsWith(`${root}${path.sep}`)) {
  throw new Error("Artifacts must be outside the current checkout");
}

const commit = args.commit;
function createMutationBrowserIdentity() {
  const useGitHubIdentity =
    /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? "") &&
    /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "");
  if (process.env.GITHUB_ACTIONS === "true" && !useGitHubIdentity) {
    throw new Error("Mutation browser acceptance requires numeric GitHub run identity.");
  }
  const runSlug = useGitHubIdentity
    ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : `local-${process.pid}-${sha256(`${args.mutation}:${commit}`).slice(0, 12)}`;
  return {
    runSlug,
    email: `e2e-ci+${runSlug}@bmhgroupkc.com`,
    password: `Mutation-${sha256(`${args.mutation}:${commit}:password`).slice(0, 40)}!Aa9`,
  };
}

const mutationBrowserIdentity = selectedMutation.target.runner === "playwright"
  ? createMutationBrowserIdentity()
  : null;
let worktree;
let stackStarted = false;
let testEnv;
let mutationRecord = null;
let worktreeParent;
let projectName;
const evidence = {
  status: "STARTING",
  mutation: args.mutation,
  name: selectedMutation.name,
  commit,
  sourceRoot: root,
  docker: {
    host: dockerHost,
    project: null,
    hostedDatabase: false,
    providerMode: "mock",
    imageRegistry: imageRegistry || "cli-default",
  },
  tests: { baselineBefore: [], mutant: [], baselineAfter: [] },
  commands: [],
  preflight: [],
};

async function git(argsForGit, options = {}) {
  const result = await run("git", argsForGit, { ...options, label: options.label ?? `git-${argsForGit.join("-")}` });
  if (result.exitCode !== 0) throw new Error(`git ${argsForGit.join(" ")} failed: ${scrub(result.stderr || result.stdout)}`);
  return result.stdout.trim();
}

async function verifyCandidate() {
  const currentStatus = await git(["status", "--porcelain=v1"]);
  if (currentStatus) throw new Error("Current checkout is dirty; mutation execution requires a clean pinned candidate");
  const head = await git(["rev-parse", "HEAD"]);
  const resolved = await git(["rev-parse", `${commit}^{commit}`]);
  if (head !== resolved) throw new Error(`Current HEAD ${head} does not equal requested candidate ${resolved}`);
  const worktreeStatus = await git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (worktreeStatus) throw new Error("Candidate checkout has uncommitted files");
  return resolved;
}

async function readPreflight(dbUrl, requireIndex = true) {
  if (dbUrl !== LOOPBACK_DB_URL) throw new Error("Mutation harness refused a non-loopback database URL");
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const [{ rows: metadata }, { rows: indexes }] = await Promise.all([
      client.query("select version() as version, current_database() as database, current_setting('transaction_isolation') as transaction_isolation"),
      client.query("select c.relname as name, pg_get_indexdef(c.oid) as definition from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('idx_step_runs_active_enrollment_step', 'idx_step_runs_unique_enrollment_step', 'idx_enrollments_unique_active') order by c.relname"),
    ]);
    const activeIndex = indexes.find((index) => index.name === "idx_step_runs_active_enrollment_step");
    if (requireIndex && !activeIndex) throw new Error("Preflight critical active claim uniqueness index is missing");
    return {
      postgresVersion: metadata[0]?.version ?? "UNKNOWN",
      database: metadata[0]?.database ?? "UNKNOWN",
      transactionIsolation: metadata[0]?.transaction_isolation ?? "UNKNOWN",
      indexes,
      activeClaimIndexPresent: Boolean(activeIndex),
    };
  } finally {
    await client.end();
  }
}

async function writeEvidence() {
  if (!artifactsDir) return;
  await writeFile(
    path.join(artifactsDir, "evidence.json"),
    `${JSON.stringify(scrubJson(evidence), null, 2)}\n`,
  );
}

async function applySourceMutation(mutation) {
  const target = path.join(worktree, mutation.file);
  const original = await readFile(target, "utf8");
  const occurrences = original.split(mutation.from).length - 1;
  if (occurrences !== (mutation.expected ?? 1)) {
    throw new Error(`${mutation.name}: expected ${mutation.expected ?? 1} mutation target(s), found ${occurrences}`);
  }
  let mutated;
  if (mutation.anchor) {
    const positions = [];
    let searchFrom = 0;
    while (true) {
      const position = original.indexOf(mutation.from, searchFrom);
      if (position < 0) break;
      positions.push(position);
      searchFrom = position + mutation.from.length;
    }
    const anchored = positions.filter((position) =>
      original.slice(position, position + 1200).includes(mutation.anchor),
    );
    if (anchored.length !== 1) {
      throw new Error(`${mutation.name}: expected one source occurrence adjacent to anchor ${mutation.anchor}, found ${anchored.length}`);
    }
    const position = anchored[0];
    mutated = `${original.slice(0, position)}${mutation.to}${original.slice(position + mutation.from.length)}`;
  } else {
    mutated = original.replace(mutation.from, mutation.to);
  }
  await writeFile(target, mutated);
  return {
    kind: mutation.kind,
    file: mutation.file,
    beforeSha256: sha256(original),
    afterSha256: sha256(mutated),
    from: mutation.from,
    to: mutation.to,
  };
}

async function resetDatabase() {
  const result = await run("supabase", ["db", "reset", "--workdir", worktree, "--yes"], {
    cwd: worktree,
    env: baseEnv,
    timeoutMs: 600_000,
    label: "supabase-db-reset",
  });
  if (result.exitCode !== 0) throw new Error(`Supabase DB reset failed: ${scrub(result.stderr || result.stdout)}`);
  await provisionOwner();
}

async function provisionOwner() {
  const result = await run("npx", ["tsx", "scripts/provision-disposable-canary-owner.ts"], {
    cwd: worktree,
    env: testEnv,
    timeoutMs: 120_000,
    label: "provision-disposable-owner",
  });
  if (result.exitCode !== 0) throw new Error(`Disposable owner provisioning failed: ${scrub(result.stderr || result.stdout)}`);
}

async function applyMutation() {
  if (selectedMutation.kind === "source" || selectedMutation.kind === "migration") {
    mutationRecord = await applySourceMutation(selectedMutation);
    await writeFile(path.join(artifactsDir, "mutation.patch.txt"), `${selectedMutation.file}\n--- ${selectedMutation.from}\n+++ ${selectedMutation.to}\n`);
    if (selectedMutation.kind === "migration") {
      evidence.mutationSetup = "migration patched after clean preflight, then disposable DB reset";
      await resetDatabase();
      const afterReset = await readPreflight(LOOPBACK_DB_URL, true);
      evidence.preflight.push({ phase: "after-mutation-reset", ...afterReset });
    }
    return;
  }
  if (selectedMutation.kind === "postflight-ddl") {
    const client = new Client({ connectionString: LOOPBACK_DB_URL, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      await client.query(selectedMutation.sql);
      const { rows } = await client.query("select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'idx_step_runs_active_enrollment_step'");
      if (rows.length) throw new Error("Claim uniqueness mutant did not remove the active index");
    } finally {
      await client.end();
    }
    mutationRecord = {
      kind: selectedMutation.kind,
      sql: selectedMutation.sql,
      beforeSha256: evidence.preflight.at(-1)?.indexes?.find((index) => index.name === "idx_step_runs_active_enrollment_step")?.definition
        ? sha256(evidence.preflight.at(-1).indexes.find((index) => index.name === "idx_step_runs_active_enrollment_step").definition)
        : null,
      afterSha256: null,
    };
    evidence.mutationSetup = "active claim uniqueness removed after clean DB preflight via owned local SQL session";
    await writeFile(path.join(artifactsDir, "mutation.patch.txt"), `${selectedMutation.sql};\n`);
    return;
  }
  throw new Error(`Unsupported mutation kind ${selectedMutation.kind}`);
}

async function restoreMutation() {
  if (selectedMutation.kind === "source" || selectedMutation.kind === "migration") {
    const target = path.join(worktree, selectedMutation.file);
    const mutated = await readFile(target, "utf8");
    const occurrences = mutated.split(selectedMutation.to).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${selectedMutation.name}: expected one mutant marker while restoring, found ${occurrences}`);
    }
    const restored = mutated.replace(selectedMutation.to, selectedMutation.from);
    await writeFile(target, restored);
  }
  // Reset every mutant DB before baseline-after. This restores DDL mutants,
  // migration mutants, tenant rows, Auth owner state, and any test residue.
  await resetDatabase();
  const restoredPreflight = await readPreflight(LOOPBACK_DB_URL, true);
  evidence.preflight.push({ phase: "after-restore", ...restoredPreflight });
}

function browserTestEnvironment() {
  if (!mutationBrowserIdentity) {
    throw new Error("Browser test environment requested for a non-browser mutation");
  }
  const environment = {
    ...testEnv,
    E2E_RUN_SLUG: mutationBrowserIdentity.runSlug,
    E2E_TEST_USER_EMAIL: mutationBrowserIdentity.email,
    E2E_TEST_USER_PASSWORD: mutationBrowserIdentity.password,
    E2E_AUTH_BYPASS: "1",
    NEXT_PUBLIC_HUGO_SSO: "0",
    CRON_SECRET: "sequence-readiness-local-cron",
    SEQUENCE_READINESS_MOCK_PROVIDER_LEDGER: "1",
    SEQUENCE_READINESS_LEDGER_URL: "http://127.0.0.1:3558/ledger",
    SEQUENCE_READINESS_LEDGER_TOKEN: `mutation-${commit.slice(0, 24)}`,
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(
      worktree,
      "tests/sequence-readiness/google-fonts-mock.cjs",
    ),
  };
  // The browser lane accepts the explicit local run identity. Do not expose
  // the disposable CLI's CI marker, which would make the E2E identity guard
  // require a GitHub run slug that this local mutation owns neither.
  delete environment.CI;
  delete environment.GITHUB_ACTIONS;
  return environment;
}

async function runSpec(spec, label) {
  if (spec.runner === "playwright") {
    for (const port of [3557, 3558, 3559]) await assertPortAvailable(port);
    const result = await run("npx", [
      "playwright",
      "test",
      spec.file,
      "--config",
      "playwright.sequence-readiness.config.ts",
      "--grep",
      spec.pattern,
      "--reporter=json",
    ], {
      cwd: worktree,
      env: browserTestEnvironment(),
      timeoutMs: 1_200_000,
      label,
    });
    const report = parsePlaywrightReport(result.stdout, result.stderr);
    const record = {
      label,
      runner: "playwright",
      file: spec.file,
      pattern: spec.pattern,
      exitCode: result.exitCode,
      report,
    };
    evidence.commands.push(record);
    await writeFile(
      path.join(artifactsDir, `${label}.json`),
      `${JSON.stringify(scrubJson(record), null, 2)}\n`,
    );
    return { ...result, report };
  }
  const result = await run("npx", [
    "vitest",
    "run",
    "--config",
    "vitest.disposable-canary.config.ts",
    spec.file,
    "--testNamePattern",
    spec.pattern,
    "--reporter=json",
  ], {
    cwd: worktree,
    env: testEnv,
    timeoutMs: 900_000,
    label,
  });
  const report = parseVitestReport(result.stdout, result.stderr);
  const record = {
    label,
    runner: "vitest",
    file: spec.file,
    pattern: spec.pattern,
    exitCode: result.exitCode,
    report,
  };
  evidence.commands.push(record);
  await writeFile(
    path.join(artifactsDir, `${label}.json`),
    `${JSON.stringify(scrubJson(record), null, 2)}\n`,
  );
  return { ...result, report };
}

async function runSelectedSpecs(phase, expectMutantFailure) {
  const target = await runSpec(selectedMutation.target, `${phase}-target`);
  const controls = [];
  for (const [index, control] of selectedMutation.controls.entries()) {
    controls.push(await runSpec(control, `${phase}-control-${index + 1}`));
  }
  if (expectMutantFailure) {
    await assertOneAssertionFailure(
      target,
      `${phase} target`,
      selectedMutation.target.expectedFailure,
      selectedMutation.target.expectedFullName,
      selectedMutation.target,
    );
  } else {
    assertOnePassingTest(
      target,
      `${phase} target`,
      selectedMutation.target.expectedFullName ?? new RegExp(escapeRegex(selectedMutation.target.pattern)),
    );
  }
  controls.forEach((control, index) =>
    assertOnePassingTest(
      control,
      `${phase} control ${index + 1}`,
      selectedMutation.controls[index].expectedFullName ??
        new RegExp(escapeRegex(selectedMutation.controls[index].pattern)),
    ),
  );
  const summarize = (result) => ({
    exitCode: result.exitCode,
    signal: result.signal,
    report: result.report,
  });
  return { target: summarize(target), controls: controls.map(summarize) };
}

async function listOwnedDockerResources(kind, projectName) {
  const argsForDocker = kind === "container"
    ? [kind, "ls", "--all", "--format", "{{.Names}}", "--filter", `name=${projectName}`]
    : [kind, "ls", "--quiet", "--filter", `name=${projectName}`];
  const result = await run("docker", argsForDocker, { env: baseEnv, timeoutMs: 60_000, label: `docker-list-${kind}` });
  if (result.exitCode !== 0) throw new Error(`docker ${kind} listing failed`);
  const pattern = new RegExp(`^supabase_[^\\n]*_${escapeRegex(projectName)}$`);
  return result.stdout.split(/\s+/).map((value) => value.trim()).filter((value) => value && pattern.test(value));
}

async function assertOwnedDockerResource(kind, resource, expectedProject) {
  const inspectKind = kind === "container" ? "container" : "volume";
  const format = kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}";
  const result = await run("docker", [inspectKind, "inspect", resource, "--format", format], {
    env: baseEnv,
    timeoutMs: 60_000,
    label: `docker-inspect-${kind}`,
  });
  if (result.exitCode !== 0) throw new Error(`owned Docker ${kind} inspect failed for ${resource}`);
  let labels;
  try {
    labels = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`Docker ${kind} ${resource} did not return inspect labels`);
  }
  if (labels?.["com.supabase.cli.project"] !== expectedProject) {
    throw new Error(`Docker ${kind} ${resource} is not owned by project ${expectedProject}`);
  }
}

async function cleanupDocker(projectName) {
  const containers = await listOwnedDockerResources("container", projectName);
  for (const container of containers) await assertOwnedDockerResource("container", container, projectName);
  if (containers.length) {
    const result = await run("docker", ["rm", "--force", ...containers], { env: baseEnv, timeoutMs: 120_000, label: "docker-remove-containers" });
    if (result.exitCode !== 0) throw new Error("owned Docker container cleanup failed");
  }
  const volumes = await listOwnedDockerResources("volume", projectName);
  for (const volume of volumes) await assertOwnedDockerResource("volume", volume, projectName);
  if (volumes.length) {
    const result = await run("docker", ["volume", "rm", "--force", ...volumes], { env: baseEnv, timeoutMs: 120_000, label: "docker-remove-volumes" });
    if (result.exitCode !== 0) throw new Error("owned Docker volume cleanup failed");
  }
  const remainingContainers = await listOwnedDockerResources("container", projectName);
  const remainingVolumes = await listOwnedDockerResources("volume", projectName);
  if (remainingContainers.length || remainingVolumes.length) {
    throw new Error(`owned Docker resources remain: ${[...remainingContainers, ...remainingVolumes].join(", ")}`);
  }
}

async function cleanup() {
  cleaning = true;
  const failures = [];
  if (worktree && supabaseStartAttempted) {
    const result = await run("supabase", ["stop", "--workdir", worktree, "--no-backup"], {
      cwd: worktree,
      env: baseEnv,
      timeoutMs: 120_000,
      label: "supabase-stop",
    }).catch((error) => ({ exitCode: 1, stderr: error.message, stdout: "" }));
    if (stackStarted && result.exitCode !== 0) {
      failures.push(`supabase stop: ${scrub(result.stderr || result.stdout)}`);
    }
  }
  if (worktree) {
    if (!projectName || path.basename(worktree) !== projectName) {
      failures.push("worktree/project ownership identity was not preserved");
    } else {
      await cleanupDocker(projectName).catch((error) => failures.push(`docker cleanup: ${error.message}`));
    }
    await git(["worktree", "remove", "--force", worktree], { label: "git-worktree-remove" }).catch((error) => failures.push(`worktree remove: ${error.message}`));
    await rm(worktree, { recursive: true, force: true }).catch((error) => failures.push(`worktree directory cleanup: ${error.message}`));
  }
  if (worktreeParent) {
    await rm(worktreeParent, { recursive: true, force: true }).catch((error) => failures.push(`worktree parent cleanup: ${error.message}`));
  }
  if (failures.length) throw new Error(failures.join("; "));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cancelled = true;
    terminate(activeChild);
  });
}

let runFailure = null;
try {
  await mkdir(artifactsDir = path.resolve(args.artifactsDir ?? path.join(tmpdir(), `sandra-sequence-mutation-${args.mutation}-${Date.now()}`)), { recursive: true, mode: 0o700 });
  const resolvedCommit = await verifyCandidate();
  evidence.commit = resolvedCommit;
  worktreeParent = await mkdtemp(path.join(tmpdir(), "sandra-sequence-mutation-worktree-"));
  projectName = createMutationProjectName(
    args.mutation,
    process.pid,
    Date.now().toString(36),
  );
  worktree = path.join(worktreeParent, projectName);
  evidence.docker.project = projectName;
  await git(["worktree", "add", "--detach", worktree, resolvedCommit], { label: "git-worktree-add" });
  const nodeModules = path.join(root, "node_modules");
  await access(nodeModules);
  await symlink(nodeModules, path.join(worktree, "node_modules"), "junction");
  await run("supabase", ["--version"], { cwd: worktree, env: baseEnv, label: "supabase-version" }).then((result) => {
    if (result.exitCode !== 0 || !result.stdout.includes(SUPABASE_CLI_VERSION)) throw new Error(`expected Supabase CLI ${SUPABASE_CLI_VERSION}`);
  });
  await run("supabase", ["init", "--workdir", worktree], { cwd: worktree, env: baseEnv, label: "supabase-init" }).then((result) => {
    if (result.exitCode !== 0) throw new Error(`Supabase init failed: ${scrub(result.stderr || result.stdout)}`);
  });
  supabaseStartAttempted = true;
  await assertPortAvailable(54321);
  await assertPortAvailable(54322);
  await run("supabase", ["start", "--workdir", worktree, "--exclude", SUPABASE_EXCLUDES.join(",")], {
    cwd: worktree,
    env: baseEnv,
    timeoutMs: 900_000,
    label: "supabase-start",
  }).then((result) => {
    if (result.exitCode !== 0) throw new Error(`Supabase start failed: ${scrub(result.stderr || result.stdout)}`);
  });
  stackStarted = true;
  const statusResult = await run("supabase", ["status", "--workdir", worktree, "--output", "json"], {
    cwd: worktree,
    env: baseEnv,
    label: "supabase-status",
  });
  if (statusResult.exitCode !== 0) throw new Error("Unable to read local Supabase status");
  const status = parseStatusJson(statusResult.stdout);
  if (status.API_URL !== LOOPBACK_API_URL || status.DB_URL !== LOOPBACK_DB_URL) {
    throw new Error("Mutation harness refused non-loopback Supabase endpoints");
  }
  testEnv = {
    ...baseEnv,
    TEST_SUPABASE_URL: status.API_URL,
    TEST_SUPABASE_DB_URL: status.DB_URL,
    TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
    TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    E2E_DISPOSABLE_DATABASE: "1",
    E2E_ALLOW_LOCAL_SUPABASE: "1",
    MESSAGING_PROVIDER: "mock",
    ADDRESS_VERIFIER_PROVIDER: "mock",
    SKIP_TRACE_PROVIDER: "mock",
  };
  if (mutationBrowserIdentity) {
    Object.assign(testEnv, {
      E2E_RUN_SLUG: mutationBrowserIdentity.runSlug,
      E2E_TEST_USER_EMAIL: mutationBrowserIdentity.email,
      E2E_TEST_USER_PASSWORD: mutationBrowserIdentity.password,
    });
    // The CLI child keeps CI=1 for its sanitized environment, but a local
    // mutation identity must reach the E2E guard as a local run. GitHub-run
    // identities are already fully namespaced and retain the same fields.
    delete testEnv.CI;
    delete testEnv.GITHUB_ACTIONS;
  }
  const preflight = await readPreflight(status.DB_URL, true);
  evidence.preflight.push({ phase: "clean-before-mutation", ...preflight });
  await provisionOwner();
  evidence.tests.baselineBefore = await runSelectedSpecs("baseline-before", false);
  await applyMutation();
  evidence.mutationRecord = mutationRecord;
  evidence.tests.mutant = await runSelectedSpecs("mutant", true);
  await restoreMutation();
  evidence.tests.baselineAfter = await runSelectedSpecs("baseline-after", false);
} catch (error) {
  evidence.status = cancelled ? "CANCELLED" : "BLOCKED";
  evidence.error = scrub(error instanceof Error ? error.stack ?? error.message : String(error));
  runFailure = error;
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    evidence.status = "CLEANUP_FAIL";
    evidence.cleanupError = scrub(error instanceof Error ? error.message : String(error));
    runFailure ??= error;
    process.exitCode = 1;
  }
  if (runFailure) {
    process.exitCode = 1;
    await writeEvidence().catch(() => undefined);
    console.error(`[sequence-mutation] ${evidence.status}: ${evidence.error ?? evidence.cleanupError ?? String(runFailure)}`);
  } else {
    evidence.status = "PASS";
    await writeEvidence();
    console.log(`[sequence-mutation] PASS ${args.mutation}`);
    console.log(`[sequence-mutation] evidence ${artifactsDir}`);
  }
}
