/** Local-only P0 observations, not browser latency or a candidate acceptance result.
 * Run: node --conditions=react-server --import tsx scripts/inbox-p0-baseline.ts
 * Heavy modeled tiers: --conversations=55000 --allow-heavy (or 165000).
 * Each invocation creates a new isolated tenant; never resets existing data.
 * --browser-fixture --seed-only uses the existing EMPTY local BMH tenant and
 * writes private credentials under /tmp. It refuses populated tenants.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { validateInboxBaselineTarget } from "./lib/inbox-baseline-target.mjs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";
import { listThreadPage } from "../src/lib/messages/list-threads";
import { fetchInboxDetail } from "../src/app/(dashboard)/messages/inbox-detail-data";

const PROJECT = "sandra-inbox-redesign-20260913";
const RUNTIME = `/tmp/${PROJECT}/runtime.json`;
const args = process.argv.slice(2);
const browserFixture = args.includes("--browser-fixture");
const seedOnly = args.includes("--seed-only");
const count = Number(args.find(a => a.startsWith("--conversations="))?.split("=")[1] ?? 1000);
if (![1000, 55000, 165000].includes(count) || (count > 1000 && !args.includes("--allow-heavy"))) {
  throw new Error("Use 1000, or explicitly opt in to a modeled heavy tier (55000/165000).");
}
const runId = randomUUID();
const orgId = browserFixture ? "00000000-0000-0000-0000-000000000bbb" : randomUUID();
const output = browserFixture ? `/tmp/${PROJECT}/browser-fixture-evidence-${runId}.json`
  : `docs/performance/inbox-redesign/baseline-${new Date().toISOString().replace(/[:.]/g, "-")}-${count}.json`;
type Observation = { name: string; milliseconds: number[]; errors: string[]; p50?: number; p95?: number; p99?: number };
const observations: Observation[] = [];
const evidence: Record<string, unknown> = {
  runId, orgId, startedAt: new Date().toISOString(), requestedConversations: count,
  status: "started", observations,
  limitations: ["Modeled synthetic volume, not verified production distribution", "Local ordinary-user source read timings, not browser click latency",
    "Serial requests without concurrent arrivals; no performance budget pass claimed", "Percentiles from 20 repeats are descriptive, not tail-latency certification",
    "Fixtures retained in exclusively owned local stack; repeated runs increase total database size"],
};
let db: Client | undefined;
let phase = "target_guard";
const originalFetch = globalThis.fetch;

async function main() {
  const runtime = JSON.parse(await readFile(RUNTIME, "utf8")) as Record<string, string>;
  const target = validateInboxBaselineTarget(runtime.API_URL, runtime.DB_URL);
  const containers = JSON.parse(execFileSync("docker", ["--context", "colima-inbox-redesign-20260913", "inspect", `supabase_db_${PROJECT}`], { encoding: "utf8" }));
  const container = containers[0];
  if (container.Config.Labels["com.supabase.cli.project"] !== PROJECT
    || container.Config.Labels["com.supabase.cli.workdir"] !== `/tmp/${PROJECT}`
    || !container.NetworkSettings.Ports["5432/tcp"].some((p: { HostPort: string }) => p.HostPort === "58422")) {
    throw new Error("Dedicated project/container guard failed");
  }
  // All source reader/Supabase HTTP requests are restricted to this exact origin.
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== target.apiOrigin) throw new Error("Nonlocal HTTP request refused");
    return originalFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
  };
  db = new Client({ ...target.databaseConfig, connectionTimeoutMillis: 5000, statement_timeout: 15000, lock_timeout: 2000 });
  await db.connect();
  phase = "integration_guard";
  const outbound = await db.query(`select tgname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and pg_get_functiondef(p.oid) ~* '(net[.]http|http_post|http_get)'`);
  if (outbound.rows.length) throw new Error("Outbound trigger guard failed");
  const cronExists = (await db.query("select to_regclass('cron.job') as relation")).rows[0].relation;
  if (cronExists && (await db.query("select 1 from cron.job where active limit 1")).rowCount) throw new Error("Active DB cron jobs refused");
  const authConfig: string[] = (await db.query("select rolconfig from pg_roles where rolname='authenticated'")).rows[0].rolconfig ?? [];
  if (!authConfig.includes("statement_timeout=8s")) throw new Error("Expected bounded authenticated statement timeout missing");
  evidence.guards = { project: PROJECT, apiPort: 58421, databasePort: 58422, outboundTriggers: 0, activeCronJobs: 0, authenticatedStatementTimeout: "8s", seedStatementTimeout: "15s" };
  const admin = createClient<Database>(runtime.API_URL, runtime.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const user = createClient<Database>(runtime.API_URL, runtime.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  if (browserFixture) {
    phase = "empty_browser_tenant_guard";
    // Keep cooperating harnesses from passing the empty check concurrently.
    const locked = (await db.query("select pg_try_advisory_lock(hashtext('inbox-p0-browser-fixture')) as acquired")).rows[0].acquired;
    if (!locked) throw new Error("Another browser fixture writer is active");
    const existing = (await db.query("select id from organizations where id=$1", [orgId])).rowCount;
    if (existing !== 1) throw new Error("Expected existing local BMH organization missing");
    const counts = (await db.query(`select
      (select count(*)::int from contacts where org_id=$1) contacts,
      (select count(*)::int from properties where org_id=$1) properties,
      (select count(*)::int from messages where org_id=$1) messages`, [orgId])).rows[0];
    evidence.browserTenantInitialCounts = counts;
    if (Object.values(counts).some(value => value !== 0)) {
      console.log("Browser fixture refused: existing tenant counts", JSON.stringify(counts));
      throw new Error("Browser tenant is populated; no reset or reuse allowed");
    }
    evidence.limitations = [...evidence.limitations as string[],
      "Browser-compatible local domain/membership fixture, not genuine Hugo provisioning or production authentication"];
  }
  phase = "fixture_user";
  const password = randomUUID() + randomUUID();
  const domain = browserFixture ? "bmhgroupkc.com" : "example.invalid";
  const email = `inbox-p0-${runId}@${domain}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error("Synthetic auth user creation failed");
  const userId = created.data.user.id;
  const ownerEmail = `inbox-p0-owner-${runId}@${domain}`;
  const ownerPassword = randomUUID() + randomUUID();
  const owner = await admin.auth.admin.createUser({ email: ownerEmail, password: ownerPassword, email_confirm: true });
  if (owner.error || !owner.data.user) throw new Error("Synthetic owner creation failed");
  if (!browserFixture) await db.query("insert into organizations(id,name) values($1,$2)", [orgId, `Inbox P0 ${runId}`]);
  await db.query("insert into memberships(user_id,org_id,role) values($1,$2,'owner')", [owner.data.user.id, orgId]);
  await db.query("insert into memberships(user_id,org_id,role) values($1,$2,'member')", [userId, orgId]);
  const login = await user.auth.signInWithPassword({ email, password });
  if (login.error) throw new Error("Synthetic ordinary-user login failed");
  evidence.authRole = "member";
  phase = "fixture_seed";
  const seedStart = performance.now();
  for (let start = 1; start <= count; start += 250) {
    const end = Math.min(start + 249, count);
    await db.query("begin");
    try {
      await db.query(`insert into contacts(id,org_id,first_name,last_name,phone_1,phone_1_type)
        select md5($1||'/contact/'||i)::uuid,$2,'Synthetic','Inbox '||i,'+1999'||lpad(i::text,7,'0'),'mobile'
        from generate_series($3::int,$4::int) i`, [runId, orgId, start, end]);
      await db.query(`insert into properties(id,org_id,address,state,status,homeowner_contact_id,ai_responder_disabled)
        select md5($1||'/property/'||i)::uuid,$2,i||' Synthetic Baseline Way','MO','prospect',md5($1||'/contact/'||i)::uuid,true
        from generate_series($3::int,$4::int) i`, [runId, orgId, start, end]);
      await db.query(`insert into messages(org_id,contact_id,property_id,channel,direction,body,status,from_address,to_address,created_at)
        select $2,md5($1||'/contact/'||i)::uuid,md5($1||'/property/'||i)::uuid,'sms','inbound',
        'Synthetic baseline history '||j,'received','+1999'||lpad(i::text,7,'0'),'+19995550000',
        now() - (i % 60)*interval '1 day' - j*interval '1 minute'
        from generate_series($3::int,$4::int) i cross join generate_series(1,10) j`, [runId, orgId, start, end]);
      await db.query("commit");
    } catch (error) { await db.query("rollback"); throw error; }
    if (end % 1000 === 0) console.log(`Seeded ${end}/${count} synthetic conversations`);
  }
  // One unusually long conversation plus unrelated unknown-sender history.
  await db.query(`insert into messages(org_id,contact_id,property_id,channel,direction,body,status,from_address,to_address,created_at)
    select $2,md5($1||'/contact/1')::uuid,md5($1||'/property/1')::uuid,'sms','inbound','Synthetic long history '||j,
    'received','+19990000001','+19995550000',now()-j*interval '1 hour' from generate_series(1,500) j`, [runId, orgId]);
  await db.query(`insert into messages(org_id,channel,direction,body,status,from_address,to_address,created_at)
    select $1,'sms','inbound','Synthetic unknown '||j,'received','+19998880000','+19995550000',now()-j*interval '1 hour'
    from generate_series(1,250) j`, [orgId]);
  evidence.seedMilliseconds = performance.now() - seedStart;
  await db.query("analyze public.messages; analyze public.contacts; analyze public.properties; analyze public.message_threads");
  evidence.fixture = (await db.query(`select count(*)::int messages,count(distinct conversation_id)::int conversations,
    count(*) filter(where contact_id is null)::int unknown_messages from messages where org_id=$1`, [orgId])).rows[0];
  evidence.totalDatabaseMessages = (await db.query("select count(*)::int n from messages")).rows[0].n;
  if (browserFixture) {
    phase = "private_browser_credentials";
    await writeFile(`/tmp/${PROJECT}/browser-fixture.json`, JSON.stringify({
      runId, orgId, apiUrl: runtime.API_URL, email, password, userId,
      ownerEmail, ownerPassword, ownerUserId: owner.data.user.id,
      fixture: evidence.fixture, createdAt: new Date().toISOString(),
      authentication: "local synthetic users confirmed by admin; no email sent; not Hugo provisioning",
    }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  if (seedOnly) {
    evidence.status = "seeded_only";
    return;
  }
  const targets = (await db.query(`select conversation_id from messages where org_id=$1 and contact_id is not null
    group by conversation_id order by count(*) desc limit 2`, [orgId])).rows as { conversation_id: string }[];
  const measure = async (name: string, fn: () => Promise<void>) => {
    const observation: Observation = { name, milliseconds: [], errors: [] };
    observations.push(observation);
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      try { await fn(); observation.milliseconds.push(performance.now() - start); }
      catch { observation.errors.push(`sample_${i + 1}_failed`); if (observation.errors.length >= 3) break; }
    }
    const sorted = [...observation.milliseconds].sort((a,b) => a-b);
    for (const p of [50,95,99] as const) if (sorted.length) observation[`p${p}`] = sorted[Math.ceil(p / 100 * sorted.length)-1];
    console.log(`${name}: ${sorted.length} successful observations, ${observation.errors.length} errors`);
  };
  phase = "ordinary_user_reads";
  for (const [index,target] of targets.entries()) await measure(index === 0 ? "detail_long_history" : "detail_short_history", async () => {
    const detail = await fetchInboxDetail(user, target.conversation_id);
    if (!detail || detail.conversationId !== target.conversation_id) throw new Error("Incorrect detail identity");
  });
  await measure("list_first_page", async () => {
    const page = await listThreadPage(user, { filter: "all", currentUserId: userId, includeThreadId: null, hideNoise: true, page: 1 });
    if (!page.threads.length || page.degraded) throw new Error("Empty/degraded list");
  });
  evidence.status = observations.some(o => o.errors.length) ? "completed_with_errors" : "completed";
}

async function run() {
try { await main(); }
catch (error) {
  evidence.status = "failed";
  evidence.failedPhase = phase;
  // Never serialize arbitrary errors (connection strings, tokens, response bodies).
  evidence.errorType = error instanceof Error ? error.name : "UnknownError";
  evidence.errorCode = typeof error === "object" && error !== null && "code" in error ? String(error.code).slice(0,20) : null;
  console.error(`Baseline stopped during ${phase}; secret-safe evidence written.`);
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  if (db) await db.end();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(output);
}
}
void run();
