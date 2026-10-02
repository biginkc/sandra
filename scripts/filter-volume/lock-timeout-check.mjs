// Local-only: prove the up-front LOCK in 20261002110000 fails cleanly under lock_timeout
// (instead of queueing behind a long transaction) and that the push is re-runnable.
import { spawn } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";

const CLI = process.env.SUPABASE_CLI ?? "/tmp/sb2109/node_modules/.bin/supabase";
const push = async () => {
  await assertSandboxTarget();
  const t = Date.now();
  const p = spawn(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR], { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; p.stdout.on("data", (d) => (log += d)); p.stderr.on("data", (d) => (log += d));
  const code = await new Promise((r) => p.on("close", r));
  return { code, ms: Date.now() - t, log };
};
const state = async (c) => ({
  recorded: (await c.query("select version from supabase_migrations.schema_migrations where version >= '20261002110000' order by 1")).rows.map((r) => r.version),
  cacheColumns: (await c.query("select count(*)::int n from information_schema.columns where table_schema='public' and table_name='properties' and column_name in ('has_inbound_message','filter_list_ids','filter_list_count')")).rows[0].n,
  refreshFn: (await c.query("select count(*)::int n from pg_proc where proname = 'refresh_property_filter_cache'")).rows[0].n,
});

await assertSandboxTarget();
const holder = new pg.Client({ connectionString: SANDBOX.url }); await holder.connect();
const obs = new pg.Client({ connectionString: SANDBOX.url }); await obs.connect();
const result = { cli: "2.109.1" };
await holder.query("begin");
await holder.query("lock table public.messages in row exclusive mode"); // a long-running writer's lock; blocks ACCESS EXCLUSIVE
const started = Date.now();
result.blocked = await push();
result.blocked.log = result.blocked.log.split("\n").filter((l) => /lock|timeout|ERROR|Applying|failed/i.test(l)).slice(0, 8);
result.holdMsBeforeRelease = Date.now() - started;
result.afterFailure = await state(obs);
await holder.query("rollback");
result.rerun = await push();
result.rerun.log = result.rerun.log.split("\n").filter((l) => /Applying|Finished|ERROR/.test(l)).slice(-4);
result.afterRerun = await state(obs);
console.log(JSON.stringify(result, null, 1));
fs.writeFileSync("scripts/filter-volume/results/lock-timeout-check.json", JSON.stringify(result, null, 2));
await holder.end(); await obs.end();
