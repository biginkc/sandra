// Local-only empirical lock probe (SBX_WORKDIR = the disposable stack's supabase workdir). Runs the REAL pinned CLI (`supabase db push
// --include-all`, same version/command as db-migrate-*.yml) against the seeded
// disposable stack while sampling every 50 ms from separate connections:
//  - pg_locks waits and ACCESS EXCLUSIVE holders on the filter tables
//  - the migration backend's xact_start (distinct values => separate commits)
//  - latency of a concurrent single-row `insert into messages` and a
//    `select ... from properties` read (max = worst blocked time)
import { spawn } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { assertSandboxTarget } from "./assert-sandbox-target.mjs";

const DB = "postgresql://postgres:postgres@127.0.0.1:55329/postgres";
console.error("target:", JSON.stringify(await assertSandboxTarget()));
const CLI = process.env.SUPABASE_CLI ?? "/tmp/sb2109/node_modules/.bin/supabase";
const ORG = "00000000-0000-0000-0000-000000000bbb";
const TABLES = ["properties", "messages", "tasks", "property_lists", "property_tags"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c; };
const [observer, writer, reader, wTasks, wLists, wTags, wProps] = [await mk(), await mk(), await mk(), await mk(), await mk(), await mk(), await mk()];
const ownPids = [];
const { rows: [{ id: pid0 }] } = await observer.query("select id from public.properties where market = 'VOL' and not is_dnc_locked limit 1");
const obsPid = (await observer.query("select pg_backend_pid() p")).rows[0].p;
const wPid = (await writer.query("select pg_backend_pid() p")).rows[0].p;
const rPid = (await reader.query("select pg_backend_pid() p")).rows[0].p;
for (const c of [wTasks, wLists, wTags, wProps]) ownPids.push((await c.query("select pg_backend_pid() p")).rows[0].p);
const { rows: [{ id: userId }] } = await observer.query("select user_id id from public.memberships limit 1");
const probeList = (await observer.query("insert into public.lists (org_id, name) values ($1, 'probe-list-' || gen_random_uuid()) returning id", [ORG])).rows[0].id;
const probeTag = (await observer.query("insert into public.tags (org_id, name, category) values ($1, 'probe-tag-' || gen_random_uuid(), 'custom') returning id", [ORG])).rows[0].id;

let done = false;
const out = { cli: null, perWriter: {}, insertMs: [], readMs: [], insertErrors: 0, waits: [], migrationXactStarts: new Set(), migrationPids: new Set(), accessExclusive: {}, samples: 0, maxMigXactAgeMs: 0, perPidMaxXactAgeMs: {} };
const t0 = Date.now();

async function timed(c, sql, params, bucket) {
  const s = performance.now();
  try { await c.query(sql, params); } catch (e) { out.insertErrors++; (out.errs ??= []).push({ sqlstate: e.code, severity: e.severity, message: String(e.message), where: e.where ?? null, routine: e.routine ?? null, statement: sql.slice(0, 60), atMs: Date.now() - t0 }); }
  out[bucket].push(performance.now() - s);
}
function track(name, ms, err) { const w = (out.perWriter[name] ??= { n: 0, errors: [], ms: [] }); w.n++; w.ms.push(ms); if (err) w.errors.push({ sqlstate: err.code, message: String(err.message), where: err.where ?? null, atMs: Date.now() - t0 }); }
async function extra(name, c, sql, params, cleanupSql, cleanupParams) {
  while (!done) {
    const s0 = performance.now(); let err = null;
    try { await c.query(sql, params); } catch (e) { err = e; }
    track(name, performance.now() - s0, err);
    if (cleanupSql && !err) await c.query(cleanupSql, cleanupParams).catch(() => {});
    await sleep(50);
  }
}
const extraLoops = [
  extra("tasks.insert", wTasks, "insert into public.tasks (org_id, assignee_id, created_by, related_property_id, type, status, title, due_at) values ($1,$2,$2,$3,'custom','completed','probe', now())", [ORG, userId, pid0]),
  extra("property_lists.insert", wLists, "insert into public.property_lists (org_id, property_id, list_id) values ($1,$2,$3)", [ORG, pid0, probeList], "delete from public.property_lists where property_id=$1 and list_id=$2", [pid0, probeList]),
  extra("property_tags.insert", wTags, "insert into public.property_tags (org_id, property_id, tag_id) values ($1,$2,$3)", [ORG, pid0, probeTag], "delete from public.property_tags where property_id=$1 and tag_id=$2", [pid0, probeTag]),
  extra("properties.update", wProps, "update public.properties set city = 'probe' || floor(random()*1000)::int where id = $1", [pid0]),
];
const writerLoop = (async () => { while (!done) { await timed(writer, "insert into public.messages (org_id, property_id, channel, direction, body) values ($1,$2,'sms','outbound','probe')", [ORG, pid0], "insertMs"); await sleep(50); } })();
const readerLoop = (async () => { while (!done) { await timed(reader, "select id, address from public.properties where market = 'VOL' order by id limit 25", [], "readMs"); await sleep(50); } })();
const obsLoop = (async () => {
  while (!done) {
    out.samples++;
    const { rows: act } = await observer.query(`select pid, application_name, state, wait_event_type, extract(epoch from (clock_timestamp()-xact_start))*1000 age_ms, xact_start::text xs, left(query, 90) q
      from pg_stat_activity where datname = current_database() and pid <> all ($1::int[]) and pid <> pg_backend_pid() and backend_type = 'client backend' and xact_start is not null`, [[obsPid, wPid, rPid, ...ownPids]]);
    for (const a of act) {
      if (/refresh_property_filter_cache|filter_cache|filter_list_ids|has_inbound_message|schema_migrations/i.test(a.q) || out.migrationPids.has(a.pid)) {
        out.migrationPids.add(a.pid); out.migrationXactStarts.add(a.xs);
        out.perPidMaxXactAgeMs[a.pid] = Math.max(out.perPidMaxXactAgeMs[a.pid] ?? 0, a.age_ms);
        out.maxMigXactAgeMs = Math.max(out.maxMigXactAgeMs, a.age_ms);
      }
    }
    const { rows: locks } = await observer.query(`select l.pid, c.relname, l.mode, l.granted from pg_locks l join pg_class c on c.oid = l.relation
      where c.relname = any($1) and (not l.granted or l.mode = 'AccessExclusiveLock') and l.pid <> all ($2::int[])`, [TABLES, [obsPid, wPid, rPid, ...ownPids]]);
    for (const l of locks) {
      if (!l.granted) out.waits.push({ t: Date.now() - t0, pid: l.pid, rel: l.relname, mode: l.mode });
      else { const k = l.relname; const e = (out.accessExclusive[k] ??= { first: Date.now() - t0, last: 0 }); e.last = Date.now() - t0; }
    }
    await sleep(50);
  }
})();

