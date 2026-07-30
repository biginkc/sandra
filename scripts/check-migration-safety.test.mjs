import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertDeclaredIdentity,
  assertNoSymlinkInMigrationsPath,
  canonicalMigrationsDir,
  evaluateSafety,
  identityKey,
  loadBaseline,
  namespaceOf,
  numericValue,
  readGitTrackedBaseline,
} from "./check-migration-safety.mjs";

const REAL_BASELINE_PATH = join(import.meta.dirname, "migration-safety-baseline.json");
const CLI_PATH = join(import.meta.dirname, "check-migration-safety-cli.mjs");

// Runs `fn` with the given PG* env vars temporarily set, restoring whatever
// was there before (including "unset") afterward. assertDeclaredIdentity()
// reads process.env directly, by design -- it is the exact same connection
// context runPsqlCsv/runPsqlSingleJson use, so there is nothing to pass as a
// parameter that isn't already implicitly true of the process.
function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

// loadBaseline() reads the baseline's content from git's object database
// (`git show HEAD:path`), never from the working-tree file directly -- see
// the round-2 fix in check-migration-safety.mjs for why (provenance +
// TOCTOU). Test fixtures that need to exercise "what does loadBaseline do
// with THIS committed content" therefore need a real, disposable git
// repository: git init, commit, then point loadBaseline at it via the
// `repoRoot` option. Nothing here ever touches this actual repo's git
// history -- every scratch repo is its own throwaway `git init` under the
// system tmpdir, removed after each test via test.after().
const scratchRepos = [];

function initScratchGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-gitrepo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  // A commit is required for HEAD to resolve at all.
  writeFileSync(join(dir, "README.md"), "scratch repo for check-migration-safety tests\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  scratchRepos.push(dir);
  return dir;
}

