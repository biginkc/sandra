import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  evaluateSafety,
  identityKey,
  loadBaseline,
  namespaceOf,
  numericValue,
} from "./check-migration-safety.mjs";

// loadBaseline() now requires the baseline path to resolve inside the repo
// (see the round-2 fix below), so test fixtures for everything EXCEPT the
// "does it correctly reject an outside-the-repo path" cases must themselves
// live inside the repo, not under the system tmpdir. This directory is
// created fresh per test file run and removed in test.after() below --
// gitignored via scripts/.test-tmp-baseline (see .gitignore).
const REPO_TEST_TMP_ROOT = join(import.meta.dirname, ".test-tmp-baseline");

function tempDir() {
  mkdirSync(REPO_TEST_TMP_ROOT, { recursive: true });
  return mkdtempSync(join(REPO_TEST_TMP_ROOT, "case-"));
}

// Deliberately OUTSIDE the repo -- only for tests proving the containment
// check itself refuses a path that resolves outside the repo root.
function outsideRepoTempDir() {
  return mkdtempSync(join(tmpdir(), "sandra-mig-safety-outside-"));
}

test.after(() => {
  rmSync(REPO_TEST_TMP_ROOT, { recursive: true, force: true });
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

// --- P1 fix: baseline integrity must fail CLOSED, never silently degrade ---
//
// Codex's adversarial review of the first version of this gate demonstrated:
// missing baseline file + clean (no-placeholder) history => {"ok":true}.
// That means deleting/renaming/emptying/corrupting
// scripts/migration-safety-baseline.json silently disabled the entire gate.
// Every case below must throw from loadBaseline() (which main() converts to
// a REFUSING message and a non-zero exit) -- never fall back to an empty
// Set and let evaluateSafety() decide whether that happens to matter.

test("loadBaseline refuses when the baseline file is missing (Codex's exact repro)", () => {
  const dir = tempDir();
  const missingPath = join(dir, "does-not-exist.json");
  assert.throws(() => loadBaseline(missingPath), /does not exist/);
});

test("a missing baseline must refuse even when history has zero placeholders", () => {
  // This is the precise shape Codex demonstrated: with the old
  // implementation, a missing baseline degraded to an empty Set, and since
  // there were no placeholder rows to check it against, evaluateSafety()
  // returned {ok:true} -- a fully green result with the guard silently
  // disabled. loadBaseline() must now throw before evaluateSafety() is even
  // reached, regardless of what history looks like.
  const dir = tempDir();
  const missingPath = join(dir, "does-not-exist.json");
  assert.throws(() => loadBaseline(missingPath));
  // (evaluateSafety itself is still correct in isolation -- clean history
  // with an explicit empty baseline legitimately passes. The bug was never
  // in evaluateSafety; it was loadBaseline silently manufacturing that empty
  // baseline instead of refusing to run at all.)
  const historyWithNoPlaceholders = [{ version: "086", isPlaceholder: false }];
  const local = [{ file: "086_x.sql", version: "086" }];
  const result = evaluateSafety(historyWithNoPlaceholders, local, {
    acceptedPlaceholderVersions: new Set(),
  });
  assert.equal(result.ok, true);
});

test("loadBaseline refuses when the baseline file is unreadable (permission denied)", () => {
  const dir = tempDir();
  const path = join(dir, "unreadable.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: [] }));
  chmodSync(path, 0o000);
  try {
    assert.throws(() => loadBaseline(path), /could not be read|EACCES|permission/i);
  } finally {
    chmodSync(path, 0o644); // restore so temp-dir cleanup can delete it
  }
});

test("loadBaseline refuses when the baseline file is not valid JSON", () => {
  const dir = tempDir();
  const path = join(dir, "invalid.json");
  writeFileSync(path, "{ this is not json");
  assert.throws(() => loadBaseline(path), /not valid JSON/);
});

test("loadBaseline refuses when the baseline JSON is a bare array, not an object", () => {
  const dir = tempDir();
  const path = join(dir, "wrong-shape-array.json");
  writeFileSync(path, JSON.stringify(["001", "002"]));
  assert.throws(() => loadBaseline(path), /must be a JSON object/);
});

test("loadBaseline refuses when the baseline JSON is a bare string or number", () => {
  const dir = tempDir();
  const path = join(dir, "wrong-shape-string.json");
  writeFileSync(path, JSON.stringify("not an object"));
  assert.throws(() => loadBaseline(path), /must be a JSON object/);
});

test("loadBaseline refuses when the baseline JSON is null", () => {
  const dir = tempDir();
  const path = join(dir, "null.json");
  writeFileSync(path, "null");
  assert.throws(() => loadBaseline(path), /must be a JSON object/);
});

test("loadBaseline refuses when acceptedPlaceholderVersions key is missing entirely", () => {
  const dir = tempDir();
  const path = join(dir, "missing-key.json");
  writeFileSync(path, JSON.stringify({ someOtherKey: [] }));
  assert.throws(() => loadBaseline(path), /missing a valid "acceptedPlaceholderVersions"/);
});

test("loadBaseline refuses when acceptedPlaceholderVersions is the wrong type (not an array)", () => {
  const dir = tempDir();
  const path = join(dir, "wrong-type.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: "001,002" }));
  assert.throws(() => loadBaseline(path), /missing a valid "acceptedPlaceholderVersions"/);
});

test("loadBaseline refuses on a malformed (non-string) entry: object", () => {
  const dir = tempDir();
  const path = join(dir, "malformed-object.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", { evil: true }] }));
  assert.throws(() => loadBaseline(path), /non-string entry/);
});

test("loadBaseline refuses on a malformed (non-numeric) entry: arbitrary string", () => {
  const dir = tempDir();
  const path = join(dir, "malformed-string.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", "not-a-version"] }));
  assert.throws(() => loadBaseline(path), /malformed version entry/);
});

