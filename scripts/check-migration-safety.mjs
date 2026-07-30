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
// the Institute script (BMH Institute PR #155). That script was adversarially
// reviewed and blocked with defects that would either fail OPEN (silently
// pass when it should refuse) or fail CLOSED PERMANENTLY (refuse forever,
// even for legitimate pushes). Both failure shapes are unacceptable against
// Sandra's production database. This file's design deliberately closes each
// of those gaps — see the block comment above each check below for which gap
// it closes.
//
// This script only inspects and reports. It never runs `supabase db push`,
// `supabase migration repair`, or any writing SQL itself.
//
// Usage:
//   PGHOST=... PGPORT=... PGDATABASE=... PGUSER=... PGPASSWORD=... [PGSSLMODE=require] \
//     node scripts/check-migration-safety.mjs \
//       [--migrations-dir=supabase/migrations] \
//       [--baseline=scripts/migration-safety-baseline.json]
//
// Exit code 0: safe to proceed to a `db push --include-all --dry-run` review.
// Exit code 1: refuse. Print the reason and let a human resolve it.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIR = "supabase/migrations";
const DEFAULT_BASELINE_PATH = "scripts/migration-safety-baseline.json";
// This file lives at <repo>/scripts/check-migration-safety.mjs, so its
// grandparent directory is the repo root. Used to enforce that a baseline
// path can never resolve outside the repository (see loadBaseline).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Overall wall-clock budget for the psql round trip. A blackholed network
// (dropped packets, a security-group change, a misconfigured pooler) must
// fail this gate closed within a bounded time, not hang the CI job forever
// while the caller assumes the gate is "still checking." Also set as
// PGCONNECT_TIMEOUT (seconds) so the TCP/auth handshake itself times out
// before we fall back to this outer kill.
const PSQL_TIMEOUT_MS = 20_000;

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

