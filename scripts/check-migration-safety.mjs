#!/usr/bin/env node
// Mandatory preflight gate for any `supabase db push --include-all` against a
// linked Sandra project (TEST or PRODUCTION).
//
// Why this exists (2026-07-30 incident, BMH Institute):
// An automated reconciliation loop treated "this migration version has no row
// in supabase_migrations.schema_migrations" as "this migration's content was
// never applied," and re-ran an old, already-superseded migration file
// directly against BMH Institute production, out of order. `--include-all`
// re-applies every migration missing from remote history, in filename order,
// with no notion of whether a later migration already touched the same
// objects. That re-apply reverted 6 hardened functions and broke user
// provisioning for hours. Sandra's db-migrate.yml runs the exact same
// `db push --include-all` pattern against Sandra's prod project
// (copflsklaefwzipsrjqz) on every push to main that touches
// supabase/migrations/** — and Sandra is the only BMH app with real
// production users.
//
// This is an independent implementation for Sandra, not a straight port of
// the Institute script (BMH Institute PR #155). Both guards have been through
// several rounds of adversarial review and independently arrived at the same
// two "checked == pushed" bindings below (round-4 review, Codex) -- this file
// deliberately CONVERGES on the same mechanism as BMH Institute's guard
// (scripts/migration-rehearsal/check-migration-safety.mjs) for both, rather
// than inventing a second shape, per explicit coordination instruction.
//
// This script only inspects and reports. It never runs `supabase db push`,
// `supabase migration repair`, or any writing SQL itself.
//
// This file is a LIBRARY: it exports main() but never calls it (see the note
// at the bottom of the file for why). Run it via the CLI wrapper:
//
// Usage:
//   PGHOST=... PGPORT=... PGDATABASE=... PGUSER=... PGPASSWORD=... [PGSSLMODE=require] \
//     node scripts/check-migration-safety-cli.mjs \
//       --target=sandra-production \
//       [--baseline=scripts/migration-safety-baseline.json]
//
// Deliberately NO --migrations-dir option reachable here (round-4 finding
// P1-1): the gate always inspects <repoRoot>/supabase/migrations, the exact
// path `supabase db push` reads, so the two can never diverge. A test-only
// `--repo-root` override exists for pointing the ENTIRE resolution (baseline
// git reads AND the canonical migrations directory) at a disposable scratch
// repo; it cannot be used to point the migrations directory somewhere else
// while leaving everything else pointed at the real repo.
//
// Exit code 0: safe to proceed to a `db push --include-all --dry-run` review.
// Exit code 1: refuse. Print the reason and let a human resolve it.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASELINE_PATH = "scripts/migration-safety-baseline.json";
// This file lives at <repo>/scripts/check-migration-safety.mjs, so its
// grandparent directory is the repo root. Used to enforce that a baseline
// path can never resolve outside the repository (see loadBaseline), and to
// derive the one and only migrations directory this gate will ever inspect.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Overall wall-clock budget for the psql round trip. A blackholed network
// (dropped packets, a security-group change, a misconfigured pooler) must
// fail this gate closed within a bounded time, not hang the CI job forever
// while the caller assumes the gate is "still checking." Also set as
// PGCONNECT_TIMEOUT (seconds) so the TCP/auth handshake itself times out
// before we fall back to this outer kill.
const PSQL_TIMEOUT_MS = 20_000;
// Round-4 fix (P2): reading the baseline blob is a single `git show` against
// a LOCAL repository -- it should be near-instant. A generous but bounded
// timeout still catches a wedged git process (lock contention, a hung
// filesystem, a misbehaving credential helper invoked by git for no reason
// on a local read) instead of hanging until the CI job's outer timeout.
const GIT_SHOW_TIMEOUT_MS = 10_000;
// Supabase project refs are exactly 20 lowercase letters. Anchored, not a
// substring test -- see assertDeclaredIdentity.
const PGUSER_REF = /^postgres\.([a-z]{20})$/;
const PGHOST_REF = /^db\.([a-z]{20})\.supabase\.co$/;

export function parseArguments(argv) {
  const map = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match) {
      map[match[1]] = match[2] ?? "true";
    }
  }
  return map;
}

// --- Version parsing -------------------------------------------------------
//
// Sandra's migrations directory mixes two version-string widths:
//   - 3-digit legacy sequence numbers: "001".."086"
//   - 14-digit UTC timestamps: "20260729170000"
// Both are pure-digit strings. `numericValue` gives the BigInt magnitude,
// used ONLY for within-namespace ordering (see `namespaceOf` below) and for
// cross-format identity comparison (see `identityKey` below). It is never
// used to compare a legacy version directly against a timestamp version —
// that comparison is numerically well-defined (any 3-digit number is less
// than any 14-digit number) but semantically meaningless: the two schemes
// were never meant to be interleaved, so "legacy version 086 is chronologically
// before timestamp version 20260612054256" is true by construction of the
// repo's history, not something this gate needs to prove or rely on.
export function numericValue(version) {
  if (!/^\d+$/.test(version)) {
    throw new Error(
      `Migration version "${version}" is not purely numeric. Refusing to guess its chronological order.`,
    );
  }
  return BigInt(version);
}

