// Local-only: row-by-row message inserts WITH the cache triggers on, in one transaction and as autocommit, for states B and E2.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";
const CLI = process.env.SUPABASE_CLI; const FP = "supabase/migrations/20261004060000_properties_filter_cache_fast_path.sql";
async function setState(state) {
  await assertSandboxTarget(); execFileSync("node", ["scripts/filter-volume/revert-cache-migrations.mjs"], { stdio: "ignore" });
  if (state === "B") fs.renameSync(FP, FP + ".off");
  try { const r = spawnSync(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); }
  finally { if (fs.existsSync(FP + ".off")) fs.renameSync(FP + ".off", FP); }
}
const ORG = "00000000-0000-0000-0000-000000000bbb";
for (const state of ["B", "E2"]) {
  await setState(state);
  const c = new pg.Client({ connectionString: SANDBOX.url }); await c.connect();
  const { rows: ids } = await c.query("select id from public.properties where market='VOL' order by id limit 1500");
  for (const mode of ["one-tx", "autocommit"]) {
    const t0 = performance.now();
    if (mode === "one-tx") await c.query("begin");
    let n = 0;
    for (const p of ids) for (let k = 0; k < 4; k++) { await c.query("insert into public.messages (org_id, property_id, channel, direction, body, read_at) values ($1,$2,'sms',$3,'rw',$4)", [ORG, p.id, k % 2 ? "inbound" : "outbound", k === 3 ? new Date().toISOString() : null]); n++; }
    if (mode === "one-tx") await c.query("rollback"); else await c.query("delete from public.messages where body='rw'");
    console.log(state, mode, n, "inserts:", Math.round(performance.now() - t0), "ms =", Math.round((performance.now() - t0) / n * 100) / 100, "ms/insert");
  }
  await c.end();
}
await (async () => { await setState("E2"); })();
