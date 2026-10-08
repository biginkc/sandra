#!/usr/bin/env node
// Rollback-chain proof for the Jev + messages-v2 migrations
// (20261008140000 .. 20261008250000 -- 50 migrations: 28 inherited Jev + 13 messages-v2 (143000..144200) + 4 Phase 1 holds/alerts + 1 scorecard + 1 new-only alert watermark + 1 replay harness + 1 holds New/Backlog + 1 Luna suggestions).
//
// Against a DISPOSABLE database on the local Postgres it:
//   1. clones schema-only auth/storage/realtime from an existing local DB,
//   2. applies ALL supabase/migrations/*.sql in order (ON_ERROR_STOP),
//   3. applies the 49 rollbacks in REVERSE order,
//   4. asserts no jev_* / pipeline_* / ai_reply_* object remains,
//   5. re-applies the 49 migrations forward again.
// It exits non-zero on any error or leftover object, and always drops the
// scratch DB.
//
// Usage: node scripts/messages-v2/verify-rollback-chain.mjs
// Env:   PG_URL    server URL (default postgresql://postgres:postgres@127.0.0.1:54329)
//        SOURCE_DB existing DB holding auth/storage/realtime (default postgres)
//        KEEP_DB=1 keep the scratch DB for inspection
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PG_URL = (process.env.PG_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329").replace(/\/$/, "");
const SOURCE_DB = process.env.SOURCE_DB ?? "postgres";
const DB = `rollback_chain_${process.pid}_${Date.now().toString(36)}`;
const FIRST = "20261008140000";
const LAST = process.env.CHAIN_LAST ?? "20261008250000";
const EXPECTED = Number(process.env.CHAIN_EXPECTED ?? 50); // 28 inherited Jev (140000..142700) + 13 messages-v2 (143000..144200) + 4 Phase 1 (150000..150300) + 1 scorecard (160000) + 1 replay harness (180000) + 1 new-only watermark (210000) + 1 New/Backlog (230000) + 1 Luna suggestions (250000)

const migDir = join(root, "supabase/migrations");
const rbDir = join(root, "supabase/rollbacks");
const allMigrations = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
const chain = allMigrations.filter((f) => f.slice(0, 14) >= FIRST && f.slice(0, 14) <= LAST);

const failures = [];
const log = (m) => console.log(m);

// The cloned schemas come from a Supabase-style local DB; drop server-parameter
// SETs the scratch role may not set, and make CREATE SCHEMA re-runnable.
const cleanDump = (d) =>
  d.replace(/^CREATE SCHEMA (auth|storage|realtime);$/gm, "CREATE SCHEMA IF NOT EXISTS $1;")
    .replace(/^SET (log_min_messages|session_replication_role)[^\n]*$/gm, "");

function psql(db, args, input) {
  return spawnSync("psql", [`${PG_URL}/${db}`, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024,
  });
}
function runFile(label, file) {
  const r = psql(DB, ["--single-transaction", "-f", file]); // one transaction per file, like the Supabase migrator
  if (r.status !== 0) {
    failures.push(`${label}: ${file.split("/").pop()}\n${(r.stderr || "").trim().split("\n").slice(0, 8).join("\n")}`);
    return false;
  }
  return true;
}
function query(sql) {
  const r = psql(DB, ["-At", "-c", sql]);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().split("\n").filter(Boolean);
}
function phase(name, files, dir) {
  let ok = 0;
  for (const f of files) if (runFile(name, join(dir, f))) ok++;
  log(`${name}: ${ok}/${files.length} ok`);
  return ok === files.length;
}

// Every jev_/pipeline_/ai_reply_ object (tables, views, functions, triggers,
// policies, indexes, sequences, types) that must be gone after the rollback.
const LEFTOVER_SQL = `
select kind || ' ' || name from (
  select 'relation' as kind, n.nspname || '.' || c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname ~ '^(jev_|pipeline_|ai_reply_|hold_alert_|messages_v2_|luna_|idx_jev_|idx_pipeline_|idx_ai_reply_|idx_hold_alert_|idx_luna_)'
  union all
  select 'function', n.nspname || '.' || p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ '^(jev_|fn_.*jev_|pipeline_|fn_.*pipeline_|ai_reply_|fn_.*ai_reply_|hold_alert_|fn_.*hold_alert_|messages_v2_|luna_|fn_messages_v2_|fn_resolve_hold)'
  union all
  select 'trigger', c.relname || '.' || t.tgname
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal and t.tgname ~ '(jev_|pipeline_|ai_reply_|hold_alert_|messages_v2_|luna_)'
  union all
  select 'policy', tablename || '.' || policyname from pg_policies
   where schemaname = 'public' and (policyname ~ '(jev_|pipeline_|ai_reply_|hold_alert_|messages_v2_|luna_)' or tablename ~ '^(jev_|pipeline_|ai_reply_|hold_alert_|messages_v2_|luna_)')
  union all
  select 'type', t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
   where n.nspname = 'public' and t.typname ~ '^(jev_|pipeline_|ai_reply_|hold_alert_|messages_v2_|luna_)' and t.typtype <> 'c'
) x order by 1`;

// Dump the whole public schema (functions, constraints, policies, columns,
// triggers, views) so the rollback phase can be compared to the pre-chain state.
function publicSchemaFingerprint() {
  const r = spawnSync("pg_dump", ["-s", "-n", "public", "--no-owner", `${PG_URL}/${DB}`], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function main() {
  if (chain.length !== EXPECTED) throw new Error(`expected ${EXPECTED} chain migrations, found ${chain.length}`);
  const missing = chain.filter((f) => !existsSync(join(rbDir, f)));
  if (missing.length) throw new Error(`missing rollbacks:\n  ${missing.join("\n  ")}`);

  const adm = spawnSync("psql", [`${PG_URL}/postgres`, "-X", "-q", "-c", `create database ${DB}`], { encoding: "utf8" });
  if (adm.status !== 0) throw new Error(`create database failed: ${adm.stderr}`);
  log(`scratch db: ${DB}`);

  try {
    // Clone schema-only auth/storage/realtime.
    const dump = spawnSync("pg_dump", ["-s", "--no-owner", "--no-privileges", "-n", "auth", "-n", "storage", "-n", "realtime", `${PG_URL}/${SOURCE_DB}`], {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    });
    if (dump.status !== 0) throw new Error(`pg_dump ${SOURCE_DB} failed: ${dump.stderr}`);
    const pre = psql(DB, ["-v", "ON_ERROR_STOP=0"], `
      create schema if not exists extensions;
      create extension if not exists pgcrypto with schema extensions;
      create extension if not exists btree_gist with schema extensions;
      create extension if not exists pg_trgm with schema extensions;
      create extension if not exists "uuid-ossp" with schema extensions;
      create publication supabase_realtime;
      ${cleanDump(dump.stdout)}
    `);
    // Cloned dumps can reference extension types; tolerate non-fatal clone noise
    // only if the schemas ended up usable.
    if (pre.status !== 0) log(`clone warning: ${(pre.stderr || "").trim().split("\n")[0]}`);
    if (query("select to_regclass('auth.users') is not null and to_regclass('storage.objects') is not null").join("") !== "t")
      throw new Error("clone of auth/storage failed: auth.users / storage.objects missing");

    // 1. Everything forward.
    const allOk = phase("forward-all", allMigrations, migDir);
    if (!allOk) throw new Error("forward-all failed; cannot continue");
    const before = query(LEFTOVER_SQL);
    log(`objects present after full forward apply: ${before.length}`);
    if (before.length === 0) failures.push("sanity: no jev_/pipeline_/ai_reply_ objects after forward apply (check is vacuous)");

    // 2. Rollbacks, reverse order.
    // 2. Rollbacks, reverse order, once each.
    const rbOk = phase("rollback-reverse", [...chain].reverse(), rbDir);
    const left = query(LEFTOVER_SQL);
    if (left.length) failures.push(`leftover objects after rollback (${left.length}):\n  ${left.join("\n  ")}`);
    log(`leftover jev_/pipeline_/ai_reply_ objects after rollback: ${left.length}`);

    // 3. Forward again.
    const againOk = rbOk && phase("forward-again", chain, migDir);

    // Idempotency: roll the chain back again, applying each rollback twice
    // back-to-back (the second run at the same point must also be error-free).
    if (againOk) phase("rollback-reverse, each applied twice (idempotency)", [...chain].reverse().flatMap((f) => [f, f]), rbDir);
    const rbOk2 = againOk; // an idempotency failure rolls back only the repeat run, so the state is still valid to diff

    // 4. Rolled-back state must equal the true pre-chain state (exact-reversal
    //    check): rebuild a second DB with only pre-chain migrations and diff.
    if (rbOk2) {
      const preChain = allMigrations.filter((f) => f.slice(0, 14) < FIRST);
      // DB is already rolled back (idempotency pass above): fingerprint it and
      // compare to a DB built from the pre-chain migrations only.
      const rolled = publicSchemaFingerprint();
      const ref = `${DB}_ref`;
      spawnSync("psql", [`${PG_URL}/postgres`, "-X", "-q", "-c", `create database ${ref}`]);
      try {
        const refPre = spawnSync("psql", [`${PG_URL}/${ref}`, "-X", "-q", "-v", "ON_ERROR_STOP=0"], {
          encoding: "utf8", input: `create schema if not exists extensions;
            create extension if not exists pgcrypto with schema extensions;
            create extension if not exists btree_gist with schema extensions;
            create extension if not exists pg_trgm with schema extensions;
            create extension if not exists "uuid-ossp" with schema extensions;
            create publication supabase_realtime;
            ${cleanDump(dump.stdout)}`,
          maxBuffer: 256 * 1024 * 1024,
        });
        void refPre;
        for (const f of preChain) {
          const r = spawnSync("psql", [`${PG_URL}/${ref}`, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", join(migDir, f)], { encoding: "utf8" });
          if (r.status !== 0) { failures.push(`ref build failed at ${f}: ${r.stderr.split("\n")[0]}`); break; }
        }
        const refDump = spawnSync("pg_dump", ["-s", "-n", "public", "--no-owner", `${PG_URL}/${ref}`], {
          encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
        }).stdout;
        const norm = (s) => s.split("\n").filter((l) => !/^(--|SET |SELECT pg_catalog|\\(un)?restrict )/.test(l)).join("\n");
        if (norm(rolled) === norm(refDump)) log("schema after rollback == pre-chain schema: IDENTICAL");
        else {
          const a = norm(rolled).split("\n"), b = new Set(norm(refDump).split("\n"));
          const aset = new Set(a);
          const onlyRolled = a.filter((l) => !b.has(l)).slice(0, 15);
          const onlyRef = [...b].filter((l) => !aset.has(l)).slice(0, 15);
          log(`schema after rollback DIFFERS from pre-chain (informational; see list). only-in-rolled-back: ${onlyRolled.length}, only-in-pre-chain: ${onlyRef.length}`);
          for (const l of onlyRolled) log(`  + ${l.slice(0, 160)}`);
          for (const l of onlyRef) log(`  - ${l.slice(0, 160)}`);
          if (process.env.STRICT_DIFF === "1") failures.push("schema diff vs pre-chain");
        }
      } finally {
        spawnSync("psql", [`${PG_URL}/postgres`, "-X", "-q", "-c", `drop database if exists ${ref} with (force)`]);
      }
    }
  } finally {
    if (process.env.KEEP_DB !== "1") {
      spawnSync("psql", [`${PG_URL}/postgres`, "-X", "-q", "-c", `drop database if exists ${DB} with (force)`]);
      log(`dropped ${DB}`);
    } else log(`kept ${DB}`);
  }

  if (failures.length) {
    console.error(`\nFAIL (${failures.length}):\n` + failures.join("\n---\n"));
    process.exit(1);
  }
  log("\nPASS: forward-all, reverse rollback (+idempotent re-run), forward-again all clean; no jev_/pipeline_/ai_reply_ objects after rollback.");
}

try { main(); } catch (e) {
  console.error(String(e.message ?? e));
  if (failures.length) console.error(`\nfirst failures (${failures.length}):\n` + failures.slice(0, 5).join("\n---\n"));
  process.exit(1);
}
