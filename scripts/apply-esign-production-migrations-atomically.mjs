#!/usr/bin/env node

// Manual, fail-closed production packet for the Sandra eSign foundation.
//
// The standard Supabase CLI commits one migration file at a time. That is
// unsafe for this release because 20260829194500 and Switchboard's already
// applied 20260830092331 migration each replace the same webhook-consumer
// checks from different historical baselines. Production must never expose a
// committed state between the eSign foundation and the final 100000 union.
//
// This packet therefore:
//   1. verifies the reviewed local file hashes and CLI-compatible statement
//      arrays;
//   2. records a secret-free, mode-0600 rollback/preflight snapshot;
//   3. on an explicitly armed execution, repeats every preflight under one
//      transaction, an advisory deployment lock, Switchboard's DNC barrier,
//      and an ACCESS EXCLUSIVE consumer-table lock;
//   4. executes 194500, 080000, 100000, and 074814 and inserts the exact
//      Supabase schema_migrations rows in that same transaction.
//
// This file is never invoked by application code or ordinary CI. It does not
// support TEST and cannot repair migration history.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_PLAN_PATH = resolve(SCRIPT_DIR, "esign-atomic-production-plan.json");
const EXPECTED_DATABASE = "postgres";
const EXECUTION_ARM = "APPLY_REVIEWED_ESIGN_PACKET";
const PRODUCTION_URL_ENV = "SANDRA_PRODUCTION_DATABASE_URL";
const REQUIRED_SWITCHBOARD_TYPES = Object.freeze([
  "lead",
  "provider",
  "jitter_writeback",
  "closer_practice",
  "bmh_institute_course",
  "esign_provider",
  "switchboard_contact_preference",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isIdentifierRune(character) {
  return /[\p{L}\p{N}_$]/u.test(character);
}

function beginAtomicAt(data) {
  const match = /ATOMIC$/i.exec(data);
  if (!match) return false;
  const atomicOffset = match.index;
  if (atomicOffset > 0 && isIdentifierRune(data[atomicOffset - 1])) return false;
  const prefix = data.slice(0, atomicOffset).trimEnd();
  const beginOffset = prefix.length - "BEGIN".length;
  if (beginOffset < 0 || prefix.slice(beginOffset).toUpperCase() !== "BEGIN") return false;
  return beginOffset === 0 || !isIdentifierRune(prefix[beginOffset - 1]);
}

// Faithful JavaScript port of Supabase CLI 2.109.1's pkg/parser SplitAndTrim.
// It intentionally preserves comments/whitespace inside each statement and
// suppresses semicolon splitting inside quotes, comments, dollar quotes,
// parentheses, and BEGIN ATOMIC bodies. Runtime/rehearsal tests compare its
// output directly with statement arrays written by that CLI version.
export function splitSupabaseStatements(sql) {
  const statements = [];
  let start = 0;
  const stack = [{ kind: "ready" }];
  const state = () => stack[stack.length - 1];

  function emit(end) {
    const value = sql.slice(start, end).replace(/;+$/u, "").trim();
    if (value.length > 0) statements.push(value);
    start = end;
  }

  for (let index = 0; index < sql.length; index += 1) {
    const current = state();
    const char = sql[index];
    const next = sql[index + 1];

    if (current.kind === "line-comment") {
      if (char === "\n") stack.pop();
      continue;
    }
    if (current.kind === "block-comment") {
      if (char === "/" && next === "*") {
        current.depth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        current.depth -= 1;
        index += 1;
        if (current.depth === 0) stack.pop();
      }
      continue;
    }
    if (current.kind === "quote") {
      if (char === current.delimiter) {
        if (next === current.delimiter) index += 1;
        else stack.pop();
      }
      continue;
    }
    if (current.kind === "dollar") {
      if (sql.startsWith(current.delimiter, index)) {
        index += current.delimiter.length - 1;
        stack.pop();
      }
      continue;
    }
    if (current.kind === "atomic") {
      if (char === "-") {
        if (next === "-") {
          stack.push({ kind: "line-comment" });
          index += 1;
        }
        continue;
      }
      if (char === "/") {
        if (next === "*") {
          stack.push({ kind: "block-comment", depth: 1 });
          index += 1;
        }
        continue;
      }
      if (char === "'" || char === '"') {
        stack.push({ kind: "quote", delimiter: char });
        continue;
      }
      if (char === "$") {
        const match = /^\$[\p{L}\p{N}_]*\$/u.exec(sql.slice(index));
        if (match) {
          stack.push({ kind: "dollar", delimiter: match[0] });
          index += match[0].length - 1;
        }
        continue;
      }
      if (char === "(") {
        stack.push({ kind: "atomic", delimiter: ")" });
        continue;
      }
      if (current.delimiter === ")" && char === ")") {
        stack.pop();
        continue;
      }
      if (current.delimiter === "END" && sql.slice(0, index + 1).toUpperCase().endsWith("END")) {
        stack.pop();
        continue;
      }
      if ((char === "c" || char === "C") && beginAtomicAt(sql.slice(start, index + 1))) {
        stack.push({ kind: "atomic", delimiter: "END" });
      }
      continue;
    }

    if (char === "-" && next === "-") {
      stack.push({ kind: "line-comment" });
      index += 1;
    } else if (char === "/" && next === "*") {
      stack.push({ kind: "block-comment", depth: 1 });
      index += 1;
    } else if (char === "'" || char === '"') {
      stack.push({ kind: "quote", delimiter: char });
    } else if (char === "$") {
      const match = /^\$[\p{L}\p{N}_]*\$/u.exec(sql.slice(index));
      if (match) {
        stack.push({ kind: "dollar", delimiter: match[0] });
        index += match[0].length - 1;
      }
    } else if (char === "\\") {
      index += 1;
    } else if (char === "(") {
      stack.push({ kind: "atomic", delimiter: ")" });
    } else if (char === ";") {
      emit(index + 1);
    } else if ((char === "c" || char === "C") && beginAtomicAt(sql.slice(start, index + 1))) {
      stack.push({ kind: "atomic", delimiter: "END" });
    }
  }
  emit(sql.length);
  return statements;
}

function parseArguments(argv) {
  const result = {};
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`Invalid argument ${argument}; use --name=value.`);
    result[match[1]] = match[2];
  }
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadReviewedPlan(planPath = DEFAULT_PLAN_PATH, options = {}) {
  const plan = readJson(planPath);
  if (plan.format !== 1 || plan.supabaseCliVersion !== "2.109.1") {
    throw new Error("Unsupported eSign atomic plan format or Supabase CLI version.");
  }
  if (!/^[a-z]{20}$/u.test(plan.productionProjectRef)) {
    throw new Error("The production project ref in the reviewed plan is invalid.");
  }
  const entries = [plan.switchboard, ...plan.migrations];
  for (const entry of entries) {
    if (!/^\d{14}$/u.test(entry.version) || !/^[a-z0-9_]+$/u.test(entry.name)) {
      throw new Error(`Invalid reviewed migration identity ${entry.version ?? "unknown"}.`);
    }
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) {
      throw new Error(`Migration ${entry.version} does not have a reviewed SHA-256.`);
    }
    const reviewedPath =
      entry.version === plan.switchboard.version && options.switchboardPath
        ? resolve(options.switchboardPath)
        : resolve(REPO_ROOT, entry.path);
    const absolutePath = reviewedPath;
    if (!options.switchboardPath && !absolutePath.startsWith(`${REPO_ROOT}/`)) {
      throw new Error(`Migration ${entry.version} resolves outside the repository.`);
    }
    const sql = readFileSync(absolutePath, "utf8");
    const actualHash = sha256(sql);
    if (actualHash !== entry.sha256) {
      throw new Error(`Migration ${entry.version} SHA-256 does not match the reviewed plan.`);
    }
    entry.absolutePath = absolutePath;
    entry.sql = sql;
    entry.statements = splitSupabaseStatements(sql);
    if (entry.statements.length === 0) throw new Error(`Migration ${entry.version} is empty.`);
    if (sha256(JSON.stringify(entry.statements)) !== entry.statementsSha256) {
      throw new Error(`Migration ${entry.version} statement-array SHA-256 does not match the reviewed plan.`);
    }
  }
  const versions = plan.migrations.map((entry) => entry.version);
  if (
    versions.join(",") !==
    "20260829194500,20260830080000,20260830100000,20260902074814"
  ) {
    throw new Error("The reviewed plan does not contain the exact eSign migration order.");
  }
  return plan;
}

