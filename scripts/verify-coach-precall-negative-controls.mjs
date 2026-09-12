import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

// Run only in this isolated worktree, without concurrent tests/review of its working files.
// Every temporary mutation is restored byte-for-byte in finally, including failed runs.
const cases = [
  {
    name: "edit-precedence",
    file: "src/lib/coach/token-resolver.ts",
    from: "overrides && Object.hasOwn(overrides, token)",
    to: "overrides && Boolean(overrides[token])",
    args: [
      "run",
      "test",
      "--",
      "src/lib/coach/precall-setup.test.ts",
      "-t",
      "preserves explicit blanks",
    ],
  },
  {
    name: "target-isolation",
    file: "src/lib/coach/precall-setup.ts",
    from: "`${SETUP_STORAGE_PREFIX}${operatorId}:${targetKey}`",
    to: "`${SETUP_STORAGE_PREFIX}${operatorId}`",
    args: [
      "run",
      "test",
      "--",
      "src/lib/coach/precall-setup.test.ts",
      "-t",
      "partitions rep",
    ],
  },
  {
    name: "branch-handoff",
    file: "src/lib/coach/use-coach-session.ts",
    from: "Object.entries(initialSetup?.branches ?? {}).filter(([key]) => !key.includes('.'))",
    to: "Object.entries({})",
    args: [
      "run",
      "test:rtl",
      "--",
      "src/lib/coach/use-coach-session.test.tsx",
      "-t",
      "pre-call snapshot handoff",
    ],
  },
  {
    name: "greeting-layout",
    file: "src/components/coach/coach-live-view.tsx",
    from: "branch.selected.lines.flatMap(splitDisplaySentences)",
    to: "branch.selected.lines",
    args: [
      "run",
      "test:e2e:synthetic",
      "--",
      "precall-matrix.spec.ts",
      "--grep",
      "profile 0:",
      "--max-failures=1",
    ],
  },
];
mkdirSync("tmp/precall-negative-controls", { recursive: true });
const ledger = [];
for (const item of cases) {
  const original = readFileSync(item.file, "utf8");
  assert.equal(
    original.split(item.from).length,
    2,
    `${item.name}: mutation anchor must match exactly once`,
  );
  const run = (suffix) => {
    const result = spawnSync("npm", item.args, {
      encoding: "utf8",
      timeout: 120000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    writeFileSync(
      `tmp/precall-negative-controls/${item.name}-${suffix}.log`,
      output,
    );
    return { status: result.status, output };
  };
  assert.equal(
    run("baseline").status,
    0,
    `${item.name}: baseline must be green`,
  );
  try {
    writeFileSync(item.file, original.replace(item.from, item.to));
    const broken = run("mutated");
    assert.notEqual(
      broken.status,
      0,
      `${item.name}: tests failed to catch mutation`,
    );
    assert.match(
      broken.output,
      /Tests\s+.*failed|1 failed/,
      `${item.name}: require a test failure, not a setup failure`,
    );
    ledger.push({
      name: item.name,
      baseline: "PASS",
      mutated: "DETECTED",
      sourceRestored: true,
    });
  } finally {
    writeFileSync(item.file, original);
  }
  assert.equal(
    run("restored").status,
    0,
    `${item.name}: restored baseline must be green`,
  );
}
writeFileSync(
  "docs/precall-review/NEGATIVE-CONTROLS.json",
  JSON.stringify(ledger, null, 2) + "\n",
);
console.log(
  `Detected and restored ${ledger.length}/${cases.length} negative controls.`,
);
