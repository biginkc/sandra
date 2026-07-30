#!/usr/bin/env node
// Manual end-to-end rehearsal for scripts/check-migration-safety.mjs against a
// disposable, host-only PostgreSQL 17 cluster. Never connects to a hosted
// project. Exercises the ACTUAL CLI wrapper (scripts/check-migration-safety-cli.mjs,
// spawned as a subprocess exactly as CI invokes it) end to end via a real
// psql connection, not just the pure evaluateSafety()/loadBaseline()/
// assertDeclaredIdentity() unit coverage in check-migration-safety.test.mjs.
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
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./check-migration-safety-cli.mjs", import.meta.url));
const cluster = mkdtempSync(join(tmpdir(), "sandra-mig-safety-"));
const socketDir = mkdtempSync("/tmp/sgsock-"); // short path: unix socket path-length limit
const port = 5433 + Math.floor(Math.random() * 500);
let started = false;
let failures = 0;
const scratchRepos = [];
const T = "test-target";

// loadBaseline() reads baseline content from git's object database
// (`git show HEAD:path`), never from the working-tree file directly, and the
// gate always inspects <repoRoot>/supabase/migrations (round-4 fix, P1-1) --
// never a caller-supplied directory. Scenarios below that need a CUSTOM
// baseline or migration set therefore build a full disposable scratch git
// repo, with migrations laid out at the CANONICAL supabase/migrations path
// inside it, and pass `--repo-root` pointing at that repo. This mirrors
// exactly how the gate is actually exercised in CI: the same directory
// layout, the same "read baseline from HEAD" mechanism, just against a
// throwaway repo. Scenarios that want the REAL production baseline (3c) use
// the real repo root (the default -- no override).
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

function simpleTarget(placeholderVersions, identity = {}) {
  return {
    project_ref: identity.projectRef ?? null,
    database: identity.database ?? null,
    db_system_identifier: identity.systemIdentifier ?? null,
    placeholder_versions: placeholderVersions,
  };
}

// Commits a targets-keyed baseline at the repo's DEFAULT baseline path
// (scripts/migration-safety-baseline.json, matching the real repo's layout)
// so most scenarios don't need to pass --baseline explicitly at all.
function commitDefaultBaseline(repoDir, targets) {
  const relativePath = join("scripts", "migration-safety-baseline.json");
  const fullPath = join(repoDir, relativePath);
  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  writeFileSync(fullPath, JSON.stringify({ targets }));
  execFileSync("git", ["-C", repoDir, "add", relativePath]);
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "baseline"]);
  return fullPath;
}

// Writes migration fixture files at the ONE path the gate will ever inspect:
// <repoDir>/supabase/migrations. There is deliberately no way to write them
// anywhere else and have the gate see them -- that is the P1-1 fix.
function writeCanonicalMigrations(repoDir, files) {
  const dir = join(repoDir, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file), "-- fixture\nselect 1;\n");
  }
  return dir;
}

function run(name, args, options = {}) {
  return execFileSync(name, args, { stdio: "inherit", ...options });
}

