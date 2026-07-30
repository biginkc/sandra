import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSafety,
  identityKey,
  namespaceOf,
  numericValue,
} from "./check-migration-safety.mjs";

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