const dry = process.argv.includes("--dry");
await assertSandboxTarget(); // re-check immediately before db push
// Refuse to push anywhere but the disposable stack (workdir config must be the 55329 sandbox).
if (!process.env.SBX_WORKDIR || !/port\s*=\s*55329/.test(fs.readFileSync(process.env.SBX_WORKDIR + "/supabase/config.toml", "utf8"))) {
  throw new Error("SBX_WORKDIR must point at the disposable stack workdir (db port 55329); refusing to run db push --local");
}
const child = spawn(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR, ...(dry ? ["--dry-run"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const code = await new Promise((r) => child.on("close", r));
await sleep(300); done = true; await Promise.all([writerLoop, readerLoop, obsLoop, ...extraLoops]);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]) : null; };
const res = {
  cliExit: code, cliVersion: (await new Promise((r) => { const p = spawn(CLI, ["--version"]); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", () => r(o.trim())); })),
  wallMs: Date.now() - t0, probeSamples: out.samples,
  insert: { n: out.insertMs.length, errors: out.insertErrors, p50: pct(out.insertMs, 0.5), p95: pct(out.insertMs, 0.95), maxMs: pct(out.insertMs, 1) },
  read: { n: out.readMs.length, p50: pct(out.readMs, 0.5), p95: pct(out.readMs, 0.95), maxMs: pct(out.readMs, 1) },
  perWriter: Object.fromEntries(Object.entries(out.perWriter).map(([k, v]) => [k, { n: v.n, maxMs: pct(v.ms, 1), errors: v.errors }])),
  insertErrorMessages: out.errs ?? [], lockWaitWindowMs: out.waits.length ? [out.waits[0].t, out.waits.at(-1).t] : null,
  lockWaitSamples: out.waits.length, lockWaitsByRel: out.waits.reduce((m, w) => ((m[w.rel] = (m[w.rel] ?? 0) + 1), m), {}),
  accessExclusiveHoldMs: Object.fromEntries(Object.entries(out.accessExclusive).map(([k, v]) => [k, { holdMs: v.last - v.first + 50, window: [v.first, v.last] }])),
  migrationBackends: [...out.migrationPids], distinctMigrationXactStarts: out.migrationXactStarts.size, maxMigrationXactAgeMs: Math.round(out.maxMigXactAgeMs),
  perBackendMaxXactAgeMs: out.perPidMaxXactAgeMs,
  cliLogTail: log.split("\n").slice(-25),
};
fs.mkdirSync("scripts/filter-volume/results", { recursive: true });
fs.writeFileSync("scripts/filter-volume/results/lock-probe.json", JSON.stringify(res, null, 2));
console.log(JSON.stringify(res, null, 2));
await observer.query('delete from public.tasks where title = $1', ['probe']).catch(() => {}); await observer.query('delete from public.messages where body = $1', ['probe']).catch(() => {}); await observer.query('delete from public.lists where id=$1', [probeList]).catch(() => {}); await observer.query('delete from public.tags where id=$1', [probeTag]).catch(() => {});
await observer.end(); await wTasks.end(); await wLists.end(); await wTags.end(); await wProps.end(); await writer.end(); await reader.end();
