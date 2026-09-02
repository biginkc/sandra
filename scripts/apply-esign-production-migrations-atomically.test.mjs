import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  loadReviewedPlan,
  splitSupabaseStatements,
} from "./apply-esign-production-migrations-atomically.mjs";

const repoRoot = join(import.meta.dirname, "..");
const planPath = join(import.meta.dirname, "esign-atomic-production-plan.json");
const switchboardPath = join(
  repoRoot,
  "supabase/migrations/20260830092331_switchboard_contact_preferences.sql",
);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("Supabase 2.109.1-compatible parser preserves transaction and quoted bodies", () => {
  const sql = `-- header\nbegin;\nselect ';' as value;\nselect (1;);\ndo $body$\nbegin\n  perform 1;\nend\n$body$;\ncommit;`;
  assert.deepEqual(splitSupabaseStatements(sql), [
    "-- header\nbegin",
    "select ';' as value",
    "select (1;)",
    "do $body$\nbegin\n  perform 1;\nend\n$body$",
    "commit",
  ]);
});

test("reviewed packet pins exact file and statement-array identities", () => {
  const manifest = JSON.parse(readFileSync(planPath, "utf8"));
  assert.deepEqual(
    manifest.migrations.map((entry) => entry.version),
    [
      "20260829194500",
      "20260830080000",
      "20260830100000",
      "20260902074814",
    ],
  );
  for (const entry of manifest.migrations) {
    const sql = readFileSync(join(repoRoot, entry.path), "utf8");
    assert.equal(hash(sql), entry.sha256);
    assert.equal(hash(JSON.stringify(splitSupabaseStatements(sql))), entry.statementsSha256);
  }
  assert.equal(manifest.switchboard.sha256, "c4530a37e58cb69140661a62dc355e6555435d9ee8d3c1c4f59aa9134af3f30f");
  assert.equal(manifest.switchboard.statementsSha256, "741a9c39af4b3ef1346ae0e80aae28e1cf916fd331750c3a484fae7b370e1353");
  if (existsSync(switchboardPath)) {
    const plan = loadReviewedPlan(planPath);
    assert.equal(plan.switchboard.statements.length, 32);
  }
});

test("reviewed packet includes the disconnect state migration", () => {
  const manifest = JSON.parse(readFileSync(planPath, "utf8"));
  const entry = manifest.migrations.find(
    (migration) => migration.version === "20260902074814",
  );
  assert.ok(entry, "disconnect migration missing from atomic packet");
  assert.equal(entry.name, "esign_atomic_disconnect_state");
  assert.equal(
    entry.path,
    "supabase/migrations/20260902074814_esign_atomic_disconnect_state.sql",
  );
  assert.equal(
    entry.sha256,
    "075e183886c9ec16cde0eb13ec850f7a154eb048b93b6bc5f0e440a3d4a9a1dd",
  );
  assert.equal(
    entry.statementsSha256,
    "b1bd4a606d8ec8a7d303381e7c541fa864f30bdf5d6fa1f1edf373e0bda73a14",
  );
});

test("the manual packet refuses before reading credentials when arguments are incomplete", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "apply-esign-production-migrations-atomically.mjs")],
    { encoding: "utf8", env: {} },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /REFUSING: Usage:/u);
  assert.doesNotMatch(result.stderr, /password|postgres:\/\//iu);
});

test("official CLI tag remains pinned for ledger compatibility evidence", () => {
  const manifest = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(manifest.supabaseCliVersion, "2.109.1");
});