function commitFile(repoDir, relativePath, content) {
  const fullPath = join(repoDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["-C", repoDir, "add", relativePath]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", `add ${relativePath}`]);
  return fullPath;
}

// Convenience for the common case: one target, arbitrary placeholder
// versions, identity left unbound (project_ref/database/db_system_identifier
// all null) unless overridden -- matching how most of these tests only care
// about placeholder-acceptance behavior, not identity binding (which has its
// own dedicated test section below).
function commitTargetedBaseline(repoDir, targets, relativePath = "baseline.json") {
  return commitFile(repoDir, relativePath, JSON.stringify({ targets }));
}

function simpleTarget(placeholderVersions, identity = {}) {
  return {
    project_ref: identity.projectRef ?? null,
    database: identity.database ?? null,
    db_system_identifier: identity.systemIdentifier ?? null,
    placeholder_versions: placeholderVersions,
  };
}

function stageFileWithoutCommitting(repoDir, relativePath, content) {
  const fullPath = join(repoDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["-C", repoDir, "add", relativePath]);
  return fullPath;
}

function writeUntracked(repoDir, relativePath, content) {
  const fullPath = join(repoDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

// Deliberately OUTSIDE any scratch repo -- only for tests proving the
// containment check refuses a path that resolves outside the repo root, and
// for building hardlink-target content that must never be trusted.
function outsideRepoTempDir() {
  return mkdtempSync(join(tmpdir(), "sandra-mig-safety-outside-"));
}

test.after(() => {
  for (const dir of scratchRepos) {
    rmSync(dir, { recursive: true, force: true });
  }
});
// --- Defect 1: empty/wrong migrations directory must not silently pass -----

test("refuses when zero local migrations are found, even with non-empty history", () => {
  const history = [{ version: "086", isPlaceholder: false }];
  const result = evaluateSafety(history, []);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_LOCAL_MIGRATIONS");
});

// --- Defect 2: identity must normalize formatting, not string-compare ------

test("recognizes '001' in a filename as already applied when history says '1' (mixed zero-padding)", () => {
  const history = [{ version: "1", isPlaceholder: false }];
  const local = [{ file: "001_new.sql", version: "001" }];
  const result = evaluateSafety(history, local);
  // The Institute bug: raw string equality ("001" !== "1") would classify
  // this as newly pending, then BigInt ordering (1n < 1n is false) would
  // wave it through as "not older" -- a false OK for what is actually a
  // duplicate of an already-applied version under different formatting.
  // Correct behavior: recognized as already-applied, not pending at all.
  assert.equal(result.ok, true);
  assert.deepEqual(result.pending, []);
});

test("identityKey normalizes leading zeros so '001', '1', and '0001' all match", () => {
  assert.equal(identityKey("001"), identityKey("1"));
  assert.equal(identityKey("0001"), identityKey("1"));
});

// --- Sandra's real mixed version scheme: 3-digit legacy vs 14-digit timestamp

test("namespaceOf separates 3-digit legacy versions from 14-digit timestamp versions", () => {
  assert.notEqual(namespaceOf("086"), namespaceOf("20260729170000"));
  assert.equal(namespaceOf("086"), namespaceOf("035"));
  assert.equal(namespaceOf("20260729170000"), namespaceOf("20260612054256"));
});

test("replay of the incident shape: an old timestamp file missing from history is refused", () => {
  const history = [
    { version: "086", isPlaceholder: false },
    { version: "20260728150000", isPlaceholder: false },
    { version: "20260729170000", isPlaceholder: false },
  ];
  // 20260727150000 predates the newest applied timestamp (20260729170000)
  // and has no history row -- exactly the re-apply-an-old-superseded-file
  // pattern that reverted 6 functions on Institute prod.
  const local = [
    { file: "086_x.sql", version: "086" },
    { file: "20260727150000_old_superseded.sql", version: "20260727150000" },
    { file: "20260728150000_y.sql", version: "20260728150000" },
    { file: "20260729170000_z.sql", version: "20260729170000" },
  ];
  const result = evaluateSafety(history, local);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OUT_OF_ORDER_PENDING");
  assert.equal(result.unsafePending.length, 1);
  assert.equal(result.unsafePending[0].file, "20260727150000_old_superseded.sql");
});

test("a legitimate new timestamp migration newer than history's max passes", () => {
  const history = [
    { version: "086", isPlaceholder: false },
    { version: "20260729170000", isPlaceholder: false },
  ];
  const local = [
    { file: "086_x.sql", version: "086" },
    { file: "20260729170000_z.sql", version: "20260729170000" },
    { file: "20260730120000_new_feature.sql", version: "20260730120000" },
  ];
  const result = evaluateSafety(history, local);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.pending.map((entry) => entry.file),
    ["20260730120000_new_feature.sql"],
  );
});

test("mixed scheme does not produce a false FAIL: a new legacy-width pending file newer only within its own namespace is not blocked by the far-larger timestamp max", () => {
  // Global BigInt comparison (no namespacing) would compare 087 against the
  // overall max across ALL history, which is the huge timestamp
  // 20260729170000 -- 87 < 20260729170000 would be misread as "out of
  // order" even though, within the legacy 3-digit scheme, 087 is newer than
  // the newest applied legacy version (086). Per-namespace comparison must
  // not produce this false fail.
  const history = [
    { version: "085", isPlaceholder: false },
    { version: "086", isPlaceholder: false },
    { version: "20260729170000", isPlaceholder: false },
  ];
  const local = [
    { file: "085_x.sql", version: "085" },
    { file: "086_y.sql", version: "086" },
    { file: "20260729170000_z.sql", version: "20260729170000" },
    { file: "087_late_legacy_backport.sql", version: "087" },
  ];
  const result = evaluateSafety(history, local);
  assert.equal(result.ok, true, `expected pass, got refusal: ${JSON.stringify(result)}`);
  assert.deepEqual(
    result.pending.map((entry) => entry.file),
    ["087_late_legacy_backport.sql"],
  );
});

test("mixed scheme does not produce a false PASS: a pending legacy file older than the applied legacy max is still caught even though it is numerically tiny next to the timestamp max", () => {
  const history = [
    { version: "086", isPlaceholder: false },
    { version: "20260729170000", isPlaceholder: false },
  ];
  const local = [
    { file: "086_y.sql", version: "086" },
    { file: "20260729170000_z.sql", version: "20260729170000" },
    { file: "042_missing_from_history.sql", version: "042" },
  ];
  const result = evaluateSafety(history, local);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OUT_OF_ORDER_PENDING");
  assert.equal(result.unsafePending[0].file, "042_missing_from_history.sql");
});

test("an unrecognized version-string width is refused rather than silently accepted", () => {
  const history = [{ version: "086", isPlaceholder: false }];
  const local = [
    { file: "086_x.sql", version: "086" },
    { file: "20260730_weird_width.sql", version: "20260730" },
  ];
  const result = evaluateSafety(history, local);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNKNOWN_VERSION_NAMESPACE");
});

// --- Defect 3: placeholder rows must have a baseline, not an absolute ban ---

test("known/baselined placeholder rows do not block a push (Sandra's real 36-row baseline)", () => {
  const history = [
    { version: "001", isPlaceholder: true },
    { version: "002", isPlaceholder: true },
    { version: "086", isPlaceholder: false },
    { version: "20260729170000", isPlaceholder: false },
  ];
  const local = [
    { file: "001_initial.sql", version: "001" },
    { file: "002_x.sql", version: "002" },
    { file: "086_y.sql", version: "086" },
    { file: "20260729170000_z.sql", version: "20260729170000" },
    { file: "20260730090000_new.sql", version: "20260730090000" },
  ];
  const result = evaluateSafety(history, local, {
    acceptedPlaceholderVersions: new Set(["001", "002"]),
  });
  assert.equal(result.ok, true, `expected pass, got refusal: ${JSON.stringify(result)}`);
});

test("without a baseline, the same known-placeholder history would wrongly deadlock forever (regression guard for the Institute defect)", () => {
  const history = [
    { version: "001", isPlaceholder: true },
    { version: "086", isPlaceholder: false },
  ];
  const local = [
    { file: "001_initial.sql", version: "001" },
    { file: "086_y.sql", version: "086" },
  ];
  const result = evaluateSafety(history, local, {
    acceptedPlaceholderVersions: new Set(), // no baseline at all
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNKNOWN_PLACEHOLDER_HISTORY");
});

test("a NEW placeholder row not in the baseline is refused, not silently absorbed", () => {
  const history = [
    { version: "001", isPlaceholder: true },
    { version: "20260730090000", isPlaceholder: true }, // new repair, not yet reviewed
    { version: "086", isPlaceholder: false },
  ];
  const local = [
    { file: "001_initial.sql", version: "001" },
    { file: "086_y.sql", version: "086" },
    { file: "20260730090000_repaired.sql", version: "20260730090000" },
  ];
  const result = evaluateSafety(history, local, {
    acceptedPlaceholderVersions: new Set(["001"]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNKNOWN_PLACEHOLDER_HISTORY");
  assert.equal(result.unknownPlaceholders[0].version, "20260730090000");
});

// --- Misc correctness -------------------------------------------------------

test("numericValue rejects non-numeric version strings instead of guessing", () => {
  assert.throws(() => numericValue("abc"));
});

test("empty history refuses rather than assuming a baseline", () => {
  const result = evaluateSafety([], [{ file: "001_x.sql", version: "001" }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EMPTY_HISTORY");
});
// --- P1 fix (round 1): baseline integrity must fail CLOSED, never silently
// degrade. Codex's adversarial review of the first version of this gate
// demonstrated: missing baseline file + clean (no-placeholder) history =>
// {"ok":true}. That meant deleting/renaming/emptying/corrupting
// scripts/migration-safety-baseline.json silently disabled the entire gate.

const T = "test-target"; // arbitrary target name used throughout this file

test("loadBaseline refuses when the baseline path does not exist in any commit (missing file, Codex's round-1 repro)", () => {
  const repo = initScratchGitRepo();
  const missingPath = join(repo, "does-not-exist.json");
  assert.throws(
    () => loadBaseline(missingPath, { repoRoot: repo, target: T }),
    /could not be read from git HEAD|does not exist/,
  );
});

test("a missing baseline must refuse even when history has zero placeholders (round-1 exact repro)", () => {
  const repo = initScratchGitRepo();
  const missingPath = join(repo, "does-not-exist.json");
  assert.throws(() => loadBaseline(missingPath, { repoRoot: repo, target: T }));
  // evaluateSafety itself is, and always was, correct in isolation -- clean
  // history with an explicit empty accepted set legitimately passes. The
  // bug was never in evaluateSafety; it was loadBaseline manufacturing a
  // silent empty default instead of refusing to load at all.
  const historyWithNoPlaceholders = [{ version: "086", isPlaceholder: false }];
  const local = [{ file: "086_x.sql", version: "086" }];
  const result = evaluateSafety(historyWithNoPlaceholders, local, {
    acceptedPlaceholderVersions: new Set(),
  });
  assert.equal(result.ok, true);
});

test("loadBaseline requires a target", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget([]) });
  assert.throws(() => loadBaseline(path, { repoRoot: repo }), /requires a target/);
});

test("loadBaseline refuses an unknown target", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget([]) });
  assert.throws(
    () => loadBaseline(path, { repoRoot: repo, target: "nonexistent-target" }),
    /No baseline entry for target "nonexistent-target"/,
  );
});

test("loadBaseline refuses when the committed blob is not valid JSON", () => {
  const repo = initScratchGitRepo();
  const path = commitFile(repo, "baseline.json", "{ this is not json");
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /not valid JSON/);
});

test("loadBaseline refuses when the committed JSON has no \"targets\" object", () => {
  const repo = initScratchGitRepo();
  const path = commitFile(repo, "baseline.json", JSON.stringify({ acceptedPlaceholderVersions: [] }));
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /"targets" object/);
});

test("loadBaseline refuses when a target entry is missing a required identity key", () => {
  const repo = initScratchGitRepo();
  const path = commitFile(
    repo,
    "baseline.json",
    JSON.stringify({ targets: { [T]: { project_ref: null, placeholder_versions: [] } } }),
  );
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /has no "database" key/);
});