function psql(sql, extraArgs = [], env = {}) {
  return execFileSync(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", env.PGUSER ?? "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql, ...extraArgs],
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

// Creates a Postgres role whose name matches the `postgres.<ref>` pattern
// Supabase's Supavisor pooler uses, so assertDeclaredIdentity/
// assertLiveIdentity can be exercised end to end against a real (local)
// connection, exactly the same regex and live-query code path production
// uses -- not a mock.
function createPoolerStyleRole(ref) {
  const roleName = `postgres.${ref}`;
  psql(`create role "${roleName}" superuser login;`);
  return roleName;
}

function runGate(repoRoot, { target, baselinePath, env = {}, timeoutMs, extraArgs = [] } = {}) {
  const args = [cliPath];
  if (target !== undefined) args.push(`--target=${target}`);
  if (baselinePath) args.push(`--baseline=${baselinePath}`);
  if (repoRoot) args.push(`--repo-root=${repoRoot}`);
  args.push(...extraArgs);
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

const localRepo = initScratchGitRepo();
commitDefaultBaseline(localRepo, { [T]: simpleTarget([]) });
// Note: the REAL scripts/migration-safety-baseline.json's content (both
// real targets) is round-tripped via git HEAD by a unit test in
// check-migration-safety.test.mjs -- doing that here as well would require
// mirroring the real repo's entire real migrations directory into this
// disposable local Postgres cluster's history, which isn't necessary to
// prove the mechanism works (see scenario [3c] below, which proves the
// same 36-row SHAPE against a self-contained scratch repo instead).

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
  writeCanonicalMigrations(localRepo, ["086_x.sql", "20260729170000_z.sql", "20260730120000_new_feature.sql"]);
  {
    const result = runGate(localRepo, { target: T });
    expect("exit code 0", result.status === 0, result.stdout + result.stderr);
    expect(
      "reports the new file as pending",
      /20260730120000_new_feature\.sql/.test(result.stdout),
      result.stdout,
    );
  }

  // --- Scenario 2: replay of the incident shape ------------------------------
  console.log("\n[2] Incident replay: old superseded file missing from history, newer history present");
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    resetHistoryTable();
    insertHistoryRow("086", false);
    insertHistoryRow("20260728150000", false);
    insertHistoryRow("20260729170000", false);
    writeCanonicalMigrations(repo, [
      "086_x.sql",
      "20260727150000_old_superseded.sql", // missing from history, older than max
      "20260728150000_y.sql",
      "20260729170000_z.sql",
    ]);
    const result = runGate(repo, { target: T });
    expect("exit code 1 (refuses)", result.status === 1, result.stdout + result.stderr);
    expect(
      "names the offending file",
      /20260727150000_old_superseded\.sql/.test(result.stderr),
      result.stderr,
    );
  }

  // --- Scenario 3: NULL-statements placeholder row ---------------------------
  console.log("\n[3] Unknown placeholder row (not in baseline) blocks the push");
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    resetHistoryTable();
    insertHistoryRow("086", false);
    insertHistoryRow("20260730090000", true); // placeholder, NOT in baseline
    writeCanonicalMigrations(repo, ["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(repo, { target: T });
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
    commitDefaultBaseline(repo, { [T]: simpleTarget(["20260730090000"]) });
    writeCanonicalMigrations(repo, ["086_x.sql", "20260730090000_repaired.sql"]);
    // resetHistoryTable/insertHistoryRow already applied above; same cluster
    const result = runGate(repo, { target: T });
    expect("exit code 0", result.status === 0, result.stdout + result.stderr);
  }
  console.log("\n[3b-untracked] Same placeholder version in an UNTRACKED (uncommitted) baseline -> still refuses");
  {
    const repo = initScratchGitRepo();
    const baselinePath = join(repo, "scripts", "migration-safety-baseline.json");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify({ targets: { [T]: simpleTarget(["20260730090000"]) } }));
    // deliberately never `git add`/`git commit` this file
    writeCanonicalMigrations(repo, ["086_x.sql", "20260730090000_repaired.sql"]);
    const result = runGate(repo, { target: T });
    expect(
      "exit code 1 (refuses: baseline content on disk is irrelevant if untracked)",
      result.status === 1,
      result.stdout + result.stderr,
    );
  }
  console.log("\n[3c] Real 36-row prod placeholder SHAPE (scratch copy) does not deadlock");
  {
    // A self-contained scratch repo carrying the exact SHAPE of Sandra
    // production's real baseline (36 placeholder versions: 001-035 plus
    // 20260729010000), with a real pinned project_ref, so this proves two
    // things together: (i) that shape genuinely does not deadlock, and
    // (ii) identity pinning is enforced even for a target that otherwise
    // would pass -- a matching local role passes, the default unbound role
    // (no ref) refuses. The REAL scripts/migration-safety-baseline.json's
    // own content (not just its shape) is separately round-tripped via git
    // HEAD by a unit test in check-migration-safety.test.mjs, which doesn't
    // require mirroring the real repo's entire real migrations directory
    // into this disposable local Postgres cluster's history.
    const ref = "sandraprodshapetestre"; // NOTE: trimmed to 20 chars below
    const trimmedRef = ref.slice(0, 20);
    const repo = initScratchGitRepo();
    const placeholders = [];
    for (let n = 1; n <= 35; n += 1) placeholders.push(String(n).padStart(3, "0"));
    placeholders.push("20260729010000");
    commitDefaultBaseline(repo, {
      "prod-shape": simpleTarget(placeholders, { projectRef: trimmedRef, database: "postgres" }),
    });
    resetHistoryTable();
    for (let n = 1; n <= 35; n += 1) insertHistoryRow(String(n).padStart(3, "0"), true);
    insertHistoryRow("086", false);
    insertHistoryRow("20260729010000", true);
    insertHistoryRow("20260729170000", false);
    const files = [];
    for (let n = 1; n <= 35; n += 1) files.push(`${String(n).padStart(3, "0")}_legacy.sql`);
    files.push("086_x.sql", "20260729010000_hugo.sql", "20260729170000_z.sql", "20260730090000_new.sql");
    writeCanonicalMigrations(repo, files);

    const roleName = createPoolerStyleRole(trimmedRef);
    const passResult = runGate(repo, { target: "prod-shape", env: { PGUSER: roleName } });
    expect(
      "36-row shape passes with a matching identity (no deadlock)",
      passResult.status === 0,
      passResult.stdout + passResult.stderr,
    );

    const refuseResult = runGate(repo, { target: "prod-shape" }); // default PGUSER=postgres, no ref
    expect(
      "the SAME 36-row shape refuses with an unbound/mismatched identity (pinning is enforced, not dead config)",
      refuseResult.status === 1,
      refuseResult.stdout + refuseResult.stderr,
    );
  }

  console.log(
    "\n[3d] Codex's round-1 repro: missing baseline path + CLEAN history (zero placeholders) must " +
      "refuse, not pass",
  );
  {
    const repo = initScratchGitRepo();
    resetHistoryTable();
    insertHistoryRow("086", false);
    insertHistoryRow("20260729170000", false);
    writeCanonicalMigrations(repo, ["086_x.sql", "20260729170000_z.sql"]);
    const missingBaselinePath = join(repo, "scripts", "does-not-exist-baseline.json");
    const result = runGate(repo, { target: T, baselinePath: missingBaselinePath });
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
    resetHistoryTable();
    insertHistoryRow("086", false);
    insertHistoryRow("20260730090000", true);
    writeCanonicalMigrations(repo, ["086_x.sql", "20260730090000_repaired.sql"]);
    const outsideDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-outside-"));
    const outsideFile = join(outsideDir, "evil.json");
    writeFileSync(outsideFile, JSON.stringify({ targets: { [T]: simpleTarget(["20260730090000"]) } }));
    const hardlinkedPath = join(repo, "hardlinked-baseline.json");
    execFileSync("ln", [outsideFile, hardlinkedPath]);
    const result = runGate(repo, { target: T, baselinePath: hardlinkedPath });
    expect(
      "exit code 1 (refuses despite the hardlink sharing content with a valid-looking baseline)",
      result.status === 1,
      result.stdout + result.stderr,
    );
  }

  // --- Scenario 4: Sandra's mixed version scheme (legacy vs timestamp) ------
  console.log("\n[4] Mixed scheme: legacy 3-digit vs 14-digit timestamp ordering, both directions");
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    resetHistoryTable();
    insertHistoryRow("085", false);
    insertHistoryRow("086", false);
    insertHistoryRow("20260729170000", false);

    // (a) false-fail check: a new legacy-width file (087) newer only within
    // its own namespace must NOT be blocked by the far larger timestamp max.
    writeCanonicalMigrations(repo, [
      "085_a.sql",
      "086_b.sql",
      "20260729170000_c.sql",
      "087_late_legacy_backport.sql",
    ]);
    const resultA = runGate(repo, { target: T });
    expect(
      "(a) new legacy version 087 passes despite being numerically tiny vs the timestamp max",
      resultA.status === 0,
      resultA.stdout + resultA.stderr,
    );
  }
  {
    // (b) false-pass check: a pending legacy file (042) older than the
    // applied legacy max (086) must still be caught, even though a naive
    // global compare might reason about it only relative to the huge
    // timestamp max.
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    resetHistoryTable();
    insertHistoryRow("085", false);
    insertHistoryRow("086", false);
    insertHistoryRow("20260729170000", false);
    writeCanonicalMigrations(repo, [
      "085_a.sql",
      "086_b.sql",
      "20260729170000_c.sql",
      "042_missing_from_history.sql",
    ]);
    const result = runGate(repo, { target: T });
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
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    writeCanonicalMigrations(repo, ["086_x.sql"]);
    const startedAt = Date.now();
    const result = runGate(repo, {
      target: T,
      timeoutMs: 30_000,
      env: {
        // RFC 5737 TEST-NET-1: guaranteed non-routable, connection will hang/refuse.
        PGHOST: "192.0.2.1",
        PGPORT: "5432",
        PGDATABASE: "postgres",
        PGUSER: "postgres",
        PGPASSWORD: "unused",
      },
    });
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
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    writeCanonicalMigrations(repo, ["086_x.sql"]);
    resetHistoryTable();
    insertHistoryRow("086", false);
    const symlinkDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-symlink-"));
    const symlinkToCli = join(symlinkDir, "run-via-symlink.mjs");
    execFileSync("ln", ["-s", cliPath, symlinkToCli]);
    const result = spawnSync(
      process.execPath,
      [symlinkToCli, `--target=${T}`, `--repo-root=${repo}`],
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

  // --- Scenario 7 (round 4, P1-1): the gate refuses to inspect a directory
  // other than the canonical one -----------------------------------------
  console.log("\n[7] Canonical migrations directory: gate refuses --migrations-dir and symlinked directories");
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    writeCanonicalMigrations(repo, ["086_x.sql"]);
    resetHistoryTable();
    insertHistoryRow("086", false);

    const decoyDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-decoy-"));
    writeFileSync(join(decoyDir, "999_totally_different.sql"), "select 1;\n");

    const result = runGate(repo, { target: T, extraArgs: [`--migrations-dir=${decoyDir}`] });
    expect(
      "(a) --migrations-dir is rejected outright, not silently honored",
      result.status === 1,
      result.stdout + result.stderr,
    );
    expect(
      "names the reason as the caller-controlled-directory gap",
      /--migrations-dir is not accepted/.test(result.stderr),
      result.stderr,
    );
  }
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    resetHistoryTable();
    insertHistoryRow("086", false);
    // Symlink the canonical migrations directory itself to a directory with
    // DIFFERENT content -- proving the gate refuses rather than silently
    // inspecting whatever the symlink resolves to.
    const realElsewhere = mkdtempSync(join(tmpdir(), "sandra-mig-safety-symlinked-migrations-"));
    writeFileSync(join(realElsewhere, "999_totally_different.sql"), "select 1;\n");
    mkdirSync(join(repo, "supabase"), { recursive: true });
    execFileSync("ln", ["-s", realElsewhere, join(repo, "supabase", "migrations")]);

    const result = runGate(repo, { target: T });
    expect(
      "(b) a symlinked migrations directory is refused, not silently followed",
      result.status === 1,
      result.stdout + result.stderr,
    );
    expect("names it as a symlink", /is a symlink/.test(result.stderr), result.stderr);
  }

  // --- Scenario 8 (round 4, P1-2): independent project-identity binding ------
  console.log("\n[8] Project-identity binding: live connection must match the target's declared identity");
  {
    const ref = "sandraidentitytestref"; // NOTE: must be exactly 20 lowercase letters
    const trimmedRef = ref.slice(0, 20);
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, {
      [T]: simpleTarget([], { projectRef: trimmedRef, database: "postgres" }),
    });
    writeCanonicalMigrations(repo, ["086_x.sql"]);
    resetHistoryTable();
    insertHistoryRow("086", false);
    const roleName = createPoolerStyleRole(trimmedRef);

    {
      // (a) matching declared + live identity passes.
      const result = runGate(repo, { target: T, env: { PGUSER: roleName } });
      expect(
        "(a) matching PGUSER (postgres.<ref>) + live current_database() passes",
        result.status === 0,
        result.stdout + result.stderr,
      );
      expect(
        "prints the exact-match declared identity",
        /declared ref .* \(exact match\)/.test(result.stdout),
        result.stdout,
      );
    }
    {
      // (b) mismatched project ref refuses, even though the connection is a
      // real, successfully-authenticated connection to a real database.
      const wrongRole = createPoolerStyleRole("wrongwrongwrongwrong");
      const result = runGate(repo, { target: T, env: { PGUSER: wrongRole } });
      expect(
        "(b) a real connection under the WRONG project ref still refuses",
        result.status === 1,
        result.stdout + result.stderr,
      );
      expect(
        "names the ref mismatch",
        new RegExp(`expects "${trimmedRef}"`).test(result.stderr),
        result.stderr,
      );
    }
    {
      // (c) PGDATABASE mismatch refuses even with a correct project ref.
      const result = runGate(repo, { target: T, env: { PGUSER: roleName, PGDATABASE: "not_postgres" } });
      expect(
        "(c) a PGDATABASE mismatch refuses even with the correct project ref",
        result.status === 1,
        result.stdout + result.stderr,
      );
    }
  }

  // --- Scenario 9 (round 4, P2): a hung git show must not hang the gate ------
  console.log("\n[9] A wedged `git` process must refuse (not hang) within a bounded time");
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    writeCanonicalMigrations(repo, ["086_x.sql"]);
    resetHistoryTable();
    insertHistoryRow("086", false);

    const fakeGitDir = mkdtempSync(join(tmpdir(), "sandra-mig-safety-fakegit-"));
    const fakeGitPath = join(fakeGitDir, "git");
    writeFileSync(fakeGitPath, "#!/bin/sh\nsleep 30\n");
    chmodSync(fakeGitPath, 0o755);

    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [cliPath, `--target=${T}`, `--repo-root=${repo}`], {
      encoding: "utf8",
      timeout: 20_000, // outer safety net for the rehearsal itself
      env: {
        ...process.env,
        PATH: `${fakeGitDir}:${process.env.PATH}`,
        PGHOST: socketDir,
        PGPORT: String(port),
        PGDATABASE: "postgres",
        PGUSER: "postgres",
        PGPASSWORD: "unused-trust-auth",
      },
    });
    const elapsedMs = Date.now() - startedAt;
    expect("exit code 1 (refuses rather than hanging on the wedged git)", result.status === 1, result.stdout + result.stderr);
    expect(
      `completes well before the fake git's 30s sleep (took ${elapsedMs}ms)`,
      elapsedMs < 15_000,
      `took ${elapsedMs}ms`,
    );
    expect(
      "names the git timeout as the reason",
      /did not complete within .*ms and was killed/.test(result.stderr),
      result.stderr,
    );
  }

  // --- Scenario 10 (round 6, P2): duplicate local migration versions ---------
  console.log("\n[10] Duplicate local migration versions (Codex's exact repro: two files both at 087)");
  {
    const repo = initScratchGitRepo();
    commitDefaultBaseline(repo, { [T]: simpleTarget([]) });
    resetHistoryTable();
    insertHistoryRow("086", false);
    const dir = join(repo, "supabase", "migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "086_x.sql"), "-- fixture\nselect 1;\n");
    writeFileSync(join(dir, "087_first.sql"), "-- fixture\nselect 1;\n");
    writeFileSync(join(dir, "087_second.sql"), "-- fixture\nselect 1;\n");
    const result = runGate(repo, { target: T });
    expect(
      "exit code 1 (refuses; the pre-fix version returned {ok:true} here per Codex's repro)",
      result.status === 1,
      result.stdout + result.stderr,
    );
    expect(
      "names both colliding files and the shared version",
      /Two local migration files normalize to the same version \(087\): "087_first\.sql" and "087_second\.sql"/.test(
        result.stderr,
      ),
      result.stderr,
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