// Identity key: two version strings that represent the SAME migration but are
// formatted differently ("001" vs "1", "0001" vs "001") must be recognized as
// the same version when deciding whether a local file is already applied.
// Fixed defect: the Institute script compared applied-version identity with
// raw string equality while comparing ORDER with BigInt — so "1" in history
// and a local file "001_new.sql" were treated as two different versions
// (fails the identity check, wrongly "pending") even though BigInt("001") ===
// BigInt("1") (passes the ordering check as "not older"), producing a false
// green light for what is actually an already-applied migration re-appearing
// under different zero-padding. Using the same BigInt-derived key for BOTH
// identity and ordering closes that gap.
export function identityKey(version) {
  return numericValue(version).toString();
}

// Namespace key: which "digit-width scheme" a version belongs to. Ordering
// comparisons (used only to detect "this pending file is older than history's
// high-water mark", i.e. the out-of-order re-apply pattern) are scoped to a
// single namespace. A pending 3-digit file is only ever compared against the
// newest APPLIED 3-digit version; a pending 14-digit timestamp file is only
// ever compared against the newest applied 14-digit version. This avoids
// relying on cross-namespace numeric comparisons (see `numericValue` above)
// for any safety decision.
export function namespaceOf(version) {
  return String(version.length);
}

// --- psql -------------------------------------------------------------------
//
// Round-5 fix: there used to be a separate CSV-based history query
// (runPsqlCsv) invoked as its own `psql` process alongside the identity
// probe's own separate process -- two connections built from the same env
// vars but not the same session. Removed in favor of a single combined
// JSON query (fetchIdentityAndHistory, below) so identity and history can
// never come from two different connections by construction. Keeping a
// general-purpose "run arbitrary SQL over its own new connection" helper
// around would be a standing invitation to reintroduce that split by
// accident in a future change, so it is gone rather than left unused.

function runPsqlSingleJson(sql, options = {}) {
  const requiredEnv = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
  const missing = requiredEnv.filter((name) => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Missing required psql connection env var(s): ${missing.join(", ")}. ` +
        "Export PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (and PGSSLMODE for hosted projects) before running this gate.",
    );
  }
  const timeoutMs = options.timeoutMs ?? PSQL_TIMEOUT_MS;
  const connectTimeoutSeconds = Math.max(1, Math.floor(timeoutMs / 1000));
  let output;
  try {
    output = execFileSync(
      "psql",
      ["--no-psqlrc", "--quiet", "--no-align", "--tuples-only", "--set", "ON_ERROR_STOP=1", "-c", sql],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PGCONNECT_TIMEOUT: String(connectTimeoutSeconds) },
      },
    );
  } catch (error) {
    if (error.signal === "SIGKILL" || error.killed) {
      throw new Error(
        `psql did not complete within ${timeoutMs}ms and was killed. Treating this as a ` +
          "connection failure: refusing rather than guessing the database is reachable.",
      );
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`psql could not read the live connection identity: ${stderr || error.message}`);
  }
  try {
    return JSON.parse(String(output).trim());
  } catch {
    throw new Error(`psql returned output that is not the expected JSON payload: ${String(output).slice(0, 400)}`);
  }
}

// --- Checked == pushed, binding 1: canonical migrations directory ----------
//
// Round-4 review finding P1-1: `--migrations-dir` was caller-controlled. The
// gate validated whatever directory it was handed while `supabase db push`
// always reads the linked project's canonical `supabase/migrations`. A
// caller could point the gate at a clean directory, get a green result, then
// push something entirely different -- the safety check and the actual
// operation would be evaluating different files, making the gate decorative.
//
// Fixed by removing the option rather than validating it: this gate has
// exactly one migrations directory it will ever inspect, always derived as
// <repoRoot>/supabase/migrations, never independently specified. A symlink
// anywhere between repoRoot and that directory would let the gate and
// `supabase db push` resolve the same string to two different physical
// directories, so every path component is lstat-checked (not just the
// final one) and refused if any of them is a symlink.
export function canonicalMigrationsDir(repoRoot) {
  return resolve(repoRoot, "supabase", "migrations");
}

export function assertNoSymlinkInMigrationsPath(migrationsDir, repoRoot) {
  const rest = relative(repoRoot, migrationsDir);
  const insideRepo = rest !== "" && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
  const chain = [];
  if (insideRepo) {
    let current = repoRoot;
    for (const part of rest.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      chain.push(current);
    }
  } else {
    chain.push(migrationsDir);
  }
  for (const candidate of chain) {
    let info;
    try {
      info = lstatSync(candidate);
    } catch {
      continue; // absence is reported by loadLocalMigrationVersions instead
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `Migrations path component "${candidate}" is a symlink. Refusing: \`supabase db push\` reads ` +
          "the repository path directly, so a symlink would let the gate inspect one directory while " +
          "the push applies another.",
      );
    }
  }
}

// --- Local migration files ---------------------------------------------------