test("loadBaseline accepts a legitimately empty, committed baseline (explicit empty array is valid shape)", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget([]) });
  const baseline = loadBaseline(path, { repoRoot: repo, target: T });
  assert.equal(baseline.acceptedPlaceholderVersions.size, 0);
});

test("an explicit-but-empty committed baseline still refuses on real placeholder rows (not a bypass)", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget([]) });
  const baseline = loadBaseline(path, { repoRoot: repo, target: T });
  const history = [
    { version: "001", isPlaceholder: true },
    { version: "086", isPlaceholder: false },
  ];
  const local = [
    { file: "001_x.sql", version: "001" },
    { file: "086_y.sql", version: "086" },
  ];
  const result = evaluateSafety(history, local, {
    acceptedPlaceholderVersions: baseline.acceptedPlaceholderVersions,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNKNOWN_PLACEHOLDER_HISTORY");
});

test("loadBaseline round-trips the REAL committed baseline file in THIS repo, both real targets, using the default repoRoot", () => {
  // No repoRoot override -- exercises the actual production path: the real
  // scripts/migration-safety-baseline.json, read via git HEAD in this
  // actual repo checkout.
  const prod = loadBaseline(REAL_BASELINE_PATH, { target: "sandra-production" });
  assert.ok(prod.acceptedPlaceholderVersions.size >= 36);
  assert.ok(prod.acceptedPlaceholderVersions.has(identityKey("001")));
  assert.ok(prod.acceptedPlaceholderVersions.has(identityKey("20260729010000")));

  const test_ = loadBaseline(REAL_BASELINE_PATH, { target: "sandra-test" });
  assert.equal(test_.acceptedPlaceholderVersions.size, 35);
  assert.ok(!test_.acceptedPlaceholderVersions.has(identityKey("20260729010000")));
});

