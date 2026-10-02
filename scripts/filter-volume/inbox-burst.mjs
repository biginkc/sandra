// Local-only (55329 sandbox, identity-checked) A/B of the inbound persist path with and
// without the filter-cache triggers. Persist path reproduced per message as ONE transaction
// (src/lib/messaging/inbound.ts insertInboundMessage): dedupe lookup, messages insert (the
// fill-conversation trigger mints the thread), message_threads AI-state clear update.
// A = migrations reverted (== origin/main before 1088ac0c), B = 110000+110050 applied, C = B + 110055 variant C (share-lock skip), D = B + 110055 variant D (incremental update). FP_C / FP_D = paths of the two 110055 SQL variants.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";

const CLI = process.env.SUPABASE_CLI ?? "/tmp/sb2109/node_modules/.bin/supabase";
const REPS = Number(process.env.REPS ?? 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pool = new pg.Pool({ connectionString: SANDBOX.url, max: 70 });
const obs = new pg.Client({ connectionString: SANDBOX.url }); await obs.connect();

async function setState(state) {
  await assertSandboxTarget();
  execFileSync("node", ["scripts/filter-volume/revert-cache-migrations.mjs"], { stdio: "ignore" });
  if (state !== "A") {
    await assertSandboxTarget();
    const fp = "supabase/migrations/20261002110055_properties_filter_cache_fast_path.sql";
    if (state === "B") fs.renameSync(fp, fp + ".off");
    if (state === "C") fs.copyFileSync(process.env.FP_C, fp);
    if (state === "D") fs.copyFileSync(process.env.FP_D, fp);
    try {
      const r = spawnSync(CLI, ["db", "push", "--include-all", "--local", "--workdir", process.env.SBX_WORKDIR], { encoding: "utf8" });
      if (r.status !== 0) throw new Error("push failed " + r.stderr);
    } finally { if (fs.existsSync(fp + ".off")) fs.renameSync(fp + ".off", fp); }
  }
  const { rows } = await obs.query("select count(*)::int n from pg_trigger where tgname like 'zz_messages_filter_cache_%'");
  const fast = (await obs.query("select position('FOR SHARE' in upper(pg_get_functiondef('public.trg_messages_refresh_filter_cache'::regproc))) > 0 as f").catch(() => ({ rows: [{ f: false }] }))).rows[0].f;
  if (state === "A" ? rows[0].n !== 0 : rows[0].n !== 3 || fast !== (state === "C" || state === "D")) throw new Error("state mismatch " + state);
}
const { rows: props } = await obs.query(`select p.id, p.homeowner_contact_id cid from public.properties p
  where p.market = 'VOL' and p.homeowner_contact_id is not null and not p.is_dnc_locked order by p.id limit 400`);
let seq = 0;
async function persist(prop, tag) {
  const c = await pool.connect();
  const ext = `burst-${tag}-${Date.now()}-${++seq}`;
  const t0 = performance.now(); let tIns = 0, err = null;
  try {
    await c.query("begin");
    await c.query("select id, metadata, contact_id, property_id, conversation_id from public.messages where channel='sms' and direction='inbound' and provider='dialpad' and external_id=$1 limit 1", [ext]);
    const s = performance.now();
    const { rows: [m] } = await c.query(`insert into public.messages (channel, direction, status, provider, external_id, from_address, to_address, body, contact_id, property_id)
      values ('sms','inbound','received','dialpad',$1,'+18165550100','+18165550199','burst-probe',$2,$3) returning id, conversation_id`, [ext, prop.cid, prop.id]);
    tIns = performance.now() - s;
    await c.query("update public.message_threads set ai_responder_status=null, ai_responder_reason=null, ai_responder_status_at=null, ai_responder_message_id=null, ai_last_delivery_status=null, ai_last_delivery_error=null, updated_at=now() where conversation_id=$1", [m.conversation_id]);
    await c.query("commit");
  } catch (e) { err = e.code ?? String(e.message); await c.query("rollback").catch(() => {}); }
  finally { c.release(); }
  return { ms: performance.now() - t0, insMs: tIns, err };
}
async function sampler(stopRef, acc) {
  while (!stopRef.stop) {
    const { rows } = await obs.query(`select wait_event, left(query, 140) q from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'`);
    for (const r of rows) {
      const k = r.wait_event; acc[k] = (acc[k] ?? 0) + 1;
      if (/properties/i.test(r.q) && !/insert into public.messages/i.test(r.q)) acc.properties_refresh_waits = (acc.properties_refresh_waits ?? 0) + 1;
      if (/for no key update|refresh_property_filter_cache/i.test(r.q)) acc.row_lock_refresh = (acc.row_lock_refresh ?? 0) + 1;
    }
    acc.samples = (acc.samples ?? 0) + 1;
    await sleep(10);
  }
}
async function run(burst) {
  const acc = {}; const stopRef = { stop: false }; const sp = sampler(stopRef, acc);
  const tasks = [];
  const t0 = performance.now();
  if (burst === "same50") for (let i = 0; i < 50; i++) tasks.push(persist(props[0], burst));
  else if (burst === "diff50") for (let i = 0; i < 50; i++) tasks.push(persist(props[i + 1], burst));
  else for (let i = 0; i < 200; i++) {
    const at = Math.random() * 10000; const prop = Math.random() < 0.2 ? props[0] : props[1 + Math.floor(Math.random() * 300)];
    tasks.push(sleep(at).then(() => persist(prop, burst)));
  }
  const res = await Promise.all(tasks);
  stopRef.stop = true; await sp;
  await obs.query("delete from public.messages where body = 'burst-probe'");
  return { burst, wallMs: Math.round(performance.now() - t0), ms: res.map((r) => r.ms), insMs: res.map((r) => r.insMs), errors: res.filter((r) => r.err).map((r) => r.err), waits: acc };
}
const raw = [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const state of [["A", "B", "C", "D"], ["D", "C", "B", "A"], ["B", "D", "A", "C"], ["C", "A", "D", "B"], ["A", "D", "B", "C"]][(rep - 1) % 5]) {
    await setState(state);
    await obs.query("delete from public.messages where body = 'burst-probe'");
    for (const burst of ["same50", "diff50", "mixed200"]) {
      const r = await run(burst); r.state = state; r.rep = rep; raw.push(r);
      console.log(state, rep, burst, "p99", Math.round([...r.ms].sort((a, b) => a - b)[Math.ceil(0.99 * r.ms.length) - 1]), "errs", r.errors.length);
    }
  }
}
const tag = process.env.BURST_TAG ?? "run";
fs.writeFileSync(`scripts/filter-volume/results/inbox-burst-raw-${tag}.json`, JSON.stringify(raw));
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(1); };
const summary = {};
for (const state of ["A", "B", "C", "D"]) for (const burst of ["same50", "diff50", "mixed200"]) {
  const rs = raw.filter((r) => r.state === state && r.burst === burst); const all = rs.flatMap((r) => r.ms); const ins = rs.flatMap((r) => r.insMs);
  const w = {}; for (const r of rs) for (const [k, v] of Object.entries(r.waits)) w[k] = (w[k] ?? 0) + v;
  summary[`${state}/${burst}`] = { n: all.length, p50: pct(all, .5), p95: pct(all, .95), p99: pct(all, .99), max: pct(all, 1), insP99: pct(ins, .99), medianRunP99: pct(rs.map((r) => pct(r.ms, .99)), .5), errors: rs.reduce((n, r) => n + r.errors.length, 0), waitSamples10ms: w };
}
fs.writeFileSync(`scripts/filter-volume/results/inbox-burst-summary-${tag}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 1));
await setState("D"); await pool.end(); await obs.end();
