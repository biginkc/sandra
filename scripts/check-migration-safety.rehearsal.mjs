#!/usr/bin/env node
// Manual end-to-end rehearsal for scripts/check-migration-safety.mjs against a
// disposable, host-only PostgreSQL 17 cluster. Never connects to a hosted
// project. Exercises the ACTUAL CLI wrapper (scripts/check-migration-safety-cli.mjs,
// spawned as a subprocess exactly as CI invokes it) end to end via a real
// psql connection, not just the pure evaluateSafety()/loadBaseline() unit
// coverage in check-migration-safety.test.mjs.
//
// Run:
//   LC_ALL=C node scripts/check-migration-safety.rehearsal.mjs
//
// (LC_ALL=C works around a known "postmaster became multithreaded" initdb
// flake on fresh local clusters; a short socket dir path avoids the unix
// socket path-length limit.)
//
// Exits non-zero and prints which scenario failed if any expectation is
// violated. Always tears down the disposable cluster (and any scratch git
// repos created for baseline fixtures), even on failure.

import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./check-migration-safety-cli.mjs", import.meta.url));
const realRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const cluster = mkdtempSync(join(tmpdir(), "sandra-mig-safety-"));
const socketDir = mkdtempSync("/tmp/sgsock-"); // short path: unix socket path-length limit
const port = 5433 + Math.floor(Math.random() * 500);
let started = false;
let failures = 0;
const scratchRepos = [];