// --- P1 round 2, part A (duplicates / numeric coercion) --------------------

test("loadBaseline refuses literal duplicate entries and names the duplicate", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget(["001", "002", "001"]) });
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /duplicate entries for version "001"/);
});

test("loadBaseline refuses cross-formatted duplicate entries (\"001\" and \"1\" normalize the same)", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget(["001", "1"]) });
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /duplicate entries/);
});

test("loadBaseline refuses a numeric entry instead of coercing it (Codex's round-2 repro: 1 -> \"001\")", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget([1]) });
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /non-string version.*1.*number/s);
});

test("loadBaseline refuses a mixed valid/invalid array (object entry)", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget(["001", "002", { evil: true }, "004"]) });
  assert.throws(() => loadBaseline(path, { repoRoot: repo, target: T }), /non-string version/);
});

test("loadBaseline accepts a clean, valid, non-duplicated, all-string committed baseline", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget(["001", "002", "20260729010000"]) });
  const baseline = loadBaseline(path, { repoRoot: repo, target: T });
  assert.equal(baseline.acceptedPlaceholderVersions.size, 3);
});

// --- P1 round 2, part B / round 3: provenance and TOCTOU --------------------

test("loadBaseline refuses an untracked in-repo baseline file (present on disk, never git-added)", () => {
  const repo = initScratchGitRepo();
  const path = writeUntracked(
    repo,
    "baseline.json",
    JSON.stringify({ targets: { [T]: simpleTarget(["001"]) } }),
  );
  assert.throws(
    () => loadBaseline(path, { repoRoot: repo, target: T }),
    /could not be read from git HEAD|not in .HEAD./,
  );
});