function migrationBodyStatements(entry) {
  const statements = [...entry.statements];
  if (!/(?:^|\n)\s*begin\s*$/iu.test(statements[0])) {
    throw new Error(`Migration ${entry.version} does not begin with an explicit transaction.`);
  }
  if (!/^commit\s*$/iu.test(statements.at(-1))) {
    throw new Error(`Migration ${entry.version} does not end with an explicit commit.`);
  }
  return statements.slice(1, -1);
}

function declaredProjectRef(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const fromUser = /^postgres\.([a-z]{20})$/u.exec(decodeURIComponent(parsed.username))?.[1];
  const fromHost = /^db\.([a-z]{20})\.supabase\.co$/u.exec(parsed.hostname)?.[1];
  if (!fromUser && !fromHost) throw new Error("Cannot derive an exact Supabase project ref.");
  if (fromUser && fromHost && fromUser !== fromHost) {
    throw new Error("Database URL host and user declare different project refs.");
  }
  return fromUser ?? fromHost;
}

async function readObservation(client, plan) {
  const versions = [plan.switchboard.version, ...plan.migrations.map((entry) => entry.version)];
  const identity = await client.query(
    `select current_database() database,
            (select system_identifier::text from pg_control_system()) system_identifier`,
  );
  const history = await client.query(
    `select version,name,statements
       from supabase_migrations.schema_migrations
      where version=any($1::text[]) order by version`,
    [versions],
  );
  const counts = await client.query(
    `select
       (select count(*)::int from public.webhook_consumers
         where consumer_type='switchboard_contact_preference') switchboard_consumers,
       (select count(*)::int from public.webhook_events
         where provider='switchboard' and event_type='contact_preference') switchboard_events,
       (select count(*)::int from public.global_phone_dnc_registry) global_dnc_rows`,
  );
  const constraints = await client.query(
    `select conname,convalidated,pg_get_constraintdef(oid,true) definition
       from pg_constraint
      where conrelid='public.webhook_consumers'::regclass
        and conname=any(array[
          'webhook_consumers_type_check',
          'webhook_consumers_type_source_match_check'
        ]) order by conname`,
  );
  const protectedSwitchboard = await client.query(
    `select jsonb_build_object(
       'functions',(
         select coalesce(jsonb_agg(
           jsonb_build_array(proc.proname,pg_get_functiondef(proc.oid))
           order by proc.proname,proc.oid
         ),'[]'::jsonb)
         from pg_proc proc
         where proc.pronamespace='public'::regnamespace
           and (
             proc.proname like '%global%phone%dnc%'
             or proc.proname like '%switchboard%contact%preference%'
             or proc.proname like '%global%dnc%'
           )
       ),
       'triggers',(
         select coalesce(jsonb_agg(
           jsonb_build_array(trigger.tgname,pg_get_triggerdef(trigger.oid,true))
           order by trigger.tgname,trigger.oid
         ),'[]'::jsonb)
         from pg_trigger trigger
         where not trigger.tgisinternal
           and (
             trigger.tgname like '%global%dnc%'
             or trigger.tgname like '%global_phone_dnc%'
           )
       ),
       'registry_columns',(
         select coalesce(jsonb_agg(
           jsonb_build_array(attribute.attname,
             format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull)
           order by attribute.attnum
         ),'[]'::jsonb)
         from pg_attribute attribute
         where attribute.attrelid='public.global_phone_dnc_registry'::regclass
           and attribute.attnum>0 and not attribute.attisdropped
       ),
       'registry_constraints',(
         select coalesce(jsonb_agg(
           jsonb_build_array(constraint_info.conname,constraint_info.convalidated,
             pg_get_constraintdef(constraint_info.oid,true))
           order by constraint_info.conname
         ),'[]'::jsonb)
         from pg_constraint constraint_info
         where constraint_info.conrelid='public.global_phone_dnc_registry'::regclass
       )
     ) value`,
  );
  return {
    database: identity.rows[0].database,
    systemIdentifier: identity.rows[0].system_identifier,
    history: history.rows,
    counts: counts.rows[0],
    constraints: constraints.rows,
    protectedSwitchboard: protectedSwitchboard.rows[0].value,
  };
}

