#!/usr/bin/env node
// Manual end-to-end rehearsal for scripts/check-migration-safety.mjs against a
// disposable, host-only PostgreSQL 17 cluster. Never connects to a hosted
// project. Exercises the ACTUAL CLI (spawned as a subprocess, exactly as CI
// invokes it) end to end via a real psql connection, not just the pure
// evaluateSafety() unit is covered by check-migration-safety.test.mjs.
//
// Run:
//   LC_ALL=C node scripts/check-migration-safety.rehearsal.mjs
//
// (LC_ALL=C works around a known "postmaster became multithreaded" initdb
// flake on fresh local clusters; a short socket dir path avoids the unix
// socket path-length limit.)
//
// Exits non-zero and prints which scenario failed if any expectation is
// violated. Always tears down the disposable cluster, even on failure.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./check-migration-safety.mjs", import.meta.url));
const cluster = mkdtempSync(join(tmpdir(), "sandra-mig-safety-"));
const socketDir = mkdtempSync("/tmp/sgsock-"); // short path: unix socket path-length limit
const port = 5433 + Math.floor(Math.random() * 500);
let started = false;
let failures = 0;

// loadBaseline() now requires the baseline path to resolve inside the repo
// (round-2 fix: containment check against symlinked/escaping paths). Baseline
// FIXTURE files built for scenarios below must therefore live inside the
// repo, not under the system tmpdir -- otherwise they'd trip the containment
// check itself instead of exercising the scenario each one is meant to
// prove. (A genuinely-missing baseline path is the one exception: existence
// is checked before containment, so its location doesn't matter -- but it's
// still built here for consistency.) Removed in the `finally` block below.
const REPO_TEST_TMP_ROOT = fileURLToPath(new URL("./.test-tmp-baseline", import.meta.url));
mkdirSync(REPO_TEST_TMP_ROOT, { recursive: true });
function repoBaselineDir() {
  return mkdtempSync(join(REPO_TEST_TMP_ROOT, "case-"));
}

function run(name, args, options = {}) {
  return execFileSync(name, args, { stdio: "inherit", ...options });
}

function psql(sql, extraArgs = []) {
  return execFileSync(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql, ...extraArgs],
    { encoding: "utf8" },
  );
}

function resetHistoryTable() {
  psql("drop schema if exists supabase_migrations cascade;");
  psql(`
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
  `);
}

function insertHistoryRow(version, isPlaceholder) {
  const statements = isPlaceholder ? "NULL" : "ARRAY['select 1;']";
  psql(
    `insert into supabase_migrations.schema_migrations (version, statements, name) values ('${version}', ${statements}, '${version}_fixture');`,
  );
}

function writeMigrationsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-files-"));
  for (const file of files) {
    writeFileSync(join(dir, file), "-- fixture\nselect 1;\n");
  }
  return dir;
}

function runGate(migrationsDir, { baselinePath, env = {}, timeoutMs } = {}) {
  const args = [scriptPath, `--migrations-dir=${migrationsDir}`];
  if (baselinePath) args.push(`--baseline=${baselinePath}`);
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      PGHOST: socketDir,
      PGPORT: String(port),
      PGDATABASE: "postgres",
      PGUSER: "postgres",
      PGPASSWORD: "unused-trust-auth",
      ...env,
    },
  });
  return result;
}