test("loadBaseline refuses a staged-but-uncommitted baseline file", () => {
  const repo = initScratchGitRepo();
  const path = stageFileWithoutCommitting(
    repo,
    "baseline.json",
    JSON.stringify({ targets: { [T]: simpleTarget(["001"]) } }),
  );
  assert.throws(
    () => loadBaseline(path, { repoRoot: repo, target: T }),
    /could not be read from git HEAD|not in .HEAD./,
  );
});

test("loadBaseline refuses a HARDLINK at an in-repo pathname pointing at malicious content outside the repo", () => {
  const repo = initScratchGitRepo();
  const outside = outsideRepoTempDir();
  const outsideFile = join(outside, "evil.json");
  writeFileSync(outsideFile, JSON.stringify({ targets: { [T]: simpleTarget(["999999999999999"]) } }));
  const hardlinkedPath = join(repo, "hardlinked-baseline.json");
  linkSync(outsideFile, hardlinkedPath);
  assert.match(readFileSync(hardlinkedPath, "utf8"), /999999999999999/);
  assert.throws(
    () => loadBaseline(hardlinkedPath, { repoRoot: repo, target: T }),
    /could not be read from git HEAD|not in .HEAD./,
  );
});

test("a symlink swapped in AFTER a baseline is committed still reads the committed content, never the symlink's target (no TOCTOU window)", () => {
  const repo = initScratchGitRepo();
  const path = commitTargetedBaseline(repo, { [T]: simpleTarget(["001", "002"]) });
  const before = loadBaseline(path, { repoRoot: repo, target: T });
  assert.equal(before.acceptedPlaceholderVersions.size, 2);

  const outside = outsideRepoTempDir();
  const maliciousFile = join(outside, "malicious.json");
  writeFileSync(maliciousFile, JSON.stringify({ targets: { [T]: simpleTarget(["666666666666666"]) } }));
  unlinkSync(path);
  symlinkSync(maliciousFile, path);

  const after = loadBaseline(path, { repoRoot: repo, target: T });
  assert.deepEqual(
    [...after.acceptedPlaceholderVersions].sort(),
    [...before.acceptedPlaceholderVersions].sort(),
  );
  assert.ok(!after.acceptedPlaceholderVersions.has(identityKey("666666666666666")));
});