export function loadLocalMigrationVersions(migrationsDir) {
  if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) {
    throw new Error(
      `Migrations directory "${migrationsDir}" does not exist or is not a directory. ` +
        "Refusing to treat a missing/wrong path as \"nothing pending.\"",
    );
  }
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  return files.map((name) => {
    const match = /^(\d+)_/.exec(name);
    if (!match) {
      throw new Error(`Migration file "${name}" does not start with a numeric version prefix.`);
    }
    return { file: name, version: match[1] };
  });
}

// --- Checked == pushed, binding 2: independent project-identity binding ----
//
// Round-4 review finding P1-2: the gate trusted whatever PGHOST/PGUSER/
// password it was handed. The workflow derives them from `supabase link` +
// `supabase/.temp/pooler-url`, but the gate itself never verified the
// database it queried was actually the pinned project -- meaning the gate
// could read history from one database while the push writes another, with
// nothing in the gate's own logic to catch a misconfigured secret, a swapped
// environment variable, or a future refactor that breaks that derivation
// chain silently.
//
// Two layers, matching BMH Institute's converged design exactly:
//
// 1. DECLARED identity (assertDeclaredIdentity): the project ref is parsed
//    from PGUSER (`postgres.<ref>`) and/or PGHOST (`db.<ref>.supabase.co`) by
//    ANCHORED pattern -- never a substring test. A hostname or username that
//    merely CONTAINS the expected ref no longer passes. If both PGUSER and
//    PGHOST parse, they must agree. This is not circular even though it
//    reads our own connection env: Supabase's pooler (Supavisor) routes
//    purely by the authenticated username, so successfully authenticating
//    AS `postgres.<ref>` and having the pooler accept it is exactly the
//    server-enforced boundary that prevents landing on a different
//    project's backend while presenting that identity.
//
// 2. LIVE identity (assertLiveIdentity): a real query sent over the
//    established connection, `current_database()` plus (opportunistically)
//    `pg_control_system().system_identifier`, cross-checked against the
//    baseline's expectations. This is the "query the connected database for
//    its own identity" step Codex asked for -- it does not merely re-read
//    the env vars we already had, it asks the SERVER to attest to what it
//    is and fails closed if that attestation cannot be obtained or does not
//    match.
//
// Round-5 review finding P1-1: layer 2 and the schema_migrations history
// read used to be two SEPARATE `psql` invocations -- two separate TCP
// connections/sessions, even though built from the same PG* env vars. That
// means the database this gate VERIFIED and the database it READ HISTORY
// FROM were not provably the same database at the protocol level: routing
// or credential drift between the two calls (a misbehaving pooler, a
// mid-run secret rotation, anything that could make two back-to-back
// connections land differently) would defeat the binding entirely, even
// though it would look identical in the logs. Fixed by fetching identity
// AND history in a single SQL statement over a single `psql` connection
// (fetchIdentityAndHistory / IDENTITY_AND_HISTORY_SQL below) -- the
// attestation and the data it gates are now structurally inseparable: they
// are two fields of one JSON object returned by one query.
//
// What this does NOT close, stated explicitly rather than implied: the
// subsequent `supabase db push` (and its `--dry-run` preview) is run by the
// Supabase CLI as a THIRD, separate process/connection, built by the CLI
// itself from the same PG* environment in the same workflow job step --
// same credentials, same host, same moment in time -- but not literally the
// same TCP session this gate just verified. There is no hook into the
// Supabase CLI's connection lifecycle to bind that third connection into
// this one's session; closing that link would require an upstream change to
// the CLI itself. This gate's guarantee is therefore: "the identity this run
// verified and the history it evaluated are provably the same read," not
// "the push that follows is provably the same connection as the gate." The
// residual gap is the push step trusting the same PG* env vars the gate just
// validated, not the gate's own internal consistency.
//
// Pooler vs. direct connection: Supabase's general guidance favors a DIRECT
// connection for migration-style operations. This gate (and, necessarily,
// `supabase db push` itself in this environment) uses the Supavisor POOLER
// instead. That is not a choice made for convenience: Sandra's direct
// connection host (`db.<ref>.supabase.co`) resolves to an AAAA record only
// (confirmed by direct DNS lookup while building this gate) with no A
// record, and GitHub Actions' standard runners have no outbound IPv6 route
// -- a direct connection is categorically unreachable from this CI
// environment, not merely discouraged. The pooler is therefore not a
// mismatch this gate introduced; it is the only network-reachable option
// here, and `supabase db push` itself has necessarily been relying on
// pooler-reachable (or equivalently IPv4-reachable) infrastructure all
// along for this workflow to have ever worked. Conclusion: the direct-vs-
// pooler guidance does not add residual risk beyond what the existing,
// unmodified push mechanism already carries in this specific CI network
// environment -- it is a platform constraint, not a gap this gate could
// close by switching connection modes.
//
// NOTE on db_system_identifier: pg_control_system()'s system_identifier is
// normally unique per physical cluster (assigned once at initdb). While
// verifying this for Sandra's real projects, prod and test returned the
// IDENTICAL system_identifier -- strong evidence that Supabase provisions at
// least some managed projects from a shared template/snapshot rather than a
// fresh initdb per project, so this value is NOT a reliable per-project
// discriminator on Supabase's infrastructure specifically. Sandra's baseline
// therefore leaves db_system_identifier UNPINNED (null) for both real
// targets rather than pinning a value that would not actually distinguish
// prod from test. The mechanism is still wired in (any target CAN pin it,
// and the check enforces it when pinned) in case that changes or is
// confirmed reliable later; project_ref (exactly parsed, never a substring)
// plus the live current_database() check are the enforced signals today.
export function assertDeclaredIdentity(target, expected) {
  const user = process.env.PGUSER ?? "";
  const host = process.env.PGHOST ?? "";
  const database = process.env.PGDATABASE ?? "";

  if (expected.database !== null && database !== expected.database) {
    throw new Error(
      `PGDATABASE is "${database}" but target "${target}" expects "${expected.database}". Refusing.`,
    );
  }

  if (expected.projectRef === null) {
    return "not bound (baseline project_ref is null -- disposable local cluster only)";
  }
  if (typeof expected.projectRef !== "string" || !/^[a-z]{20}$/.test(expected.projectRef)) {
    throw new Error(
      `Baseline project_ref for target "${target}" is not a 20-lowercase-letter Supabase ref or null. Refusing.`,
    );
  }

  const fromUser = PGUSER_REF.exec(user)?.[1] ?? null;
  const fromHost = PGHOST_REF.exec(host)?.[1] ?? null;
  if (fromUser === null && fromHost === null) {
    throw new Error(
      `Cannot parse a Supabase project ref from this connection for target "${target}". ` +
        `PGUSER="${user}" must match postgres.<ref>, or PGHOST="${host}" must match db.<ref>.supabase.co. ` +
        "Refusing: identity is parsed exactly, never inferred from a substring, so that a hostname or " +
        "username that merely contains the ref cannot authorize a push.",
    );
  }
  if (fromUser !== null && fromHost !== null && fromUser !== fromHost) {
    throw new Error(
      `PGUSER declares project ref "${fromUser}" but PGHOST declares "${fromHost}". Refusing.`,
    );
  }
  const declared = fromUser ?? fromHost;
  if (declared !== expected.projectRef) {
    throw new Error(
      `Connection declares project ref "${declared}" but target "${target}" expects "${expected.projectRef}". ` +
        "Refusing: running this gate against one database and pushing to another is the failure mode " +
        "this binding exists to stop.",
    );
  }
  return `declared ref ${declared} (exact match)`;
}