function expect(label, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${label}`);
  } else {
    console.error(`  FAIL: ${label}`);
    if (detail) console.error(`        ${detail}`);
    failures += 1;
  }
}

const emptyBaseline = join(repoBaselineDir(), "baseline.json");
writeFileSync(emptyBaseline, JSON.stringify({ acceptedPlaceholderVersions: [] }));
const realBaselinePath = fileURLToPath(
  new URL("./migration-safety-baseline.json", import.meta.url),
);

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres"], {
    stdio: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  run(
    "pg_ctl",
    ["-D", cluster, "-o", `-p ${port} -k ${socketDir}`, "-l", join(cluster, "server.log"), "start"],
    { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } },
  );
  started = true;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      run("pg_isready", ["-h", socketDir, "-p", String(port), "-U", "postgres"], { stdio: "ignore" });
      break;
    } catch {
      if (attempt === 49) throw new Error("Postgres never became ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // --- Scenario 1: pass case -------------------------------------------------
  console.log("\n[1] Pass case: clean history, one legitimate new pending migration");
  resetHistoryTable();
  insertHistoryRow("086", false);
  insertHistoryRow("20260729170000", false);
  {
    const dir = writeMigrationsDir([
      "086_x.sql",
      "20260729170000_z.sql",
      "20260730120000_new_feature.sql",
    ]);
    const result = runGate(dir, { baselinePath: emptyBaseline });
    expect("exit code 0", result.status === 0, result.stdout + result.stderr);
    expect(
      "reports the new file as pending",
      /20260730120000_new_feature\.sql/.test(result.stdout),
      result.stdout,
    );
  }

  // --- Scenario 2: replay of the incident shape ------------------------------
  console.log("\n[2] Incident replay: old superseded file missing from history, newer history present");
  resetHistoryTable();
  insertHistoryRow("086", false);
  insertHistoryRow("20260728150000", false);
  insertHistoryRow("20260729170000", false);
  {
    const dir = writeMigrationsDir([
      "086_x.sql",
      "20260727150000_old_superseded.sql", // missing from history, older than max
      "20260728150000_y.sql",
      "20260729170000_z.sql",
    ]);
    const result = runGate(dir, { baselinePath: emptyBaseline });
    expect("exit code 1 (refuses)", result.status === 1, result.stdout + result.stderr);
    expect(
      "names the offending file",
      /20260727150000_old_superseded\.sql/.test(result.stderr),
      result.stderr,
    );
  }

  // --- Scenario 3: NULL-statements placeholder row ---------------------------
  console.log("\n[3] Unknown placeholder row (not in baseline) blocks the push");
  resetHistoryTable();
  insertHistoryRow("086", false);
  insertHistoryRow("20260730090000", true); // placeholder, NOT in baseline
  {
    const dir = writeMigrationsDir(["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(dir, { baselinePath: emptyBaseline });
    expect("exit code 1 (refuses)", result.status === 1, result.stdout + result.stderr);
    expect(
      "names the unknown placeholder version",
      /20260730090000/.test(result.stderr),
      result.stderr,
    );
  }
  console.log("\n[3b] Same placeholder version, but present in the baseline -> passes");
  {
    const baselinePath = join(repoBaselineDir(), "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ acceptedPlaceholderVersions: ["20260730090000"] }));
    const dir = writeMigrationsDir(["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(dir, { baselinePath });
    expect("exit code 0", result.status === 0, result.stdout + result.stderr);
  }
  console.log("\n[3c] Real committed baseline file (36-row prod shape) does not deadlock");
  resetHistoryTable();
  for (let n = 1; n <= 35; n += 1) {
    insertHistoryRow(String(n).padStart(3, "0"), true);
  }
  insertHistoryRow("086", false);
  insertHistoryRow("20260729010000", true);
  insertHistoryRow("20260729170000", false);
  {
    const files = [];
    for (let n = 1; n <= 35; n += 1) files.push(`${String(n).padStart(3, "0")}_legacy.sql`);
    files.push("086_x.sql", "20260729010000_hugo.sql", "20260729170000_z.sql", "20260730090000_new.sql");
    const dir = writeMigrationsDir(files);
    const result = runGate(dir, { baselinePath: realBaselinePath });
    expect(
      "exit code 0 using the actual committed baseline file",
      result.status === 0,
      result.stdout + result.stderr,
    );
  }

  console.log(
    "\n[3d] Codex's exact repro: missing baseline file + CLEAN history (zero placeholders) must " +
      "refuse, not pass",
  );
  resetHistoryTable();
  insertHistoryRow("086", false);
  insertHistoryRow("20260729170000", false);
  {
    const missingBaselinePath = join(
      mkdtempSync(join(tmpdir(), "sandra-mig-safety-missing-baseline-")),
      "does-not-exist.json",
    );
    const dir = writeMigrationsDir(["086_x.sql", "20260729170000_z.sql"]);
    const result = runGate(dir, { baselinePath: missingBaselinePath });
    expect(
      "exit code 1 (refuses; the pre-fix version returned {ok:true} here)",
      result.status === 1,
      result.stdout + result.stderr,
    );
    expect(
      "stdout/stderr never claims ok:true",
      !/"ok"\s*:\s*true/.test(result.stdout + result.stderr) && !/^OK:/m.test(result.stdout),
      result.stdout + result.stderr,
    );
    expect(
      "names the missing baseline file as the reason",
      /does not exist/.test(result.stderr),
      result.stderr,
    );
  }

  // --- Scenario 4: Sandra's mixed version scheme (legacy vs timestamp) ------
  console.log("\n[4] Mixed scheme: legacy 3-digit vs 14-digit timestamp ordering, both directions");
  resetHistoryTable();
  insertHistoryRow("085", false);
  insertHistoryRow("086", false);
  insertHistoryRow("20260729170000", false);
  {
    // (a) false-fail check: a new legacy-width file (087) newer only within
    // its own namespace must NOT be blocked by the far larger timestamp max.
    const dir = writeMigrationsDir([
      "085_a.sql",
      "086_b.sql",
      "20260729170000_c.sql",
      "087_late_legacy_backport.sql",
    ]);
    const result = runGate(dir, { baselinePath: emptyBaseline });
    expect(
      "(a) new legacy version 087 passes despite being numerically tiny vs the timestamp max",
      result.status === 0,
      result.stdout + result.stderr,
    );
  }
  {
    // (b) false-pass check: a pending legacy file (042) older than the
    // applied legacy max (086) must still be caught, even though a naive
    // global compare might reason about it only relative to the huge
    // timestamp max.
    const dir = writeMigrationsDir([
      "085_a.sql",
      "086_b.sql",
      "20260729170000_c.sql",
      "042_missing_from_history.sql",
    ]);
    const result = runGate(dir, { baselinePath: emptyBaseline });
    expect(
      "(b) old legacy version 042 missing from history is still refused",
      result.status === 1,
      result.stdout + result.stderr,
    );
    expect(
      "names 042 specifically",
      /042_missing_from_history\.sql/.test(result.stderr),
      result.stderr,
    );
  }

  // --- Scenario 5: DB unreachable must fail closed within a bounded time -----
  console.log("\n[5] Unreachable database: must fail closed within a bounded time, not hang");
  {
    const dir = writeMigrationsDir(["086_x.sql"]);
    const startedAt = Date.now();
    const result = spawnSync(
      process.execPath,
      [scriptPath, `--migrations-dir=${dir}`, `--baseline=${emptyBaseline}`],
      {
        encoding: "utf8",
        timeout: 30_000, // outer safety net for the rehearsal itself
        env: {
          ...process.env,
          // RFC 5737 TEST-NET-1: guaranteed non-routable, connection will hang/refuse.
          PGHOST: "192.0.2.1",
          PGPORT: "5432",
          PGDATABASE: "postgres",
          PGUSER: "postgres",
          PGPASSWORD: "unused",
        },
      },
    );
    const elapsedMs = Date.now() - startedAt;
    expect("exit code 1 (refuses, does not hang forever)", result.status === 1, result.stdout + result.stderr);
    expect(
      `completes within the gate's own timeout budget (took ${elapsedMs}ms)`,
      elapsedMs < 25_000,
      `took ${elapsedMs}ms`,
    );
  }

  console.log(`\n${failures === 0 ? "ALL SCENARIOS PASSED" : `${failures} SCENARIO CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  if (started) {
    try {
      run("pg_ctl", ["-D", cluster, "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {
      // best effort
    }
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
  rmSync(REPO_TEST_TMP_ROOT, { recursive: true, force: true });
}