test("loadBaseline refuses /dev/stdin as a baseline path (still closed, now via the containment check)", { skip: !existsSync("/dev/stdin") }, () => {
  const repo = initScratchGitRepo();
  assert.throws(() => loadBaseline("/dev/stdin", { repoRoot: repo, target: T }));
});

test("loadBaseline refuses a baseline path that resolves outside the repo via ..", () => {
  const repo = initScratchGitRepo();
  const outside = outsideRepoTempDir();
  const outsideFile = join(outside, "not-in-repo.json");
  writeFileSync(outsideFile, JSON.stringify({ targets: { [T]: simpleTarget(["001"]) } }));
  assert.throws(
    () => loadBaseline(outsideFile, { repoRoot: repo, target: T }),
    /outside the repository root/,
  );
});

// --- P2 (round 4): git show must not hang ------------------------------------
//
// `execFileSync("git", ...)` had no timeout: a wedged git process (lock
// contention, a hung filesystem, a misbehaving credential helper) could hang
// until the CI job's outer 5-minute timeout. It would still fail closed
// against the push eventually, but delays incident visibility far longer
// than reading one small committed JSON blob should ever take. Proven here
// with a fake `git` executable that only sleeps, confirming the gate's own
// short timeout kills it and refuses, rather than waiting for the process to
// finish naturally.

test("readGitTrackedBaseline refuses (does not hang) when git itself hangs past the timeout", () => {
  const fakeGitDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-fakegit-"));
  const fakeGitPath = join(fakeGitDir, "git");
  writeFileSync(fakeGitPath, "#!/bin/sh\nsleep 5\n");
  chmodSync(fakeGitPath, 0o755);

  const repo = initScratchGitRepo();
  commitTargetedBaseline(repo, { [T]: simpleTarget([]) });

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeGitDir}:${originalPath}`;
  try {
    const startedAt = Date.now();
    assert.throws(
      () => readGitTrackedBaseline(join(repo, "baseline.json"), repo, { timeoutMs: 300 }),
      /did not complete within 300ms and was killed/,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 4000, `expected the short timeout to fire well before the fake git's 5s sleep, took ${elapsedMs}ms`);
  } finally {
    process.env.PATH = originalPath;
  }
});

// --- P1-1 (round 4): the gate must inspect the SAME directory the push uses -
//
// `--migrations-dir` was caller-controlled: the gate validated whatever
// directory it was handed while `supabase db push` always reads the linked
// project's canonical `supabase/migrations`. A caller could point the gate
// at a clean directory, get a green result, then push something else
// entirely -- the check and the actual operation would be evaluating
// different files. Fixed by removing the option: the CLI now always derives
// the migrations directory as <repoRoot>/supabase/migrations, and refuses
// outright if --migrations-dir is passed at all.

test("canonicalMigrationsDir always derives <repoRoot>/supabase/migrations", () => {
  const repo = initScratchGitRepo();
  assert.equal(canonicalMigrationsDir(repo), join(repo, "supabase", "migrations"));
});

test("the CLI refuses outright when --migrations-dir is passed, instead of honoring a caller-controlled directory", () => {
  const repo = initScratchGitRepo();
  mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(repo, "supabase", "migrations", "086_x.sql"), "select 1;\n");
  commitTargetedBaseline(repo, { [T]: simpleTarget([]) });

  const decoyDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-decoy-"));
  writeFileSync(join(decoyDir, "999_looks_clean.sql"), "select 1;\n");

  const result = spawnSync(
    process.execPath,
    [CLI_PATH, `--target=${T}`, `--repo-root=${repo}`, `--migrations-dir=${decoyDir}`],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PGHOST: undefined, PGPORT: undefined, PGDATABASE: undefined, PGUSER: undefined, PGPASSWORD: undefined },
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--migrations-dir is not accepted/);
});