function classifyMigrationHistory(observation, plan) {
  if (observation.database !== EXPECTED_DATABASE) {
    throw new Error(`Expected database ${EXPECTED_DATABASE}; observed ${observation.database}.`);
  }
  const switchboard = observation.history.find((row) => row.version === plan.switchboard.version);
  if (!switchboard || switchboard.name !== plan.switchboard.name) {
    throw new Error("The exact Switchboard 092331 ledger row is absent.");
  }
  if (JSON.stringify(switchboard.statements) !== JSON.stringify(plan.switchboard.statements)) {
    throw new Error("The Switchboard 092331 ledger statements differ from the reviewed file.");
  }
  const applied = plan.migrations.filter((entry) =>
    observation.history.some((row) => row.version === entry.version),
  );
  if (applied.length !== 0 && applied.length !== plan.migrations.length) {
    throw new Error("The eSign atomic migration ledger is partial; refusing to guess recovery state.");
  }
  if (applied.length === plan.migrations.length) {
    for (const entry of plan.migrations) {
      const row = observation.history.find((candidate) => candidate.version === entry.version);
      if (
        row.name !== entry.name ||
        JSON.stringify(row.statements) !== JSON.stringify(entry.statements)
      ) {
        throw new Error(`Applied eSign migration ${entry.version} differs from the reviewed packet.`);
      }
    }
  }
  for (const [name, count] of Object.entries(observation.counts)) {
    if (Number(count) !== 0) throw new Error(`Preflight ${name} must be zero; observed ${count}.`);
  }
  return applied.length === 0 ? "pending" : "already_applied";
}

