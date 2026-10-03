// Local-only proof that a Norma migration fails fast under a blocker and applies cleanly without one.
//
//   LOCKPROOF_MARKER=<marker> node scripts/norma-migration-lock-timeout-proof.mjs \
//     --db-url postgresql://postgres:postgres@127.0.0.1:<private-port>/postgres \
//     --migration supabase/migrations/20261002150000_norma_call_twice.sql
//
// Runs the real `supabase db push --include-all --db-url` (same executor as the CI workflows) against a
// DISPOSABLE Postgres that already has every earlier migration. Refuses unless the database carries the
// ownership marker (public._lockproof_owner.marker == $LOCKPROOF_MARKER) and is not a shared dev port.
//   (a) another session holds a conflicting lock on public.norma_call_requests: the push must fail with
//       SQLSTATE 55P03 in about lock_timeout (5s) and leave schema + migration history byte-identical;
//   (b) with the blocker released the same push applies cleanly and records the migration.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const FORBIDDEN_PORTS = new Set(["54329", "55329", "55331", "57329", "57331", "54321", "54322"]);
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const dbUrl = arg("db-url");
const migration = arg("migration");
const cli = arg("cli") ?? process.env.SUPABASE_CLI ?? "supabase";
const marker = process.env.LOCKPROOF_MARKER;
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; throw new Error(m); };

if (!dbUrl || !migration || !marker) fail("need --db-url, --migration and LOCKPROOF_MARKER");
const u = new URL(dbUrl);
if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.search) fail("db-url must be loopback with no query");
if (FORBIDDEN_PORTS.has(u.port)) fail(`port ${u.port} is a shared dev/sandbox port`);
const file = path.basename(migration);
const version = file.split("_")[0];
const sql = fs.readFileSync(migration, "utf8");
if (!/^set local lock_timeout\s*=\s*'5s';/m.test(sql) || !/^lock table public\.norma_call_requests in access exclusive mode;/m.test(sql)) {
  fail("migration lacks set local lock_timeout / up-front lock");
}

const connect = async () => { const c = new pg.Client({ connectionString: dbUrl }); await c.connect(); return c; };
const obs = await connect();
const holder = await connect();
let work = "";
try {
  const own = await obs.query("select 1 from public._lockproof_owner where marker = $1", [marker]);
  if (own.rowCount !== 1) fail("ownership marker missing: not my disposable database");

  // Fingerprint of everything these migrations can touch, plus migration history.
  const snapshot = async () => (await obs.query(`
    select md5(concat_ws('|',
      (select string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, ''), ',' order by column_name)
         from information_schema.columns where table_schema = 'public' and table_name = 'norma_call_requests'),
      (select string_agg(conname || pg_get_constraintdef(oid), ',' order by conname)
         from pg_constraint where conrelid = 'public.norma_call_requests'::regclass),
      (select string_agg(indexdef, ',' order by indexname) from pg_indexes where tablename = 'norma_call_requests'),
      (select string_agg(p.proname || md5(pg_get_functiondef(p.oid)), ',' order by p.proname, p.oid)
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.proname like 'fn\\_norma\\_%' or p.proname like 'norma\\_%')),
      '')) as fp`)).rows[0].fp
    + "|history:" + ((await obs.query("select to_regclass('supabase_migrations.schema_migrations') as t")).rows[0].t
      ? (await obs.query("select coalesce(string_agg(version, ',' order by version), '') v from supabase_migrations.schema_migrations")).rows[0].v : "");

  work = fs.mkdtempSync(path.join(os.tmpdir(), "norma-lockproof-"));
  fs.mkdirSync(path.join(work, "supabase/migrations"), { recursive: true });
  fs.writeFileSync(path.join(work, "supabase/config.toml"), 'project_id = "norma-lockproof"\n');
  fs.copyFileSync(migration, path.join(work, "supabase/migrations", file));
  // The CLI refuses a push if remote history names versions missing locally: mirror already-recorded ones.
  if ((await obs.query("select to_regclass('supabase_migrations.schema_migrations') as t")).rows[0].t) {
    const done = new Set((await obs.query("select version from supabase_migrations.schema_migrations")).rows.map((r) => r.version));
    for (const f of fs.readdirSync(path.dirname(migration))) {
      if (f.endsWith(".sql") && done.has(f.split("_")[0])) fs.copyFileSync(path.join(path.dirname(migration), f), path.join(work, "supabase/migrations", f));
    }
  }

  const push = () => new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(cli, ["db", "push", "--include-all", "--db-url", `${dbUrl}?sslmode=disable`, "--workdir", work], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
    const killer = setTimeout(() => p.kill("SIGKILL"), 60_000); // bound the waiter
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, ms: Date.now() - t, log }); });
  });

  // Server-side wait: first/last time a backend is blocked on a lock for norma_call_requests.
  let firstSeen = 0, lastSeen = 0, polling = true;
  const poller = (async () => {
    while (polling) {
      const r = await obs.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()
        and (query ilike '%norma_call_requests%') and pid <> pg_backend_pid()`);
      if (r.rowCount) { lastSeen = Date.now(); firstSeen ||= lastSeen; }
      await new Promise((r2) => setTimeout(r2, 100));
    }
  })();

  const before = await snapshot();
  const before_col = (await obs.query("select count(*)::int n from information_schema.columns where table_name='norma_call_requests' and column_name='attempt'")).rows[0].n;

  // (a) blocker: an open transaction that has merely READ the table (ACCESS SHARE) is enough to block ACCESS EXCLUSIVE.
  await holder.query("set idle_in_transaction_session_timeout = '90s'"); // bound the blocker too
  await holder.query("begin");
  await holder.query("select count(*) from public.norma_call_requests");
  const a = await push();
  await holder.query("rollback");
  polling = false; await poller;
  const afterA = await snapshot();
  const result = {
    migration: file,
    blocked: {
      exitCode: a.code, cliWallMs: a.ms,
      serverSideLockWaitMs: firstSeen ? lastSeen - firstSeen + 100 : null,
      sqlstate55P03: /55P03|lock timeout/i.test(a.log),
      logExcerpt: a.log.split("\n").filter((l) => /55P03|lock timeout|ERROR|Applying/i.test(l)).slice(0, 4),
      schemaAndHistoryUnchanged: before === afterA,
    },
  };
  if (a.code === 0) fail("blocked push unexpectedly succeeded");
  if (!result.blocked.sqlstate55P03) fail(`blocked push did not fail with 55P03/lock timeout: ${a.log.slice(-600)}`);
  if (a.ms > 20_000) fail(`blocked push took ${a.ms}ms (>20s): timeout did not bound the wait`);
  if (!result.blocked.schemaAndHistoryUnchanged) fail("blocked push left a partial change");

  // (b) no blocker.
  const b = await push();
  const rec = (await obs.query("select 1 from supabase_migrations.schema_migrations where version = $1", [version])).rowCount;
  result.clean = { exitCode: b.code, cliWallMs: b.ms, recordedInHistory: rec === 1, schemaChanged: (await snapshot()) !== afterA, attemptColumnBefore: before_col };
  if (b.code !== 0 || rec !== 1) fail(`clean push failed: ${b.log.slice(-400)}`);
  console.log(JSON.stringify(result, null, 1));
} finally {
  await holder.query("rollback").catch(() => {});
  await holder.end().catch(() => {}); await obs.end().catch(() => {});
  if (work) fs.rmSync(work, { recursive: true, force: true });
}