// ONE statement, ONE connection: identity fields and history rows travel
// together in a single JSON payload. See the round-5 note above -- this is
// what makes the identity attestation and the history it gates inseparable.
const IDENTITY_AND_HISTORY_SQL =
  "select json_build_object(" +
  "'database', current_database(), " +
  "'system_identifier', (select system_identifier::text from pg_control_system()), " +
  "'history', coalesce(" +
  "(select json_agg(json_build_object('version', version, 'placeholder', statements is null) order by version) " +
  "from supabase_migrations.schema_migrations), " +
  "'[]'::json)" +
  ")::text;";

// Pure assertion, no I/O: takes an ALREADY-FETCHED observation (from
// fetchIdentityAndHistory below, or a caller-constructed object for unit
// tests) and checks it against the target's expected identity. Separated
// from the fetch so the fetch itself is provably singular (see
// fetchIdentityAndHistory) while this logic stays independently testable.
export function assertLiveIdentity(target, expected, observed) {
  if (expected.database !== null && observed.database !== expected.database) {
    throw new Error(
      `Live connection reports current_database() = "${observed.database}" but target "${target}" ` +
        `expects "${expected.database}". Refusing.`,
    );
  }
  if (expected.systemIdentifier === null) {
    return `live database "${observed.database}", cluster ${observed.system_identifier} (not pinned)`;
  }
  if (String(observed.system_identifier) !== String(expected.systemIdentifier)) {
    throw new Error(
      `Live cluster system_identifier is ${observed.system_identifier} but target "${target}" is ` +
        `pinned to ${expected.systemIdentifier}. Refusing: this connection is not the physical ` +
        "database this target was reviewed against.",
    );
  }
  return `live database "${observed.database}", cluster ${observed.system_identifier} (pinned, matched)`;
}

// The ONLY place this gate queries the live database. One psql
// process, one connection, one statement -- returns both the identity
// fields for assertLiveIdentity and the schema_migrations rows for
// evaluateSafety, read together so neither can silently drift from the
// other between two separate connections.
export function fetchIdentityAndHistory(target, options = {}) {
  let payload;
  try {
    payload = runPsqlSingleJson(IDENTITY_AND_HISTORY_SQL, options);
  } catch (error) {
    throw new Error(`Combined identity+history read failed for target "${target}": ${error.message}`);
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error(
      `Combined identity+history query for target "${target}" did not return a JSON object.`,
    );
  }
  if (!Array.isArray(payload.history)) {
    throw new Error(
      `Combined identity+history query for target "${target}" did not return a "history" array.`,
    );
  }
  const historyRows = payload.history.map((row) => {
    if (row === null || typeof row !== "object") {
      throw new Error(`History row for target "${target}" is not an object: ${JSON.stringify(row)}`);
    }
    return { version: String(row.version), isPlaceholder: row.placeholder === true };
  });
  return {
    observedIdentity: { database: payload.database, system_identifier: payload.system_identifier },
    historyRows,
  };
}

