// Local-only (55329 sandbox, identity-checked): barrier-forced test of the residual
// lock-order path for migration 20261002110000's single up-front LOCK statement.
//  Order X: writer holds `properties` (FOR UPDATE), the migration's LOCK takes the child
//           tables then waits on `properties`, then the writer inserts into `messages`
//           after a varied delay => real deadlock; record WHO gets 40P01.
//  Order Y: writer holds `messages` (inserted row), migration queues on `messages` first,
//           then the writer touches `properties` => must NOT deadlock.
// The delay vs deadlock_timeout (1 s) decides who runs the detector first.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";

const CLI = process.env.SUPABASE_CLI ?? "/tmp/sb2109/node_modules/.bin/supabase";
const ORG = "00000000-0000-0000-0000-000000000bbb";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = async () => { const c = new pg.Client({ connectionString: SANDBOX.url }); await c.connect(); return c; };
const N = Number(process.env.RUNS ?? 12);
const XDELAYS = [0, 100, 300, 500, 700, 900, 1100, 1300, 1600, 2000, 2500, 3500];

async function onePush() {
  await assertSandboxTarget();
  const p = spawn(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  const done = new Promise((r) => p.on("close", (code) => r({ code, log })));
  return { done };
}
async function waitMigrationWaiting(obs, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { rows } = await obs.query("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%lock table public.messages, public.tasks%' and query not ilike '%pg_stat_activity%'");
    if (rows.length) return true;
    await sleep(20);
  }
  return false;
}
const results = [];
for (const order of ["X", "Y"]) {
  for (let i = 0; i < N; i++) {
    await assertSandboxTarget();
    execFileSync("node", ["scripts/filter-volume/revert-cache-migrations.mjs"], { stdio: "ignore" });
    const obs = await mk(); const t1 = await mk();
    const { rows: [{ id: P }] } = await obs.query("select id from public.properties where market = 'VOL' and not is_dnc_locked order by id limit 1 offset $1", [i]);
    const delay = order === "X" ? XDELAYS[i % XDELAYS.length] : [0, 200, 500, 800, 1200, 1600, 2000, 2500, 3000, 3500, 400, 1000][i % 12];
    const rec = { order, run: i + 1, delayMs: delay, writerError: null, migrationFailed: null, migrationLog: [], barrier: false };
    await t1.query("begin");
    if (order === "X") await t1.query("select id from public.properties where id = $1 for update", [P]);
    else await t1.query("insert into public.messages (org_id, property_id, channel, direction, body) values ($1,$2,'sms','inbound','y-probe')", [ORG, P]);
    const { done } = await onePush();
    rec.barrier = await waitMigrationWaiting(obs);
    await sleep(delay);
    try {
      if (order === "X") await t1.query("insert into public.messages (org_id, property_id, channel, direction, body) values ($1,$2,'sms','inbound','x-probe')", [ORG, P]);
      else { await t1.query("update public.properties set city = 'y-probe' where id = $1", [P]); await sleep(300); }
      await t1.query("commit");
    } catch (e) { rec.writerError = e.code; await t1.query("rollback").catch(() => {}); }
    const res = await done;
    rec.migrationFailed = res.code !== 0;
    rec.migrationLog = res.log.split("\n").filter((l) => /^ERROR:.*SQLSTATE|deadlock detected/i.test(l)).slice(0, 2).map((l) => l.trim());
    rec.victim = rec.writerError === "40P01" ? "writer" : rec.migrationFailed && /deadlock detected|SQLSTATE 40P01/.test(res.log) ? "migration" : rec.migrationFailed ? "migration(other:" + (/SQLSTATE 55P03/.test(res.log) ? "55P03" : "?") + ")" : "none";
    results.push(rec);
    console.log(JSON.stringify(rec));
    await obs.query("delete from public.messages where body in ('x-probe','y-probe')").catch(() => {});
    await obs.end(); await t1.end();
  }
}
const tally = (o) => results.filter((r) => r.order === o).reduce((m, r) => ((m[r.victim] = (m[r.victim] ?? 0) + 1), m), {});
const out = { cli: "2.109.1", X: tally("X"), Y: tally("Y"), results };
fs.writeFileSync("scripts/filter-volume/results/lock-order-forced.json", JSON.stringify(out, null, 2));
console.log("TALLY", JSON.stringify({ X: out.X, Y: out.Y }));
