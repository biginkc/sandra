// Local-only (explicit private stack, identity-checked): runtime cost of the FULL refresh paths with and without 110055.
// For each schema state (B = 110000+110050, E2 = + 110055) measures, each in a rolled-back transaction on the same seed:
//  (1) refresh_property_filter_cache on 1/100/1000 properties (cache pre-corrupted so the refresh has to write; and a no-op refresh)
//  (2) single mark-read UPDATE of an inbound message  (3) bulk mark-read of 500 messages over 100 properties  (4) delete 100 messages
// and captures EXPLAIN-equivalent nested plans (auto_explain, log_nested_statements) for the 100-property refresh.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";

const CLI = process.env.SUPABASE_CLI; if (!CLI) throw new Error("Set SUPABASE_CLI");
const FP = "supabase/migrations/20261002110055_properties_filter_cache_fast_path.sql";
async function setState(state) {
  await assertSandboxTarget();
  execFileSync("node", ["scripts/filter-volume/revert-cache-migrations.mjs"], { stdio: "ignore" });
  if (state === "B") fs.renameSync(FP, FP + ".off");
  try {
    await assertSandboxTarget();
    const r = spawnSync(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("push failed " + r.stderr);
  } finally { if (fs.existsSync(FP + ".off")) fs.renameSync(FP + ".off", FP); }
  await execSql("analyze public.properties; analyze public.messages;");
}
const mk = async (user) => { const u = new URL(SANDBOX.url); if (user) u.username = user; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); return c; };
async function execSql(sql) { const c = await mk(); await c.query(sql); await c.end(); }
const out = {};
for (const state of ["B", "E2", "B", "E2"]) {
  await setState(state);
  const c = await mk();
  const res = {};
  const time = async (label, body) => {
    await c.query("begin");
    const t0 = performance.now();
    try { await body(); } finally { res[label] = Math.round((performance.now() - t0) * 10) / 10; await c.query("rollback"); }
  };
  const { rows: ids } = await c.query("select id from public.properties where market = 'VOL' order by id limit 1000");
  const all = ids.map((r) => r.id);
  for (const n of [1, 100, 1000]) {
    const sel = all.slice(0, n);
    await time(`refresh_${n}_dirty`, async () => {
      await c.query("select set_config('sandra.filter_cache_writer','on',true)");
      await c.query("update public.properties set has_inbound_message=false, has_outbound_message=false, has_unread_inbound=false, has_open_tasks=false, filter_list_ids='{}', filter_tag_ids='{}', filter_list_count=0 where id = any($1)", [sel]);
      await c.query("select set_config('sandra.filter_cache_writer','off',true)");
      const t = performance.now();
      await c.query("select public.refresh_property_filter_cache($1::uuid[])", [sel]);
      res[`refresh_${n}_dirty_refreshOnly`] = Math.round((performance.now() - t) * 10) / 10;
    });
    await time(`refresh_${n}_noop`, async () => { await c.query("select public.refresh_property_filter_cache($1::uuid[])", [sel]); });
  }
  const { rows: msgs } = await c.query(`select m.id, m.property_id from public.messages m join public.properties p on p.id = m.property_id
     where p.market='VOL' and m.direction='inbound' and m.read_at is null order by m.property_id limit 500`);
  const { rows: one } = await c.query("select id from public.messages where direction='inbound' and read_at is null limit 1");
  await time("markread_1", async () => { await c.query("update public.messages set read_at = now() where id = $1", [one[0].id]); });
  await time("markread_500_over_100props", async () => { await c.query("update public.messages set read_at = now() where id = any($1)", [msgs.map((m) => m.id)]); });
  const { rows: del } = await c.query("select id from public.messages m where property_id = any($1) limit 100", [all.slice(0, 100)]);
  await time("delete_100", async () => { await c.query("delete from public.messages where id = any($1)", [del.map((m) => m.id)]); });
  // nested plans for the 100-property refresh (superuser connection for auto_explain)
  const a = await mk("supabase_admin"); const notes = [];
  a.on("notice", (n) => notes.push(String(n.message)));
  await a.query("load 'auto_explain'");
  await a.query("set auto_explain.log_min_duration = 0; set auto_explain.log_nested_statements = on; set auto_explain.log_analyze = on; set auto_explain.log_buffers = on; set client_min_messages = log");
  await a.query("begin");
  await a.query("select set_config('sandra.filter_cache_writer','on',true)");
  await a.query("update public.properties set has_inbound_message=false, has_unread_inbound=false where id = any($1)", [all.slice(0, 100)]);
  await a.query("select set_config('sandra.filter_cache_writer','off',true)");
  notes.length = 0;
  await a.query("select public.refresh_property_filter_cache($1::uuid[])", [all.slice(0, 100)]);
  await a.query("rollback"); await a.end(); await c.end();
  (out[state] ??= []).push(res);
  fs.writeFileSync(`scripts/filter-volume/results/refresh-plan-${state}.txt`, notes.join("\n"));
  console.log(state, JSON.stringify(res));
}
fs.writeFileSync("scripts/filter-volume/results/refresh-perf.json", JSON.stringify(out, null, 2));
await setState("E2");