export function runPsqlCsv(sql, options = {}) {
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
  try {
    const output = execFileSync(
      "psql",
      ["--csv", "--quiet", "--tuples-only", "--set", "ON_ERROR_STOP=1", "-c", sql],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        env: {
          ...process.env,
          // Client-side connect timeout, in seconds. Bounds the TCP/TLS/auth
          // handshake specifically, ahead of the coarser process-level kill
          // above (which also bounds query execution once connected).
          PGCONNECT_TIMEOUT: String(connectTimeoutSeconds),
        },
      },
    );
    const lines = output.trim().split("\n").filter((line) => line.length > 0);
    return lines.map((line) => line.split(","));
  } catch (error) {
    if (error.signal === "SIGKILL" || error.killed) {
      throw new Error(
        `psql did not complete within ${timeoutMs}ms and was killed. Treating this as a ` +
          "connection failure: refusing rather than guessing the database is reachable.",
      );
    }
    throw error;
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

// --- Baseline placeholder acceptance -----------------------------------------
//
// `supabase migration repair` marks a version as reconciled by inserting a
// row with `statements = NULL`. Sandra's production history already has 36
// such rows from repairs that predate this gate (36 of 127 as of 2026-07-30):
// versions 001-035 plus 20260729010000. Refusing to proceed whenever ANY
// placeholder row exists (the Institute script's behavior) would refuse
// every single push against Sandra forever — the legitimate repair workflow
// can never reach a push. Fixed by scoping the refusal to placeholder rows
// NOT already present in a checked-in, human-reviewed baseline: pre-existing
// placeholders are an accepted fact of this database's history; a NEW
// placeholder row (one that appears after this baseline was written) is
// exactly the "history is not a trustworthy signal" situation this gate must
// still catch, so it still refuses on those.
//
// The baseline file is itself a security control, not a convenience default.
// It must fail CLOSED on every way it can go missing, wrong, or be
// substituted out from under the gate: absent file, unreadable file, invalid
// JSON, wrong shape, malformed/duplicate/non-string entries, or a path that
// does not point at a real, ordinary, in-repo file. A missing or
// empty-but-should-not-be baseline must never silently degrade to "zero
// accepted placeholders" and let the rest of the gate quietly decide whether
// that happens to matter -- deleting/renaming/corrupting/redirecting this
// file is the single highest-value thing that could disable this guard, and
// it must break loudly, not go green. There is deliberately no auto-repair,
// auto-seed, or auto-create-on-missing behavior here: a guard that
// regenerates its own baseline when it can't find one is the same fail-open
// with extra steps.
//
// Path-safety (symlinks / escaping the repo): the baseline's entire security
// value rests on "you can only widen it via a commit someone reviewed." A
// symlink at the baseline path breaks that -- the file tracked in the repo
// can look innocuous while the bytes actually read come from anywhere else
// (another file on disk, a FIFO, /dev/stdin, a path an automated loop
// controls). `lstat` (which does NOT follow the final symlink, unlike
// `stat`/`existsSync`) is used to inspect the path's own type before ever
// reading it, and refuses anything other than a plain regular file. Then the
// fully-resolved real path (with ALL symlinks in ancestor directories
// resolved too, via `realpath`) must still sit inside the repo root -- this
// catches both `..`-style traversal and a symlinked ancestor directory
// silently redirecting an otherwise-innocent-looking in-repo path.
function assertSafeBaselinePath(baselinePath) {
  const resolvedArgPath = resolve(baselinePath);

  let linkStat;
  try {
    linkStat = lstatSync(resolvedArgPath);
  } catch (error) {
    throw new Error(
      `Baseline file "${resolvedArgPath}" does not exist. A missing baseline must not be treated as ` +
        '"zero accepted placeholders" -- restore scripts/migration-safety-baseline.json (or pass ' +
        `--baseline pointing at the real file) before this gate will run. (${error.message})`,
    );
  }

  if (linkStat.isSymbolicLink()) {
    throw new Error(
      `Baseline file "${resolvedArgPath}" is a symlink. Refusing -- the baseline must be a real, ` +
        "reviewed file committed to the repo, not something that can be redirected at runtime " +
        "(including to /dev/stdin, a process substitution, or a path outside version control).",
    );
  }
  if (!linkStat.isFile()) {
    const kind = linkStat.isDirectory()
      ? "a directory"
      : linkStat.isFIFO()
        ? "a FIFO"
        : linkStat.isCharacterDevice() || linkStat.isBlockDevice()
          ? "a device"
          : linkStat.isSocket()
            ? "a socket"
            : "not a regular file";
    throw new Error(`Baseline file "${resolvedArgPath}" is ${kind}, not a regular file. Refusing.`);
  }

  // Now safe to fully resolve (the final component is confirmed to be a
  // plain file, not a symlink) -- this still resolves any symlinked
  // ancestor directory, which the checks above cannot see.
  const realPath = realpathSync(resolvedArgPath);
  const realRoot = realpathSync(REPO_ROOT);
  const relativeToRoot = relative(realRoot, realPath);
  if (relativeToRoot === "" || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new Error(
      `Baseline file "${resolvedArgPath}" resolves to "${realPath}", which is outside the ` +
        `repository root "${realRoot}". Refusing -- the baseline must be a file committed inside this repo.`,
    );
  }

  return realPath;
}

export function loadBaseline(baselinePath) {
  const safePath = assertSafeBaselinePath(baselinePath);

  let text;
  try {
    text = readFileSync(safePath, "utf8");
  } catch (error) {
    throw new Error(`Baseline file "${safePath}" exists but could not be read: ${error.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Baseline file "${safePath}" is not valid JSON: ${error.message}`);
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Baseline file "${safePath}" must be a JSON object with an "acceptedPlaceholderVersions" ` +
        `array, got ${Array.isArray(raw) ? "an array" : typeof raw}.`,
    );
  }
  if (!Array.isArray(raw.acceptedPlaceholderVersions)) {
    throw new Error(
      `Baseline file "${safePath}" is missing a valid "acceptedPlaceholderVersions" array ` +
        `(got ${typeof raw.acceptedPlaceholderVersions}). An intentionally empty baseline must still ` +
        'be an explicit "acceptedPlaceholderVersions": [] -- not a missing key.',
    );
  }

  // Every entry must be a STRING that looks like a version. Numbers are
  // rejected outright rather than coerced -- silent coercion in an allowlist
  // is how `"001"` (string) and `1` (number) end up meaning the same thing
  // to the guard but different things to a human reviewing the file's diff.
  const normalized = new Set();
  const seenBy = new Map(); // identityKey -> the first raw entry that produced it
  for (const entry of raw.acceptedPlaceholderVersions) {
    if (typeof entry !== "string") {
      throw new Error(
        `Baseline file "${safePath}" contains a non-string entry: ${JSON.stringify(entry)} ` +
          `(${typeof entry}). Every entry must be a version string, e.g. "001" or "20260729010000" -- ` +
          "numbers are not accepted, even if they look like a valid version.",
      );
    }
    let key;
    try {
      key = identityKey(entry);
    } catch (error) {
      throw new Error(
        `Baseline file "${safePath}" contains a malformed version entry ${JSON.stringify(entry)}: ${error.message}`,
      );
    }
    // Duplicate detection is on normalized identity, not raw string equality,
    // so both a literal repeat ("001" twice) and a differently-formatted
    // repeat ("001" and "1") are caught -- either shape is an unreviewed
    // widening of the control that a reviewer skimming the file could miss.
    if (seenBy.has(key)) {
      throw new Error(
        `Baseline file "${safePath}" contains duplicate entries for version "${entry}": ` +
          `${JSON.stringify(seenBy.get(key))} and ${JSON.stringify(entry)} both normalize to the same ` +
          "version. Refusing -- an unvalidated control file is how a widened baseline slips past review.",
      );
    }
    seenBy.set(key, entry);
    normalized.add(key);
  }
  return { acceptedPlaceholderVersions: normalized };
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
        "REFUSING: the local migrations directory has zero .sql files, but remote history is " +
          "non-empty. This is either a wrong/empty --migrations-dir or a broken checkout — not " +
          "proof that nothing is pending.",
      );
      break;
    case "EMPTY_HISTORY":
      console.error("REFUSING: schema_migrations returned zero rows. Refusing to guess a baseline.");
      break;
    case "UNKNOWN_PLACEHOLDER_HISTORY":
      console.error(
        "REFUSING: schema_migrations contains placeholder row(s) with NULL statements that are " +
          "NOT in the accepted baseline (scripts/migration-safety-baseline.json):",
      );
      for (const row of result.unknownPlaceholders) {
        console.error(`  - ${row.version}`);
      }
      console.error("");
      console.error(
        "A new placeholder row means `supabase migration repair` ran since the baseline was " +
          "written and history is not a trustworthy signal at that version. A human must confirm " +
          "the repair was intentional (reading live schema state, not just history) and add the " +
          "version to the baseline file in the same change before this gate will accept it.",
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

function main() {
  const args = parseArguments(process.argv.slice(2));
  const migrationsDir = resolve(args["migrations-dir"] ?? DEFAULT_MIGRATIONS_DIR);
  const baselinePath = resolve(args["baseline"] ?? DEFAULT_BASELINE_PATH);

  console.log("== Migration safety gate ==");
  console.log(`Migrations directory: ${migrationsDir}`);
  console.log(`Baseline file: ${baselinePath}`);

  let historyRows;
  let local;
  let baseline;
  try {
    const historyCsv = runPsqlCsv(
      "select version, (statements is null) as is_placeholder " +
        "from supabase_migrations.schema_migrations order by version",
    );
    historyRows = historyCsv.map(([version, isPlaceholder]) => ({
      version,
      isPlaceholder: isPlaceholder === "t",
    }));
    local = loadLocalMigrationVersions(migrationsDir);
    baseline = loadBaseline(baselinePath);
  } catch (error) {
    console.error("");
    console.error(`REFUSING: ${error.message}`);
    process.exitCode = 1;
    return;
  }

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
    "OK: no unknown placeholder rows, and every pending migration is newer than history's " +
      "high-water mark within its own version scheme.",
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

// Note: comparing import.meta.url to `file://${process.argv[1]}` as a raw
// string breaks whenever the path contains characters URL-encodes (spaces,
// etc.) -- this repo is checked out under a directory with a space in it
// ("BMH apps"), which silently made that comparison false and skipped main()
// entirely (exit 0, no output, no gate ever ran). Comparing decoded
// filesystem paths avoids that class of bug.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