// --- Baseline placeholder acceptance -----------------------------------------
//
// `supabase migration repair` marks a version as reconciled by inserting a
// row with `statements = NULL`. Sandra's production history already has 36
// such rows from repairs that predate this gate (36 of 127 as of 2026-07-30):
// versions 001-035 plus 20260729010000. Refusing to proceed whenever ANY
// placeholder row exists (the Institute script's original behavior) would
// refuse every single push against Sandra forever — the legitimate repair
// workflow can never reach a push. Fixed by scoping the refusal to
// placeholder rows NOT already present in a checked-in, human-reviewed,
// PER-TARGET baseline: pre-existing placeholders are an accepted fact of
// that target's history; a NEW placeholder row (one that appears after this
// baseline was written) is exactly the "history is not a trustworthy
// signal" situation this gate must still catch, so it still refuses on
// those. Per-target (rather than one flat list) also means an acknowledged
// TEST placeholder can never be silently reused to authorize a PRODUCTION
// push and vice versa.
//
// The baseline file is itself a security control, not a convenience default.
// It must fail CLOSED on every way it can go missing, wrong, or be
// substituted out from under the gate: absent file, unreadable file, invalid
// JSON, wrong shape, malformed/duplicate/non-string entries, unknown target,
// or a path that does not point at a real, ordinary, in-repo file. A missing
// or empty-but-should-not-be baseline must never silently degrade to "zero
// accepted placeholders" and let the rest of the gate quietly decide whether
// that happens to matter -- deleting/renaming/corrupting/redirecting this
// file is the single highest-value thing that could disable this guard, and
// it must break loudly, not go green. There is deliberately no auto-repair,
// auto-seed, or auto-create-on-missing behavior here: a guard that
// regenerates its own baseline when it can't find one is the same fail-open
// with extra steps.
//
// Provenance (round 2 of adversarial review found the round-1 fix
// incomplete, round 3 closed it): checking that the baseline path resolves
// to a regular, non-symlinked file INSIDE the repo proves the path sits in
// the tree -- it does NOT prove the FILE CONTENT is the tracked, reviewed
// blob. A hardlink at an in-repo pathname shares its inode with a file
// anywhere else on disk; an untracked or merely-staged-but-uncommitted
// in-repo file passes every filesystem check while never having been
// reviewed; lstat-validate-then-later-readFileSync(path) is two steps over a
// mutable filesystem path with a TOCTOU window between them.
//
// Fixed by never reading the working-tree file: content comes directly out
// of git's object database, addressed by the exact commit (`HEAD:relative/
// path`), via a single `git show` call, bounded by a short timeout (round-4
// finding P2 -- a wedged git process must not hang the CI job's whole
// timeout budget before failing closed against the push).
export function resolveGitTrackedBaselinePath(baselinePath, repoRoot) {
  const resolvedArgPath = resolve(baselinePath);
  const relativePath = relative(repoRoot, resolvedArgPath);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(
      `Baseline path "${resolvedArgPath}" resolves outside the repository root "${repoRoot}". ` +
        "Refusing -- the baseline must be a file committed inside this repo.",
    );
  }
  // git pathspecs always use forward slashes, regardless of platform sep.
  return relativePath.split(sep).join("/");
}