test("assertNoSymlinkInMigrationsPath refuses when the migrations directory itself is a symlink", () => {
  const repo = initScratchGitRepo();
  const realElsewhere = mkdtempSync(join(tmpdir(), "sandra-mig-safety-realmigrations-"));
  writeFileSync(join(realElsewhere, "086_x.sql"), "select 1;\n");
  mkdirSync(join(repo, "supabase"), { recursive: true });
  symlinkSync(realElsewhere, join(repo, "supabase", "migrations"));

  assert.throws(
    () => assertNoSymlinkInMigrationsPath(canonicalMigrationsDir(repo), repo),
    /is a symlink/,
  );
});

test("assertNoSymlinkInMigrationsPath refuses when an ancestor path component (supabase/) is a symlink", () => {
  const repo = initScratchGitRepo();
  const realElsewhere = mkdtempSync(join(tmpdir(), "sandra-mig-safety-realsupabase-"));
  mkdirSync(join(realElsewhere, "migrations"), { recursive: true });
  writeFileSync(join(realElsewhere, "migrations", "086_x.sql"), "select 1;\n");
  symlinkSync(realElsewhere, join(repo, "supabase"));

  assert.throws(
    () => assertNoSymlinkInMigrationsPath(canonicalMigrationsDir(repo), repo),
    /is a symlink/,
  );
});

test("assertNoSymlinkInMigrationsPath passes for an ordinary, non-symlinked canonical directory", () => {
  const repo = initScratchGitRepo();
  mkdirSync(join(repo, "supabase", "migrations"), { recursive: true });
  assert.doesNotThrow(() => assertNoSymlinkInMigrationsPath(canonicalMigrationsDir(repo), repo));
});

// --- P1-2 (round 4): independent project-identity binding -------------------
//
// The gate used to trust whatever PGHOST/PGUSER/password it was handed --
// it never verified the database it queried was actually the pinned
// project. Fixed with two layers: assertDeclaredIdentity (exact, anchored
// parse of PGUSER/PGHOST against the baseline's expected project_ref/
// database -- never a substring test) and assertLiveIdentity (a live query
// against the connection; exercised in the rehearsal harness, which has a
// real database to query). This section covers assertDeclaredIdentity,
// which is pure with respect to a database (it reads only the declared env).

test("assertDeclaredIdentity returns 'not bound' when the baseline's project_ref is null (disposable local target)", () => {
  const result = withEnv({ PGUSER: "postgres", PGHOST: "localhost", PGDATABASE: "postgres" }, () =>
    assertDeclaredIdentity(T, { projectRef: null, database: null }),
  );
  assert.match(result, /not bound/);
});

test("assertDeclaredIdentity accepts an exact PGUSER match (postgres.<ref>)", () => {
  const ref = "abcdefghijklmnopqrst"; // 20 lowercase letters
  const result = withEnv({ PGUSER: `postgres.${ref}`, PGHOST: "aws-1-us-east-1.pooler.supabase.com", PGDATABASE: "postgres" }, () =>
    assertDeclaredIdentity(T, { projectRef: ref, database: "postgres" }),
  );
  assert.match(result, /exact match/);
});

test("assertDeclaredIdentity refuses a hostname that merely CONTAINS the expected ref as a substring (not the same as declaring it)", () => {
  const ref = "abcdefghijklmnopqrst";
  assert.throws(
    () =>
      withEnv(
        {
          // Deliberately NOT of the form postgres.<ref> or db.<ref>.supabase.co --
          // a substring match would incorrectly accept this.
          PGUSER: `some-other-user-${ref}-suffix`,
          PGHOST: "unrelated-host.example.com",
          PGDATABASE: "postgres",
        },
        () => assertDeclaredIdentity(T, { projectRef: ref, database: "postgres" }),
      ),
    /Cannot parse a Supabase project ref/,
  );
});

