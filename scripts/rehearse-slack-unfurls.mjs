#!/usr/bin/env node
/*
 * Rehearse the Slack foundation against a disposable PostgreSQL 17 cluster.
 * This never connects to the shared Supabase stack and removes the cluster
 * on exit, so CI and local runs exercise the real migration without shared
 * DDL locks or fixture mutations.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const postgresBin = process.env.SANDRA_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const cluster = mkdtempSync(join(tmpdir(), "sandra-slack-unfurl-"));
const socket = mkdtempSync(join(tmpdir(), "sandra-slack-unfurl-sock-"));
const port = 6200 + Math.floor(Math.random() * 300);
const migration = readFileSync(new URL("../supabase/migrations/20261003130001_slack_lead_unfurl_foundation.sql", import.meta.url), "utf8");
const bin = (name) => join(postgresBin, name);
const run = (name, args, input = "") => execFileSync(bin(name), args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const psql = (query) => run("psql", ["-h", socket, "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t"], query).replace(/^SET\n/, "").replace(/\r?\n$/, "");
const psqlAsync = (query) => new Promise((resolve, reject) => {
  const child = spawn(bin("psql"), ["-h", socket, "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t"]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => reject(Object.assign(error, { stdout, stderr })));
  child.on("close", (code) => code === 0
    ? resolve(stdout.replace(/^SET\n/, "").replace(/\r?\n$/, ""))
    : reject(Object.assign(new Error(`psql exited ${code}`), { stdout, stderr })));
  child.stdin.end(query);
});
const org = randomUUID();
const foreignOrg = randomUUID();
const user = randomUUID();
const member = randomUUID();
const property = randomUUID();
const foreignProperty = randomUUID();
const attemptLatest = randomUUID();
const attemptReached = randomUUID();
const team = "T_REHEARSAL";
const app = "A_REHEARSAL";

let started = false;
try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres", "--no-locale"]);
  run("pg_ctl", ["-D", cluster, "-l", join(cluster, "postgres.log"), "-o", `-k ${socket} -p ${port} -h ''`, "-w", "start"]);
  started = true;

  psql(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table public.organizations(id uuid primary key, name text not null);
    create table public.memberships(
      user_id uuid not null, org_id uuid not null, role text not null,
      access_status text, access_expires_at timestamptz, deletion_prepared_at timestamptz,
      primary key (user_id, org_id)
    );
    create table public.properties(id uuid primary key, org_id uuid not null, deleted_at timestamptz);
    create table public.acquisition_attempts(
      id uuid primary key, org_id uuid not null, property_id uuid not null,
      attempt_kind text not null, outcome text, occurred_at timestamptz not null
    );
  `);
  psql(migration);
  const privilege = psql("select has_function_privilege('service_role', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute'), has_function_privilege('authenticated', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute');").split("\t");
  if (privilege[0] !== "t" || privilege[1] !== "f") throw new Error("preview attempt facts RPC privileges are not narrowed");
  const tablePrivileges = psql("select has_table_privilege('service_role','public.slack_installations','select'), has_table_privilege('service_role','public.slack_account_links','select'), has_table_privilege('service_role','public.slack_channel_approvals','select'), has_table_privilege('service_role','public.memberships','select'), has_table_privilege('service_role','public.slack_unfurl_job_urls','update'), has_table_privilege('authenticated','public.slack_installations','select');").split("\t");
  if (tablePrivileges.join("\t") !== "t\tt\tt\tt\tt\tf") throw new Error("service role Slack table grants are not narrow and explicit");
  try { psql("set role authenticated; select count(*) from public.slack_installations;"); throw new Error("authenticated unexpectedly read Slack installations"); } catch (error) { if (!String(error).includes("permission denied")) throw error; }

  psql(`
    insert into auth.users(id) values ('${user}');
    insert into auth.users(id) values ('${member}');
    insert into public.organizations(id,name) values ('${org}','slack rehearsal'), ('${foreignOrg}','foreign');
    insert into public.memberships(user_id,org_id,role,access_status) values ('${user}','${org}','owner','active');
    insert into public.memberships(user_id,org_id,role,access_status) values ('${member}','${org}','member','active');
    insert into public.properties(id,org_id) values ('${property}','${org}'), ('${foreignProperty}','${foreignOrg}');
    insert into public.acquisition_attempts(id,org_id,property_id,attempt_kind,outcome,occurred_at)
      values ('${attemptLatest}','${org}','${property}','outreach','no_answer','2026-10-03T10:00:00Z'),
             ('${attemptReached}','${org}','${property}','call','reached','2026-10-03T09:00:00Z');
  `);
  const facts = psql(`set role service_role; select latest_attempt_id, latest_attempt_outcome, reached_call_id from public.get_slack_preview_attempt_facts('${org}','${property}');`).split("\t");
  if (facts[0] !== attemptLatest || facts[1] !== "no_answer" || facts[2] !== attemptReached) throw new Error("preview attempt facts RPC returned wrong scoped facts");
  psql(`update public.properties set deleted_at=now() where id='${property}';`);
  const deletedFacts = psql(`set role service_role; select latest_attempt_id, reached_call_id from public.get_slack_preview_attempt_facts('${org}','${property}');`);
  if (deletedFacts !== "\t") throw new Error("preview attempt facts RPC leaked a deleted property");
  const foreignFacts = psql(`set role service_role; select latest_attempt_id, reached_call_id from public.get_slack_preview_attempt_facts('${org}','${foreignProperty}');`);
  if (foreignFacts !== "\t") throw new Error("preview attempt facts RPC leaked a foreign property");
  psql(`update public.properties set deleted_at=null where id='${property}';`);

  const nonce = randomUUID();
  psql(`set role service_role; select public.create_slack_oauth_nonce('${nonce}','${user}','${org}',null,now()+interval '10 minutes');`);
  if (psql(`set role service_role; select public.consume_slack_oauth_nonce('${nonce}','${user}','${org}');`) !== "t") throw new Error("nonce first consume failed");
  if (psql(`set role service_role; select public.consume_slack_oauth_nonce('${nonce}','${user}','${org}');`) !== "f") throw new Error("nonce replay was accepted");

  const install = psql(`set role service_role; select installation_id, installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted',array['links:read','links:write','channels:read','groups:read','users:read'],'${user}','rehearsal-key');`).split("\t");
  if (install[1] !== "1") throw new Error("initial installation version mismatch");
  const relink = psql(`set role service_role; select installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-2',array['links:read'],'${user}','rehearsal-key');`);
  if (relink !== "1") throw new Error("ordinary relink rotated installation version");
  const linked = psql(`set role service_role; select installation_id, installation_version, account_link_id from public.upsert_slack_installation_and_account_link('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-3',array['links:read'],'${user}','${user}','U_REHEARSAL','rehearsal-key');`).split("\t");
  if (linked[1] !== "1" || !linked[2]) throw new Error("atomic installation/account link upsert failed");

  const approval = psql(`set role service_role; select public.approve_slack_channel('${install[0]}','${org}','C_REHEARSAL','${user}',true);`);
  if (!approval) throw new Error("channel approval failed");
  try { psql(`set role service_role; select public.approve_slack_channel('${install[0]}','${org}','C_MEMBER','${member}',true);`); throw new Error("member unexpectedly approved a channel"); } catch (error) { if (!String(error).includes("APPROVER_NOT_ACTIVE")) throw error; }
  psql(`set role service_role; select public.revoke_slack_installation('${team}','${app}','rehearsal');`);
  const staleEvent = randomUUID();
  try { psql(`set role service_role; select public.enqueue_slack_unfurl_event('${team}','${app}','${staleEvent}','link_shared',now(),'${org}','${install[0]}',1,'C_REHEARSAL','0.9','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`); throw new Error("revoked installation accepted an event"); } catch (error) { if (!String(error).includes("INSTALLATION_NOT_ACTIVE")) throw error; }
  if (psql(`set role service_role; select installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-4',array[]::text[],'${user}','rehearsal-key');`) !== "2") throw new Error("reinstall did not rotate installation version");

  const event = randomUUID();
  const enqueue = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${event}','link_shared',now(),'${org}','${linked[0]}',2,'C_REHEARSAL','1.1','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (!enqueue[0] || enqueue[1] !== "f") throw new Error("accepted enqueue did not create a job");
  const duplicate = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${event}','link_shared',now(),'${org}','${linked[0]}',2,'C_REHEARSAL','1.1','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (duplicate[1] !== "t" || duplicate[0] !== enqueue[0]) throw new Error("duplicate receipt was not durable/idempotent");
  psql(`set role service_role; update public.slack_unfurl_job_urls set lookup_status='queued' where job_id='${enqueue[0]}';`);

  psql("create function public.slack_rehearsal_fail() returns trigger language plpgsql as $$ begin raise exception 'injected_job_insert_failure'; end $$; create trigger slack_rehearsal_fail after insert on public.slack_unfurl_jobs for each row execute function public.slack_rehearsal_fail();");
  const failedEvent = randomUUID();
  let injectedFailure = "";
  try {
    psql(`set role service_role; select public.enqueue_slack_unfurl_event('${team}','${app}','${failedEvent}','link_shared',now(),'${org}','${linked[0]}',2,'C_REHEARSAL','1.2','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  } catch (error) {
    injectedFailure = `${String(error)}\n${error && typeof error === "object" && "stderr" in error ? String(error.stderr) : ""}`;
  }
  if (!injectedFailure.includes("injected_job_insert_failure")) throw new Error("atomic enqueue fault injection did not fail at the job insert");
  psql("drop trigger slack_rehearsal_fail on public.slack_unfurl_jobs; drop function public.slack_rehearsal_fail();");
  if (psql(`select count(*) from public.slack_event_receipts where team_id='${team}' and event_id='${failedEvent}';`) !== "0") throw new Error("receipt survived atomic enqueue failure");
  const recovered = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${failedEvent}','link_shared',now(),'${org}','${install[0]}',2,'C_REHEARSAL','1.2','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (!recovered[0] || recovered[1] !== "f") throw new Error("same event did not enqueue after injected failure was removed");

  psql(`set role service_role; select public.revoke_slack_installation('${team}','${app}','rehearsal-after-enqueue');`);
  if (psql(`select status from public.slack_unfurl_jobs where id='${enqueue[0]}';`) !== "cancelled") throw new Error("revocation did not cancel queued job");
  if (psql(`select status from public.slack_event_receipts where event_id='${event}';`) !== "revoked") throw new Error("revocation did not close event receipt");
  if (psql(`select status from public.slack_account_links where installation_id='${install[0]}' and slack_user_id='U_REHEARSAL';`) !== "revoked") throw new Error("revocation did not revoke account link");
  if (psql(`set role service_role; select installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-5',array['links:read','links:write','channels:read','groups:read','users:read'],'${user}','rehearsal-key');`) !== "3") throw new Error("second reinstall did not rotate installation version");
  const claimEvent = randomUUID();
  const claimJob = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${claimEvent}','link_shared',now(),'${org}','${install[0]}',3,'C_REHEARSAL','4.4','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  if (!claimJob) throw new Error("claim fixture enqueue failed");
  psql(`update public.slack_unfurl_jobs set max_attempts=1,attempts=1,status='processing',claim_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',next_attempt_at=now() where id='${claimJob}';`);
  if (psql("set role service_role; select count(*) from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,5);") !== "0") throw new Error("final-attempt lease was reclaimed");
  if (psql(`select status from public.slack_unfurl_jobs where id='${claimJob}';`) !== "failed") throw new Error("final-attempt lease was not closed");

  const liveEvent = randomUUID();
  const liveJob = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${liveEvent}','link_shared',now(),'${org}','${install[0]}',3,'C_REHEARSAL','5.5','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  if (!liveJob) throw new Error("live claim fixture enqueue failed");

  const parallelEvents = [randomUUID(), randomUUID()];
  for (const [index, parallelEvent] of parallelEvents.entries()) {
    const parallelJob = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${parallelEvent}','link_shared',now(),'${org}','${install[0]}',3,'C_REHEARSAL','${6 + index}.${index}','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
    if (!parallelJob) throw new Error("parallel claim fixture enqueue failed");
  }
  const parallelClaims = await Promise.all(parallelEvents.map(() => psqlAsync("set role service_role; select id,claim_token from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,1);")));
  const parallelRows = parallelClaims.map((row) => row.split("\t"));
  if (parallelRows.some((row) => row.length !== 2 && row.length !== 3) || parallelRows[0][0] === parallelRows[1][0]) throw new Error("parallel claims did not lease distinct jobs");
  for (const row of parallelRows) psql(`set role service_role; select public.finish_slack_unfurl_job('${row[0]}','${row[1]}','succeeded',null);`);

  const claim = psql("set role service_role; select id, claim_token, attempts from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,5);").split("\t");
  if (claim.length !== 3 || claim[2] !== "1") throw new Error("claim did not lease one job");
  if (psql("set role service_role; select count(*) from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,5);") !== "0") throw new Error("second live claim was not skipped");
  if (psql(`set role service_role; select public.finish_slack_unfurl_job('${claim[0]}',gen_random_uuid(),'succeeded',null);`) !== "f") throw new Error("stale claim token was accepted");
  if (psql(`set role service_role; select public.finish_slack_unfurl_job('${claim[0]}','${claim[1]}','succeeded',null);`) !== "t") throw new Error("valid claim token completion failed");
  psql(`update public.slack_unfurl_jobs set status='processing',claim_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second',next_attempt_at=now() where id='${claim[0]}';`);
  const reclaimed = psql("set role service_role; select id,claim_token from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,5);").split("\t");
  if (reclaimed.length !== 2 || !reclaimed[1]) throw new Error("abandoned lease was not reclaimed");
  psql(`set role service_role; select public.finish_slack_unfurl_job('${reclaimed[0]}','${reclaimed[1]}','succeeded',null);`);

  const releaseEvent = randomUUID();
  const releaseJob = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${releaseEvent}','link_shared',now(),'${org}','${install[0]}',3,'C_REHEARSAL','4.0','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  const releaseToken = randomUUID();
  psql(`update public.slack_unfurl_jobs set attempts=1,status='processing',claim_token='${releaseToken}',lease_expires_at=now()+interval '1 minute' where id='${releaseJob}';`);
  if (psql(`set role service_role; select public.release_slack_unfurl_job_claim('${releaseJob}','${releaseToken}');`) !== "t") throw new Error("never-started claim release failed");
  if (psql(`select status,attempts from public.slack_unfurl_jobs where id='${releaseJob}';`) !== "queued\t0") throw new Error("released claim did not refund its attempt");

  psql(`update public.slack_event_receipts set created_at=now()-interval '8 days' where team_id='${team}' and event_id='${event}';`);
  if (psql("set role service_role; select public.cleanup_slack_unfurl_data(now()-interval '7 days');") === "0") throw new Error("seven-day cleanup did not remove receipt");
  console.log("Slack unfurl rehearsal passed: disposable PG17, narrowed facts RPC, nonce, atomic install/link, approval, installation version, enqueue/dedupe, fencing, reclaim and cleanup");
} finally {
  if (started) run("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"]);
  rmSync(socket, { recursive: true, force: true });
  rmSync(cluster, { recursive: true, force: true });
}