export function readGitTrackedBaseline(baselinePath, repoRoot, options = {}) {
  const gitRelativePath = resolveGitTrackedBaselinePath(baselinePath, repoRoot);
  const timeoutMs = options.timeoutMs ?? GIT_SHOW_TIMEOUT_MS;
  try {
    return execFileSync("git", ["-C", repoRoot, "show", `HEAD:${gitRelativePath}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if (error.signal === "SIGKILL" || error.killed) {
      throw new Error(
        `git show did not complete within ${timeoutMs}ms and was killed while reading baseline path ` +
          `"${gitRelativePath}" from "${repoRoot}". Refusing rather than hanging: a wedged git process ` +
          "must fail closed, not delay incident visibility until the CI job's outer timeout.",
      );
    }
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `Baseline path "${gitRelativePath}" could not be read from git HEAD in "${repoRoot}". It must ` +
        "be committed (not untracked, not merely staged) at the current HEAD for this gate to trust " +
        `it as reviewed. ${stderr ? `git said: ${stderr}` : `(${error.message})`}`,
    );
  }
}

export function loadBaseline(baselinePath, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const target = options.target;
  if (!target) {
    throw new Error(
      "loadBaseline requires a target (e.g. \"sandra-production\"). It selects which acknowledged " +
        "placeholder baseline AND which expected project identity applies, so a gate run against TEST " +
        "cannot be reused to authorize a PRODUCTION push.",
    );
  }
  const text = readGitTrackedBaseline(baselinePath, repoRoot, options);

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Baseline at "${baselinePath}" (read from git HEAD) is not valid JSON: ${error.message}`);
  }

  if (raw === null || typeof raw !== "object" || typeof raw.targets !== "object" || raw.targets === null) {
    throw new Error(
      `Baseline file "${baselinePath}" must be a JSON object with a "targets" object keyed by target name.`,
    );
  }
  if (!Object.hasOwn(raw.targets, target)) {
    throw new Error(
      `No baseline entry for target "${target}" in "${baselinePath}". Known targets: ` +
        `${Object.keys(raw.targets).join(", ") || "(none)"}. Refusing: an unrecognized target is ` +
        "either a typo or an unreviewed new database.",
    );
  }
  const entry = raw.targets[target];
  if (entry === null || typeof entry !== "object") {
    throw new Error(`Baseline entry for target "${target}" is not an object.`);
  }
  for (const key of ["project_ref", "database", "db_system_identifier", "placeholder_versions"]) {
    if (!Object.hasOwn(entry, key)) {
      throw new Error(
        `Baseline entry for target "${target}" has no "${key}" key. Every identity key must be ` +
          "present explicitly (use null to opt out deliberately) -- an absent key would be an " +
          "accidental opt-out.",
      );
    }
  }
  if (
    entry.project_ref !== null &&
    typeof entry.project_ref !== "string"
  ) {
    throw new Error(`Baseline entry for target "${target}" has a non-string, non-null "project_ref".`);
  }
  if (entry.database !== null && typeof entry.database !== "string") {
    throw new Error(`Baseline entry for target "${target}" has a non-string, non-null "database".`);
  }
  if (entry.db_system_identifier !== null && typeof entry.db_system_identifier !== "string") {
    throw new Error(
      `Baseline entry for target "${target}" has a non-string, non-null "db_system_identifier".`,
    );
  }
  if (!Array.isArray(entry.placeholder_versions)) {
    throw new Error(
      `Baseline entry for target "${target}" has a non-array "placeholder_versions" ` +
        `(got ${typeof entry.placeholder_versions}). Use [] when the target legitimately has no ` +
        "placeholder rows -- not a missing key.",
    );
  }

  // Every entry must be a STRING that looks like a version. Numbers are
  // rejected outright rather than coerced -- silent coercion in an allowlist
  // is how `"001"` (string) and `1` (number) end up meaning the same thing
  // to the guard but different things to a human reviewing the file's diff.
  const normalized = new Set();
  const seenBy = new Map(); // identityKey -> the first raw entry that produced it
  for (const version of entry.placeholder_versions) {
    if (typeof version !== "string") {
      throw new Error(
        `Baseline entry for target "${target}" contains a non-string version: ${JSON.stringify(version)} ` +
          `(${typeof version}). Every entry must be a version string, e.g. "001" or "20260729010000" -- ` +
          "numbers are not accepted, even if they look like a valid version.",
      );
    }
    let key;
    try {
      key = identityKey(version);
    } catch (error) {
      throw new Error(
        `Baseline entry for target "${target}" contains a malformed version ${JSON.stringify(version)}: ${error.message}`,
      );
    }
    // Duplicate detection is on normalized identity, not raw string equality,
    // so both a literal repeat ("001" twice) and a differently-formatted
    // repeat ("001" and "1") are caught -- either shape is an unreviewed
    // widening of the control that a reviewer skimming the file could miss.
    if (seenBy.has(key)) {
      throw new Error(
        `Baseline entry for target "${target}" contains duplicate entries for version "${version}": ` +
          `${JSON.stringify(seenBy.get(key))} and ${JSON.stringify(version)} both normalize to the same ` +
          "version. Refusing -- an unvalidated control file is how a widened baseline slips past review.",
      );
    }
    seenBy.set(key, version);
    normalized.add(key);
  }
  return {
    projectRef: entry.project_ref,
    database: entry.database,
    systemIdentifier: entry.db_system_identifier,
    acceptedPlaceholderVersions: normalized,
  };
}

// --- Core decision (pure, unit-testable without a database) -----------------

export function evaluateSafety(historyRows, local, options = {}) {
  const rawAccepted = options.acceptedPlaceholderVersions ?? new Set();
  // Normalize defensively here (not just in loadBaseline) so this function is
  // correct regardless of whether a caller already normalized its input --
  // callers passing raw baseline strings like "001" must still match a
  // history row recorded as "1".
  const acceptedPlaceholderVersions = new Set(
    [...rawAccepted].map((v) => identityKey(String(v))),
  );

  // Defect fixed: an empty (or wrong-path) local migrations directory used to
  // be silently treated as "zero pending, therefore OK" — a typo'd
  // --migrations-dir or an empty checkout would produce a green gate right
  // before a production push. A repo with any applied history must have at
  // least one local migration file; zero is always wrong.
  if (local.length === 0) {
    return { ok: false, reason: "NO_LOCAL_MIGRATIONS" };
  }

  if (historyRows.length === 0) {
    return { ok: false, reason: "EMPTY_HISTORY" };
  }

  const unknownPlaceholders = historyRows.filter(
    (row) => row.isPlaceholder && !acceptedPlaceholderVersions.has(identityKey(row.version)),
  );
  if (unknownPlaceholders.length > 0) {
    return { ok: false, reason: "UNKNOWN_PLACEHOLDER_HISTORY", unknownPlaceholders };
  }

  // Identity: normalize both sides through the same BigInt-derived key so
  // "001" in a filename and "1" in history (or any other zero-padding
  // mismatch) are recognized as the same already-applied version, instead of
  // the local file being misclassified as newly pending.
  const appliedIdentityKeys = new Set(historyRows.map((row) => identityKey(row.version)));
  const pending = local.filter((entry) => !appliedIdentityKeys.has(identityKey(entry.version)));

  // Per-namespace high-water mark: computed only from non-placeholder rows,
  // since a placeholder row's `statements` (and therefore whether it truly
  // represents content at or after that version) is unknown by definition.
  const maxAppliedByNamespace = new Map();
  for (const row of historyRows) {
    if (row.isPlaceholder) continue;
    const ns = namespaceOf(row.version);
    const value = numericValue(row.version);
    const current = maxAppliedByNamespace.get(ns);
    if (current === undefined || value > current) {
      maxAppliedByNamespace.set(ns, value);
    }
  }

  const unsafePending = [];
  const unknownNamespacePending = [];
  for (const entry of pending) {
    const ns = namespaceOf(entry.version);
    const maxApplied = maxAppliedByNamespace.get(ns);
    if (maxApplied === undefined) {
      // A version-string width never seen before in (non-placeholder)
      // history. Sandra has exactly two known widths (3-digit legacy and
      // 14-digit timestamp) and both already have history. A third width
      // showing up is unrecognized shape, not a proven-safe new namespace —
      // fail closed rather than silently accept it.
      unknownNamespacePending.push(entry);
      continue;
    }
    if (numericValue(entry.version) < maxApplied) {
      unsafePending.push({ ...entry, namespace: ns, maxApplied });
    }
  }

  if (unknownNamespacePending.length > 0) {
    return { ok: false, reason: "UNKNOWN_VERSION_NAMESPACE", unknownNamespacePending };
  }

  if (unsafePending.length > 0) {
    return { ok: false, reason: "OUT_OF_ORDER_PENDING", unsafePending };
  }

  return { ok: true, pending };
}

// --- CLI entry point ----------------------------------------------------------

function printRefusal(result) {
  console.error("");
  switch (result.reason) {
    case "NO_LOCAL_MIGRATIONS":
      console.error(
        "REFUSING: the canonical migrations directory has zero .sql files, but remote history is " +
          "non-empty. This is either a broken checkout or a repo laid out unexpectedly — not proof " +
          "that nothing is pending.",
      );
      break;
    case "EMPTY_HISTORY":
      console.error("REFUSING: schema_migrations returned zero rows. Refusing to guess a baseline.");
      break;
    case "UNKNOWN_PLACEHOLDER_HISTORY":
      console.error(
        "REFUSING: schema_migrations contains placeholder row(s) with NULL statements that are " +
          "NOT in the accepted baseline (scripts/migration-safety-baseline.json) for this target:",
      );
      for (const row of result.unknownPlaceholders) {
        console.error(`  - ${row.version}`);
      }
      console.error("");
      console.error(
        "A new placeholder row means `supabase migration repair` ran since the baseline was " +
          "written and history is not a trustworthy signal at that version. A human must confirm " +
          "the repair was intentional (reading live schema state, not just history) and add the " +
          "version to the baseline file's entry for this target in the same change before this gate " +
          "will accept it.",
      );
      break;
    case "UNKNOWN_VERSION_NAMESPACE":
      console.error(
        "REFUSING: the following pending migration(s) use a version-string width never seen in " +
          "applied history (expected 3-digit legacy or 14-digit timestamp versions):",
      );
      for (const entry of result.unknownNamespacePending) {
        console.error(`  - ${entry.file} (version ${entry.version})`);
      }
      break;
    case "OUT_OF_ORDER_PENDING":
      console.error(
        "REFUSING: the following pending migration(s) are OLDER than the newest applied version " +
          "in their own version scheme. This is exactly the out-of-order re-apply pattern that " +
          "reverted 6 hardened functions on BMH Institute prod on 2026-07-30. `--include-all` " +
          "cannot tell whether a later migration already supersedes this file's content:",
      );
      for (const entry of result.unsafePending) {
        console.error(
          `  - ${entry.file} (version ${entry.version} < ${entry.maxApplied.toString()} within its own namespace)`,
        );
      }
      console.error("");
      console.error(
        "Before applying any of these, a human must confirm (by reading the live function/table " +
          "definitions, not just history) whether a later migration already changed the same " +
          "objects. If it does, that later migration is authoritative and this file must NOT be re-run.",
      );
      break;
    default:
      console.error(`REFUSING: unrecognized failure reason "${result.reason}".`);
  }
}

export function main() {
  const args = parseArguments(process.argv.slice(2));
  // Overridable only for tests, which point the ENTIRE resolution (baseline
  // git reads AND the canonical migrations directory, both derived from this
  // one value) at a disposable scratch git repo, to prove target/identity/
  // canonical-path behavior without touching this repo's own history or its
  // real supabase/migrations. There is deliberately no separate override for
  // the migrations directory alone (see canonicalMigrationsDir above) --
  // that is exactly the P1-1 gap this round closes.
  const repoRoot = args["repo-root"] ? resolve(args["repo-root"]) : REPO_ROOT;
  // The default baseline path is resolved against repoRoot, NOT process.cwd()
  // -- otherwise a --repo-root override would redirect the migrations
  // directory but silently leave the default baseline pointed at whatever
  // directory the process happened to be launched from, defeating the
  // "entire resolution moves together" guarantee above. An explicit
  // --baseline is still resolved as a normal path (cwd-relative if not
  // absolute), matching how --repo-root itself is resolved.
  const baselinePath = args["baseline"] ? resolve(args["baseline"]) : resolve(repoRoot, DEFAULT_BASELINE_PATH);
  const target = args["target"];

  console.log("== Migration safety gate ==");
  console.log(`Target: ${target ?? "(missing)"}`);
  console.log(`Baseline file: ${baselinePath} (read from git HEAD in ${repoRoot})`);

  if (!target) {
    console.error("");
    console.error(
      "REFUSING: --target=<label> is required. It selects which acknowledged placeholder baseline " +
        "AND which expected project identity applies, so a gate run against TEST cannot be reused to " +
        "authorize a PRODUCTION push.",
    );
    process.exitCode = 1;
    return;
  }
  if (args["migrations-dir"] !== undefined) {
    console.error("");
    console.error(
      "REFUSING: --migrations-dir is not accepted. The gate always inspects " +
        `${canonicalMigrationsDir(repoRoot)} to guarantee it matches what \`supabase db push\` reads. ` +
        "A caller-controlled migrations directory is exactly the gap that made the gate decorative " +
        "(round-4 review finding P1-1).",
    );
    process.exitCode = 1;
    return;
  }

  const migrationsDir = canonicalMigrationsDir(repoRoot);
  console.log(`Migrations directory (canonical, not overridable): ${migrationsDir}`);

  let baseline;
  let declaredIdentity;
  let liveIdentity;
  let historyRows;
  let local;
  try {
    baseline = loadBaseline(baselinePath, { repoRoot, target });

    // Identity MUST be asserted before any history read is trusted (round-4
    // review instruction, verbatim). Round 5 additionally requires identity
    // and history to come from the SAME connection/session, so declared
    // (env-derived, exact-parsed, no I/O) is checked first, then ONE live
    // query fetches both the live identity fields AND the history rows
    // together (fetchIdentityAndHistory) -- there is no second connection
    // for history to drift from the one identity was verified against.
    declaredIdentity = assertDeclaredIdentity(target, baseline);
    const { observedIdentity, historyRows: fetchedHistoryRows } = fetchIdentityAndHistory(target);
    liveIdentity = assertLiveIdentity(target, baseline, observedIdentity);
    historyRows = fetchedHistoryRows;

    assertNoSymlinkInMigrationsPath(migrationsDir, repoRoot);
    local = loadLocalMigrationVersions(migrationsDir);
  } catch (error) {
    console.error("");
    console.error(`REFUSING: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Declared connection identity: ${declaredIdentity}`);
  console.log(`Live connection identity: ${liveIdentity}`);

  const result = evaluateSafety(historyRows, local, {
    acceptedPlaceholderVersions: baseline.acceptedPlaceholderVersions,
  });

  if (!result.ok) {
    printRefusal(result);
    process.exitCode = 1;
    return;
  }

  console.log(`Locally pending (not in schema_migrations, by any accepted formatting): ${result.pending.length}`);
  console.log("");
  console.log(
    "OK: connection identity matches the target, no unknown placeholder rows, and every pending " +
      "migration is newer than history's high-water mark within its own version scheme.",
  );
  if (result.pending.length > 0) {
    console.log("Pending migrations (safe to include in a reviewed dry-run):");
    for (const entry of result.pending) {
      console.log(`  - ${entry.file}`);
    }
  }
  console.log("");
  console.log(
    "This gate does not replace review. Run `supabase db push --include-all --dry-run` next and " +
      "confirm the printed list matches exactly what you expect before running it for real.",
  );
}

// This file is a LIBRARY ONLY -- it exports main() but never calls it.
//
// Round 1 tried to auto-invoke main() here, guarded by an "is this file
// being run directly, or merely imported?" check comparing
// `fileURLToPath(import.meta.url)` against `resolve(process.argv[1])`. That
// check broke twice: first silently, when the repo path contained a space
// (the comparison was false, main() never ran, process exited 0 with no gate
// output); then round-2 review found that invoking this file THROUGH A
// SYMLINK breaks the same comparison the same way (the module's real path
// differs from the symlink argv[1] resolves to), for the same silent
// fail-open result.
//
// Rather than patch that comparison a third time, there is no comparison:
// this module never decides whether to run itself. scripts/check-migration-safety-cli.mjs
// is the actual entrypoint -- it unconditionally imports main from here and
// calls it, no matter how it itself was invoked (directly, via a symlink, via
// npm script, etc). Import this file for its exported functions (as the unit
// tests do) without ever triggering main() as a side effect of the import.