test("assertDeclaredIdentity refuses when PGUSER declares a DIFFERENT ref than expected", () => {
  const expectedRef = "abcdefghijklmnopqrst";
  const wrongRef = "zzzzzzzzzzzzzzzzzzzz";
  assert.throws(
    () =>
      withEnv({ PGUSER: `postgres.${wrongRef}`, PGHOST: "", PGDATABASE: "postgres" }, () =>
        assertDeclaredIdentity(T, { projectRef: expectedRef, database: "postgres" }),
      ),
    new RegExp(`expects "${expectedRef}"`),
  );
});

test("assertDeclaredIdentity refuses when PGUSER and PGHOST declare DIFFERENT refs (disagreement, not just mismatch vs expected)", () => {
  const refA = "abcdefghijklmnopqrst";
  const refB = "zzzzzzzzzzzzzzzzzzzz";
  assert.throws(
    () =>
      withEnv({ PGUSER: `postgres.${refA}`, PGHOST: `db.${refB}.supabase.co`, PGDATABASE: "postgres" }, () =>
        assertDeclaredIdentity(T, { projectRef: refA, database: "postgres" }),
      ),
    /PGUSER declares project ref .* but PGHOST declares/,
  );
});

test("assertDeclaredIdentity refuses on a PGDATABASE mismatch even when the project ref matches", () => {
  const ref = "abcdefghijklmnopqrst";
  assert.throws(
    () =>
      withEnv({ PGUSER: `postgres.${ref}`, PGHOST: "", PGDATABASE: "wrong_db" }, () =>
        assertDeclaredIdentity(T, { projectRef: ref, database: "postgres" }),
      ),
    /PGDATABASE is "wrong_db" but target .* expects "postgres"/,
  );
});

test("assertDeclaredIdentity refuses when the baseline's project_ref is malformed (not 20 lowercase letters, not null)", () => {
  assert.throws(
    () =>
      withEnv({ PGUSER: "postgres.short", PGHOST: "", PGDATABASE: "postgres" }, () =>
        assertDeclaredIdentity(T, { projectRef: "not-a-valid-ref", database: "postgres" }),
      ),
    /is not a 20-lowercase-letter Supabase ref or null/,
  );
});

// --- P1-3: symlinked invocation must still run the gate ---------------------
//
// Round 2 found: `fileURLToPath(import.meta.url)` resolves the module's real
// path while `resolve(process.argv[1])` can remain the symlink path used to
// invoke it, so the old isMain comparison was false, main() never ran, and
// the process exited 0 with no gate output -- a fail-open, and the second
// time this exact comparison broke (first on a space in the repo path).
// Fixed by removing the comparison entirely: check-migration-safety-cli.mjs
// unconditionally calls main(), no matter how it is invoked. Proven here by
// actually invoking it through a symlink as a real subprocess.

test("invoking the CLI wrapper through a symlink still runs the gate and still refuses on bad input", () => {
  const dir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-symlink-invoke-"));
  const symlinkToCli = join(dir, "run-gate-via-symlink.mjs");
  symlinkSync(CLI_PATH, symlinkToCli);

  const result = spawnSync(process.execPath, [symlinkToCli], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PGHOST: undefined,
      PGPORT: undefined,
      PGDATABASE: undefined,
      PGUSER: undefined,
      PGPASSWORD: undefined,
    },
  });

  // The old bug: exit 0, empty stdout/stderr, main() never invoked at all.
  assert.notEqual(result.status, 0, `expected non-zero exit; got status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
  assert.match(
    result.stdout,
    /== Migration safety gate ==/,
    `expected the gate banner in stdout (proves main() actually ran through the symlink); got stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.match(result.stderr, /REFUSING/);
});

test("invoking the CLI wrapper directly (not through a symlink) still runs the gate, for comparison", () => {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      PGHOST: undefined,
      PGPORT: undefined,
      PGDATABASE: undefined,
      PGUSER: undefined,
      PGPASSWORD: undefined,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /== Migration safety gate ==/);
});

test("importing check-migration-safety.mjs as a library never runs main() as an import side effect", () => {
  assert.equal(typeof loadBaseline, "function");
});