function safeSnapshot(observation, plan) {
  return {
    format: 1,
    recordedAt: new Date().toISOString(),
    productionProjectRef: plan.productionProjectRef,
    database: observation.database,
    systemIdentifier: observation.systemIdentifier,
    switchboardLedger: {
      version: plan.switchboard.version,
      name: plan.switchboard.name,
      statementCount: plan.switchboard.statements.length,
      statementsSha256: sha256(JSON.stringify(plan.switchboard.statements)),
      fileSha256: plan.switchboard.sha256,
    },
    eSignMigrations: plan.migrations.map((entry) => ({
      version: entry.version,
      name: entry.name,
      statementCount: entry.statements.length,
      statementsSha256: sha256(JSON.stringify(entry.statements)),
      fileSha256: entry.sha256,
    })),
    counts: observation.counts,
    constraints: observation.constraints,
    protectedSwitchboard: observation.protectedSwitchboard,
    protectedSwitchboardSha256: sha256(JSON.stringify(observation.protectedSwitchboard)),
  };
}

function writePrivateSnapshot(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function assertSnapshotMatches(snapshot, observation, plan) {
  if (snapshot.productionProjectRef !== plan.productionProjectRef) {
    throw new Error("Rollback snapshot project ref does not match the reviewed plan.");
  }
  if (snapshot.database !== observation.database || snapshot.systemIdentifier !== observation.systemIdentifier) {
    throw new Error("Rollback snapshot database identity no longer matches the live connection.");
  }
  if (Date.now() - Date.parse(snapshot.recordedAt) > 30 * 60 * 1000) {
    throw new Error("Rollback snapshot is older than 30 minutes; rerun preflight.");
  }
  if (JSON.stringify(snapshot.counts) !== JSON.stringify(observation.counts)) {
    throw new Error("Rollback snapshot zero-row counts changed; rerun preflight.");
  }
  if (
    snapshot.protectedSwitchboardSha256 !==
    sha256(JSON.stringify(observation.protectedSwitchboard))
  ) {
    throw new Error("Protected Switchboard objects changed; rerun preflight.");
  }
}

export async function recordProductionPreflight(client, plan, snapshotPath) {
  const observation = await readObservation(client, plan);
  const outcome = classifyMigrationHistory(observation, plan);
  if (outcome !== "pending") {
    throw new Error("The exact eSign packet is already applied; no pre-apply rollback snapshot was written.");
  }
  const snapshot = safeSnapshot(observation, plan);
  writePrivateSnapshot(snapshotPath, snapshot);
  return snapshot;
}

export async function applyProductionPacket(client, plan, snapshot, options = {}) {
  await client.query("begin");
  try {
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    await client.query("set local idle_in_transaction_session_timeout='60s'");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('sandra-esign-atomic-production-v1',0))",
    );
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('switchboard-global-dnc-write-barrier-v1',0))",
    );
    await client.query("lock table public.webhook_consumers in access exclusive mode");

    const lockedObservation = await readObservation(client, plan);
    const historyOutcome = classifyMigrationHistory(lockedObservation, plan);
    assertSnapshotMatches(snapshot, lockedObservation, plan);

    if (historyOutcome === "pending") {
      for (const entry of plan.migrations) {
        for (const statement of migrationBodyStatements(entry)) {
          await client.query(statement);
        }
        await client.query(
          `insert into supabase_migrations.schema_migrations(version,name,statements)
           values ($1,$2,$3::text[])`,
          [entry.version, entry.name, entry.statements],
        );
      }
    }

    const finalConstraints = await client.query(
      `select conname,convalidated,pg_get_constraintdef(oid,true) definition
         from pg_constraint
        where conrelid='public.webhook_consumers'::regclass
          and conname=any(array[
            'webhook_consumers_type_check',
            'webhook_consumers_type_source_match_check'
          ]) order by conname`,
    );
    if (finalConstraints.rows.length !== 2 || finalConstraints.rows.some((row) => !row.convalidated)) {
      throw new Error("Final webhook-consumer constraints are absent or unvalidated.");
    }
    const definitions = finalConstraints.rows.map((row) => row.definition).join("\n");
    for (const value of REQUIRED_SWITCHBOARD_TYPES) {
      if (!definitions.includes(value)) throw new Error(`Final constraint union omits ${value}.`);
    }
    const finalObservation = await readObservation(client, {
      ...plan,
      migrations: [],
    });
    if (
      snapshot.protectedSwitchboardSha256 !==
      sha256(JSON.stringify(finalObservation.protectedSwitchboard))
    ) {
      throw new Error("Protected Switchboard objects changed during the eSign transaction.");
    }
    if (options.beforeCommit) await options.beforeCommit(client);
    await client.query("commit");
    return { outcome: historyOutcome === "pending" ? "applied" : "already_applied", constraints: finalConstraints.rows };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const mode = args.mode;
  const snapshotPath = args.snapshot;
  if (!['preflight', 'execute'].includes(mode) || !snapshotPath) {
    throw new Error("Usage: --mode=preflight|execute --snapshot=/absolute/private/path.json");
  }
  const plan = loadReviewedPlan(args.plan ? resolve(args.plan) : DEFAULT_PLAN_PATH);
  const databaseUrl = process.env[PRODUCTION_URL_ENV];
  if (!databaseUrl) throw new Error(`${PRODUCTION_URL_ENV} is required.`);
  if (declaredProjectRef(databaseUrl) !== plan.productionProjectRef) {
    throw new Error("Database URL does not target the reviewed Sandra production project.");
  }
  const cliVersion = execFileSync("supabase", ["--version"], { encoding: "utf8" }).trim();
  if (cliVersion !== plan.supabaseCliVersion) {
    throw new Error(`Supabase CLI ${plan.supabaseCliVersion} is required; observed ${cliVersion}.`);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (mode === "preflight") {
      await recordProductionPreflight(client, plan, resolve(snapshotPath));
      process.stdout.write("eSign production preflight passed; private rollback snapshot recorded.\n");
      return;
    }
    if (process.env.SANDRA_ESIGN_ATOMIC_PRODUCTION_EXECUTE !== EXECUTION_ARM) {
      throw new Error("Atomic production execution is not explicitly armed.");
    }
    const snapshot = readJson(resolve(snapshotPath));
    const result = await applyProductionPacket(client, plan, snapshot);
    process.stdout.write(
      result.outcome === "applied"
        ? "eSign atomic production migration transaction committed.\n"
        : "eSign atomic production migration was already applied exactly; no DDL replayed.\n",
    );
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`REFUSING: ${error.message}\n`);
    process.exitCode = 1;
  });
}
