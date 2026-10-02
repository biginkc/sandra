// Local-only: the "seed then refresh in the SAME transaction" pattern (a Search-lane seed crawled after 110055).
// Inserts N properties + messages inside one transaction (triggers off for the bulk load), then calls
// refresh_property_filter_cache in 5000-id batches inside that same transaction, for states B and E2.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";
const CLI = process.env.SUPABASE_CLI; const FP = "supabase/migrations/20261002140000_properties_filter_cache_fast_path.sql";
const N = Number(process.env.N ?? 20000);
async function setState(state) {
  await assertSandboxTarget(); execFileSync("node", ["scripts/filter-volume/revert-cache-migrations.mjs"], { stdio: "ignore" });
  if (state === "B") fs.renameSync(FP, FP + ".off");
  try { const r = spawnSync(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); }
  finally { if (fs.existsSync(FP + ".off")) fs.renameSync(FP + ".off", FP); }
}
for (const state of ["B", "E2"]) {
  await setState(state);
  const c = new pg.Client({ connectionString: SANDBOX.url, statement_timeout: 0 }); await c.connect();
  await c.query("begin"); await c.query("set local session_replication_role = replica");
  await c.query("create temp table vp as select n, gen_random_uuid() id from generate_series(1, $1) n", [N]);
  await c.query("insert into public.properties (id, org_id, address, state, status, market) select id, '00000000-0000-0000-0000-000000000bbb', 'sx ' || n, 'MO', 'prospect', 'SEEDTX' from vp");
  await c.query("insert into public.messages (org_id, property_id, channel, direction, body, read_at) select '00000000-0000-0000-0000-000000000bbb', id, 'sms', case when n % 3 = 0 then 'inbound' else 'outbound' end, 'm', case when n % 6 = 0 then now() end from vp, generate_series(1, 4)");
  await c.query("set local session_replication_role = origin");
  const t0 = performance.now(); let batches = 0;
  const { rows } = await c.query("select array_agg(id) ids from (select id, (row_number() over (order by id) - 1) / 5000 g from vp) s group by g order by g");
  for (const r of rows) { const t = performance.now(); await c.query("select public.refresh_property_filter_cache($1::uuid[])", [r.ids]); batches++; if (performance.now() - t0 > 240000) { console.log(state, "ABORT after 240s, batches", batches); break; } }
  console.log(state, N, "properties,", batches, "batches refreshed in-tx:", Math.round(performance.now() - t0), "ms");
  await c.query("rollback"); await c.end();
}