test("loadBaseline refuses on a malformed (non-string) entry: null", () => {
  const dir = tempDir();
  const path = join(dir, "malformed-null.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", null] }));
  assert.throws(() => loadBaseline(path), /non-string entry/);
});

test("loadBaseline accepts a legitimately empty baseline (explicit empty array is valid shape)", () => {
  const dir = tempDir();
  const path = join(dir, "empty-valid.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: [] }));
  const baseline = loadBaseline(path);
  assert.equal(baseline.acceptedPlaceholderVersions.size, 0);
});

test("an explicit-but-empty baseline still refuses on real placeholder rows (not a bypass)", () => {
  // Proves the "empty baseline + placeholders exist in history" case refuses
  // -- an empty accepted set never silently absorbs real placeholder rows.
  const dir = tempDir();
  const path = join(dir, "empty-valid-2.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: [] }));
  const baseline = loadBaseline(path);
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

test("loadBaseline round-trips the real committed baseline file without error", () => {
  const realBaselinePath = join(import.meta.dirname, "migration-safety-baseline.json");
  const baseline = loadBaseline(realBaselinePath);
  assert.ok(baseline.acceptedPlaceholderVersions.size >= 36);
  assert.ok(baseline.acceptedPlaceholderVersions.has(identityKey("001")));
  assert.ok(baseline.acceptedPlaceholderVersions.has(identityKey("20260729010000")));
});

// --- P1 round 2 fix: symlinks, path escape, duplicates, numeric coercion ---
//
// Codex round-2 adversarial review demonstrated three residual holes in the
// round-1 fix: a symlinked baseline path (including /dev/stdin) loaded
// through and passed; duplicate entries loaded silently; numeric entries
// were coerced to strings instead of refused. All three are security-control
// integrity issues -- the baseline's value depends entirely on "you can only
// widen it via a reviewed commit," and each hole above is a way to bypass
// that without touching the committed file's own reviewed content.

test("loadBaseline refuses a baseline path that is a symlink to a legitimate file elsewhere", () => {
  const dir = tempDir();
  const realFile = join(dir, "real-baseline.json");
  writeFileSync(realFile, JSON.stringify({ acceptedPlaceholderVersions: ["001"] }));
  const symlinkPath = join(dir, "baseline-symlink.json");
  symlinkSync(realFile, symlinkPath);
  assert.throws(() => loadBaseline(symlinkPath), /is a symlink/);
});

test("loadBaseline refuses /dev/stdin as a baseline path (Codex's exact repro)", { skip: !existsSync("/dev/stdin") }, () => {
  // On this platform /dev/stdin is itself a symlink (-> /dev/fd/0), so the
  // lstat-based symlink check catches it directly. Even on a platform where
  // /dev/stdin were a bare character device instead, the isFile() check
  // below would catch it as "not a regular file" -- either layer refuses.
  assert.throws(() => loadBaseline("/dev/stdin"), /is a symlink|not a regular file/);
});

test("loadBaseline refuses a directory at the baseline path", () => {
  const dir = tempDir();
  const subdir = join(dir, "a-directory.json");
  mkdirSync(subdir);
  assert.throws(() => loadBaseline(subdir), /is a directory/);
});

test("loadBaseline refuses a baseline path that resolves outside the repo via ..", () => {
  // Escapes the repo root entirely, e.g. --baseline=../../../../etc/hosts
  // relative to the script. Use a real file outside the repo so the failure
  // being tested is specifically the containment check, not "file missing."
  const outside = outsideRepoTempDir();
  const outsideFile = join(outside, "not-in-repo.json");
  writeFileSync(outsideFile, JSON.stringify({ acceptedPlaceholderVersions: ["001"] }));
  assert.throws(() => loadBaseline(outsideFile), /outside the repository root/);
});

test("loadBaseline refuses a symlinked ancestor directory that redirects an in-repo-looking path outside the repo", () => {
  // Even if the final path component is a real file (not itself a symlink),
  // a symlinked PARENT directory can redirect it entirely outside the repo.
  // realpath-based containment (not just lexical .. detection) must catch
  // this.
  const outside = outsideRepoTempDir();
  const outsideFile = join(outside, "baseline.json");
  writeFileSync(outsideFile, JSON.stringify({ acceptedPlaceholderVersions: ["001"] }));
  const dir = tempDir();
  const symlinkedDir = join(dir, "looks-local");
  symlinkSync(outside, symlinkedDir);
  const pathThroughSymlinkedDir = join(symlinkedDir, "baseline.json");
  assert.throws(() => loadBaseline(pathThroughSymlinkedDir), /outside the repository root/);
});

test("loadBaseline accepts the real committed baseline path without any path-safety false positive", () => {
  const realBaselinePath = resolve(import.meta.dirname, "migration-safety-baseline.json");
  assert.doesNotThrow(() => loadBaseline(realBaselinePath));
});

test("loadBaseline refuses literal duplicate entries and names the duplicate", () => {
  const dir = tempDir();
  const path = join(dir, "dup-literal.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", "002", "001"] }));
  assert.throws(() => loadBaseline(path), /duplicate entries for version "001"/);
});

test("loadBaseline refuses cross-formatted duplicate entries (\"001\" and \"1\" normalize the same)", () => {
  const dir = tempDir();
  const path = join(dir, "dup-cross-format.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", "1"] }));
  assert.throws(() => loadBaseline(path), /duplicate entries/);
});

test("loadBaseline refuses a numeric entry instead of coercing it (Codex's exact repro: 1 -> \"001\")", () => {
  const dir = tempDir();
  const path = join(dir, "numeric-entry.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: [1] }));
  assert.throws(() => loadBaseline(path), /non-string entry.*1.*number/s);
});

test("loadBaseline refuses a mixed valid/invalid array, naming the first invalid entry", () => {
  const dir = tempDir();
  const path = join(dir, "mixed.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", "002", 3, "004"] }));
  assert.throws(() => loadBaseline(path), /non-string entry/);
});

test("loadBaseline still accepts a clean, valid, non-duplicated, all-string baseline", () => {
  const dir = tempDir();
  const path = join(dir, "clean.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions: ["001", "002", "20260729010000"] }));
  const baseline = loadBaseline(path);
  assert.equal(baseline.acceptedPlaceholderVersions.size, 3);
});