// loadBaseline() reads baseline content from git's object database
// (`git show HEAD:path`), never from the working-tree file directly -- see
// the round-3 fix in check-migration-safety.mjs (provenance + TOCTOU).
// Scenarios below that need a CUSTOM baseline therefore commit it into a
// disposable scratch git repo and pass `--repo-root` pointing at that repo,
// mirroring exactly how loadBaseline is actually exercised. Scenarios that
// want the REAL production baseline (3c) use the real repo root (the
// default -- no override) and the real committed
// scripts/migration-safety-baseline.json.
function initScratchGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-gitrepo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "scratch repo for rehearsal baseline fixtures\n");
  execFileSync("git", ["-C", dir, "add", "README.md"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  scratchRepos.push(dir);
  return dir;
}

function commitBaseline(repoDir, acceptedPlaceholderVersions) {
  const path = join(repoDir, "baseline.json");
  writeFileSync(path, JSON.stringify({ acceptedPlaceholderVersions }));
  execFileSync("git", ["-C", repoDir, "add", "baseline.json"]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "baseline"]);
  return path;
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

function runGate(migrationsDir, { baselinePath, repoRoot, env = {}, timeoutMs } = {}) {
  const args = [cliPath, `--migrations-dir=${migrationsDir}`];
  if (baselinePath) args.push(`--baseline=${baselinePath}`);
  if (repoRoot) args.push(`--repo-root=${repoRoot}`);
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

const emptyBaselineRepo = initScratchGitRepo();
const emptyBaseline = commitBaseline(emptyBaselineRepo, []);
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
    const result = runGate(dir, { baselinePath: emptyBaseline, repoRoot: emptyBaselineRepo });
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
    const result = runGate(dir, { baselinePath: emptyBaseline, repoRoot: emptyBaselineRepo });
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
    const result = runGate(dir, { baselinePath: emptyBaseline, repoRoot: emptyBaselineRepo });
    expect("exit code 1 (refuses)", result.status === 1, result.stdout + result.stderr);
    expect(
      "names the unknown placeholder version",
      /20260730090000/.test(result.stderr),
      result.stderr,
    );
  }
  console.log("\n[3b] Same placeholder version, but present in a COMMITTED baseline -> passes");
  {
    const repo = initScratchGitRepo();
    const baselinePath = commitBaseline(repo, ["20260730090000"]);
    const dir = writeMigrationsDir(["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(dir, { baselinePath, repoRoot: repo });
    expect("exit code 0", result.status === 0, result.stdout + result.stderr);
  }
  console.log("\n[3b-untracked] Same placeholder version in an UNTRACKED (uncommitted) baseline -> still refuses");
  {
    const repo = initScratchGitRepo();
    const baselinePath = join(repo, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ acceptedPlaceholderVersions: ["20260730090000"] }));
    // deliberately never `git add`/`git commit` this file
    const dir = writeMigrationsDir(["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(dir, { baselinePath, repoRoot: repo });
    expect(
      "exit code 1 (refuses: baseline content on disk is irrelevant if untracked)",
      result.status === 1,
      result.stdout + result.stderr,
    );
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
    // No repoRoot override -- exercises the real production path: the
    // actual committed baseline, read via git HEAD in the real Sandra repo.
    const result = runGate(dir, { baselinePath: realBaselinePath });
    expect(
      "exit code 0 using the actual committed baseline file (default repo root)",
      result.status === 0,
      result.stdout + result.stderr,
    );
  }

  console.log(
    "\n[3d] Codex's round-1 repro: missing baseline path + CLEAN history (zero placeholders) must " +
      "refuse, not pass",
  );
  resetHistoryTable();
  insertHistoryRow("086", false);
  insertHistoryRow("20260729170000", false);
  {
    const missingBaselinePath = join(realRepoRoot, "scripts", "does-not-exist-baseline.json");
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
      "names the git-HEAD read failure as the reason",
      /could not be read from git HEAD/.test(result.stderr),
      result.stderr,
    );
  }

  console.log(
    "\n[3e] Round-3 repro: HARDLINK at an in-repo-looking baseline pathname pointing at malicious " +
      "content outside the repo -> refuses (untracked at HEAD, regardless of inode)",
  );
  {
    const repo = initScratchGitRepo();
    const outsideDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-outside-"));
    const outsideFile = join(outsideDir, "evil.json");
    writeFileSync(outsideFile, JSON.stringify({ acceptedPlaceholderVersions: ["20260730090000"] }));
    const hardlinkedPath = join(repo, "hardlinked-baseline.json");
    execFileSync("ln", [outsideFile, hardlinkedPath]);
    const dir = writeMigrationsDir(["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(dir, { baselinePath: hardlinkedPath, repoRoot: repo });
    expect(
      "exit code 1 (refuses despite the hardlink sharing content with a valid-looking baseline)",
      result.status === 1,
      result.stdout + result.stderr,
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
    const result = runGate(dir, { baselinePath: emptyBaseline, repoRoot: emptyBaselineRepo });
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
    const result = runGate(dir, { baselinePath: emptyBaseline, repoRoot: emptyBaselineRepo });
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
      [cliPath, `--migrations-dir=${dir}`, `--baseline=${emptyBaseline}`, `--repo-root=${emptyBaselineRepo}`],
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

  // --- Scenario 6: symlinked invocation must still run the gate --------------
  console.log("\n[6] Invoking the CLI wrapper through a symlink still runs the gate (P1-3 fix)");
  {
    const dir = writeMigrationsDir(["086_x.sql"]);
    const symlinkDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-symlink-"));
    const symlinkToCli = join(symlinkDir, "run-via-symlink.mjs");
    execFileSync("ln", ["-s", cliPath, symlinkToCli]);
    resetHistoryTable();
    insertHistoryRow("086", false);
    const result = spawnSync(
      process.execPath,
      [symlinkToCli, `--migrations-dir=${dir}`, `--baseline=${emptyBaseline}`, `--repo-root=${emptyBaselineRepo}`],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PGHOST: socketDir,
          PGPORT: String(port),
          PGDATABASE: "postgres",
          PGUSER: "postgres",
          PGPASSWORD: "unused-trust-auth",
        },
      },
    );
    expect("exit code 0 (gate actually ran through the symlink)", result.status === 0, result.stdout + result.stderr);
    expect(
      "gate banner present in stdout (proves main() executed, not a silent no-op)",
      /== Migration safety gate ==/.test(result.stdout),
      result.stdout,
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
  for (const repo of scratchRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
}
