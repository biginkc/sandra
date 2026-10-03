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
const policyMigration = readFileSync(new URL("../supabase/migrations/20261003160000_slack_workspace_preview_policy.sql", import.meta.url), "utf8");
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
const errorText = (error) => `${String(error)} ${error && typeof error === "object" && "stderr" in error ? String(error.stderr) : ""}`;
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
  psql(policyMigration);
  const privilege = psql("select has_function_privilege('service_role', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute'), has_function_privilege('authenticated', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute'), has_function_privilege('service_role', 'public.guard_slack_unfurl_dispatch(uuid,uuid,uuid,integer,uuid,text,text)', 'execute'), has_function_privilege('authenticated', 'public.guard_slack_unfurl_dispatch(uuid,uuid,uuid,integer,uuid,text,text)', 'execute'), has_function_privilege('service_role', 'public.revoke_slack_installation_generation(text,text,uuid,integer,text)', 'execute'), has_function_privilege('authenticated', 'public.revoke_slack_installation_generation(text,text,uuid,integer,text)', 'execute');").split("\t");
  if (privilege.join("\t") !== "t\tf\tt\tf\tt\tf") throw new Error("Slack operational RPC privileges are not narrowed");
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
  try { psql(`set role service_role; select public.set_slack_preview_policy('${install[0]}','${org}','${user}',true);`); throw new Error("missing Slack scopes unexpectedly enabled policy"); } catch (error) { if (!errorText(error).includes("INSTALLATION_SCOPE_MISSING")) throw error; }
  psql(`update public.slack_installations set scopes=array['links:read','links:write','channels:read','groups:read','users:read'] where id='${install[0]}';`);
  try { psql(`set role service_role; select public.set_slack_preview_policy('${install[0]}','${org}','${member}',true);`); throw new Error("member unexpectedly enabled policy"); } catch (error) { if (!errorText(error).includes("OWNER_NOT_ACTIVE")) throw error; }
  try { psql(`set role service_role; select public.set_slack_preview_policy('${install[0]}','${foreignOrg}','${user}',true);`); throw new Error("cross-org policy unexpectedly enabled"); } catch (error) { if (!errorText(error).includes("INSTALLATION_NOT_ACTIVE")) throw error; }

  const approval = psql(`set role service_role; select public.approve_slack_channel('${install[0]}','${org}','C_REHEARSAL','${user}',true);`);
  if (!approval) throw new Error("channel approval failed");
  try { psql(`set role service_role; select public.approve_slack_channel('${install[0]}','${org}','C_MEMBER','${member}',true);`); throw new Error("member unexpectedly approved a channel"); } catch (error) { if (!String(error).includes("APPROVER_NOT_ACTIVE")) throw error; }
  psql(`set role service_role; select public.revoke_slack_installation('${team}','${app}','rehearsal');`);
  const staleEvent = randomUUID();
  try { psql(`set role service_role; select public.enqueue_slack_unfurl_event('${team}','${app}','${staleEvent}','link_shared',now(),'${org}','${install[0]}',1,'C_REHEARSAL','0.9','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`); throw new Error("revoked installation accepted an event"); } catch (error) { if (!String(error).includes("INSTALLATION_NOT_ACTIVE")) throw error; }
  if (psql(`set role service_role; select installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-4',array['links:read','links:write','channels:read','groups:read','users:read'],'${user}','rehearsal-key');`) !== "2") throw new Error("reinstall did not rotate installation version");
  if (psql(`set role service_role; select mode from public.set_slack_preview_policy('${install[0]}','${org}','${user}',true);`) !== "eligible_internal_channels") throw new Error("workspace policy did not enable");
  psql(`update public.slack_installations set scopes=array['links:read'] where id='${install[0]}';`);
  if (psql(`set role service_role; select mode from public.set_slack_preview_policy('${install[0]}','${org}','${user}',false);`) !== "disabled") throw new Error("policy disable failed after scope loss");
  psql(`update public.slack_installations set scopes=array['links:read','links:write','channels:read','groups:read','users:read'] where id='${install[0]}';`);
  if (psql(`set role service_role; select mode from public.set_slack_preview_policy('${install[0]}','${org}','${user}',true);`) !== "eligible_internal_channels") throw new Error("workspace policy did not restore after scope loss");
  const stalePolicyEvent = randomUUID();
  const stalePolicy = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${stalePolicyEvent}','link_shared',now()-interval '2 minutes','${org}','${install[0]}',2,'C_AUTO','1.0','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  if (stalePolicy || psql(`select denial_code from public.slack_event_receipts where event_id='${stalePolicyEvent}';`) !== "event_before_policy") throw new Error("pre-policy event was accepted after enable");

  const event = randomUUID();
  const enqueue = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${event}','link_shared',now(),'${org}','${linked[0]}',2,'C_AUTO','1.1','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (!enqueue[0] || enqueue[1] !== "f") throw new Error("accepted enqueue did not create a job");
  const duplicate = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${event}','link_shared',now(),'${org}','${linked[0]}',2,'C_AUTO','1.1','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (duplicate[1] !== "t" || duplicate[0] !== enqueue[0]) throw new Error("duplicate receipt was not durable/idempotent");
  psql(`set role service_role; update public.slack_unfurl_job_urls set lookup_status='queued' where job_id='${enqueue[0]}';`);

  psql("create function public.slack_rehearsal_fail() returns trigger language plpgsql as $$ begin raise exception 'injected_job_insert_failure'; end $$; create trigger slack_rehearsal_fail after insert on public.slack_unfurl_jobs for each row execute function public.slack_rehearsal_fail();");
  const failedEvent = randomUUID();
  let injectedFailure = "";
  try {
    psql(`set role service_role; select public.enqueue_slack_unfurl_event('${team}','${app}','${failedEvent}','link_shared',now(),'${org}','${linked[0]}',2,'C_AUTO','1.2','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  } catch (error) {
    injectedFailure = `${String(error)}\n${error && typeof error === "object" && "stderr" in error ? String(error.stderr) : ""}`;
  }
  if (!injectedFailure.includes("injected_job_insert_failure")) throw new Error("atomic enqueue fault injection did not fail at the job insert");
  psql("drop trigger slack_rehearsal_fail on public.slack_unfurl_jobs; drop function public.slack_rehearsal_fail();");
  if (psql(`select count(*) from public.slack_event_receipts where team_id='${team}' and event_id='${failedEvent}';`) !== "0") throw new Error("receipt survived atomic enqueue failure");
  const recovered = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${failedEvent}','link_shared',now(),'${org}','${install[0]}',2,'C_AUTO','1.2','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (!recovered[0] || recovered[1] !== "f") throw new Error("same event did not enqueue after injected failure was removed");
  if (psql(`set role service_role; select mode from public.set_slack_preview_policy('${install[0]}','${org}','${user}',false);`) !== "disabled") throw new Error("workspace policy did not disable");
  if (psql(`select status from public.slack_unfurl_jobs where id='${enqueue[0]}';`) !== "cancelled") throw new Error("policy disable did not cancel queued job");
  const disabledEvent = randomUUID();
  const disabledResult = psql(`set role service_role; select job_id, duplicate from public.enqueue_slack_unfurl_event('${team}','${app}','${disabledEvent}','link_shared',now(),'${org}','${install[0]}',2,'C_AUTO','1.25','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`).split("\t");
  if (disabledResult[0] || psql(`select denial_code from public.slack_event_receipts where event_id='${disabledEvent}';`) !== "previews_disabled") throw new Error("disabled policy accepted preview work");
  if (psql(`set role service_role; select mode from public.set_slack_preview_policy('${install[0]}','${org}','${user}',true);`) !== "eligible_internal_channels") throw new Error("workspace policy did not re-enable");

  psql(`set role service_role; select public.revoke_slack_installation('${team}','${app}','rehearsal-after-enqueue');`);
  if (psql(`select status from public.slack_unfurl_jobs where id='${enqueue[0]}';`) !== "cancelled") throw new Error("revocation did not cancel queued job");
  if (!["cancelled", "revoked"].includes(psql(`select status from public.slack_event_receipts where event_id='${event}';`))) throw new Error("revocation did not close event receipt");
  if (psql(`select status from public.slack_account_links where installation_id='${install[0]}' and slack_user_id='U_REHEARSAL';`) !== "revoked") throw new Error("revocation did not revoke account link");
  if (psql(`set role service_role; select installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-5',array['links:read','links:write','channels:read','groups:read','users:read'],'${user}','rehearsal-key');`) !== "3") throw new Error("second reinstall did not rotate installation version");
  if (psql(`set role service_role; select mode from public.set_slack_preview_policy('${install[0]}','${org}','${user}',true);`) !== "eligible_internal_channels") throw new Error("workspace policy did not re-enable");
  psql(`set role service_role; select public.upsert_slack_account_link('${install[0]}','${org}','${user}','U_REHEARSAL');`);
  psql(`set role service_role; select public.upsert_slack_account_link('${install[0]}','${org}','${member}','U_MEMBER');`);
  psql(`set role service_role; select public.approve_slack_channel('${install[0]}','${org}','C_REHEARSAL','${user}',true);`);
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
  psql(`update public.slack_unfurl_jobs set poster_slack_user_id='U_MEMBER' where id='${claim[0]}';`);
  const guardArgs = `'${claim[0]}','${claim[1]}','${install[0]}',3,'${org}','C_REHEARSAL','U_MEMBER'`;
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "t") throw new Error("active dispatch guard rejected valid claim");
  psql(`update public.slack_unfurl_jobs set lease_expires_at=now()-interval '1 second' where id='${claim[0]}';`);
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "f") throw new Error("dispatch guard accepted expired lease");
  psql(`update public.slack_unfurl_jobs set lease_expires_at=now()+interval '1 minute',expires_at=now()-interval '1 second' where id='${claim[0]}';`);
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "f") throw new Error("dispatch guard accepted expired event");
  psql(`update public.slack_unfurl_jobs set expires_at=now()+interval '15 minutes',lease_expires_at=now()+interval '1 minute' where id='${claim[0]}';`);
  psql(`update public.slack_channel_approvals set status='revoked',revoked_at=now() where installation_id='${install[0]}' and channel_id='C_REHEARSAL';`);
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "t") throw new Error("workspace policy treated a revoked legacy approval as a denial");
  psql(`update public.slack_channel_approvals set status='active',revoked_at=null where installation_id='${install[0]}' and channel_id='C_REHEARSAL';`);
  psql(`update public.memberships set access_status='revoked' where user_id='${member}' and org_id='${org}';`);
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "f") throw new Error("dispatch guard accepted revoked membership");
  psql(`update public.memberships set access_status='active' where user_id='${member}' and org_id='${org}';`);
  psql(`update public.slack_account_links set status='revoked',revoked_at=now() where installation_id='${install[0]}' and slack_user_id='U_MEMBER';`);
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "f") throw new Error("dispatch guard accepted revoked account link");
  psql(`update public.slack_account_links set status='active',revoked_at=null where installation_id='${install[0]}' and slack_user_id='U_MEMBER';`);
  psql(`update public.slack_installations set installation_version=4 where id='${install[0]}';`);
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${guardArgs});`) !== "f") throw new Error("dispatch guard accepted changed installation version");
  psql(`update public.slack_installations set installation_version=3 where id='${install[0]}';`);
  if (psql("set role service_role; select count(*) from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,5);") !== "0") throw new Error("second live claim was not skipped");
  if (psql(`set role service_role; select public.finish_slack_unfurl_job('${claim[0]}',gen_random_uuid(),'succeeded',null);`) !== "f") throw new Error("stale claim token was accepted");
  if (psql(`set role service_role; select public.finish_slack_unfurl_job('${claim[0]}','${claim[1]}','succeeded',null);`) !== "t") throw new Error("valid claim token completion failed");
  const staleReclaimToken = randomUUID();
  psql(`update public.slack_unfurl_jobs set status='processing',claim_token='${staleReclaimToken}',lease_expires_at=now()-interval '1 second',next_attempt_at=now() where id='${claim[0]}';`);
  const reclaimed = psql("set role service_role; select id,claim_token from public.claim_slack_unfurl_jobs(now(),gen_random_uuid(),90,5);").split("\t");
  if (reclaimed.length !== 2 || !reclaimed[1]) throw new Error("abandoned lease was not reclaimed");
  const staleGuardArgs = `'${claim[0]}','${staleReclaimToken}','${install[0]}',3,'${org}','C_REHEARSAL','U_MEMBER'`;
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${staleGuardArgs});`) !== "f") throw new Error("dispatch guard accepted reclaimed claim token");
  const reclaimedGuardArgs = `'${reclaimed[0]}','${reclaimed[1]}','${install[0]}',3,'${org}','C_REHEARSAL','U_MEMBER'`;
  if (psql(`set role service_role; select public.guard_slack_unfurl_dispatch(${reclaimedGuardArgs});`) !== "t") throw new Error("dispatch guard rejected reclaimed active claim");
  psql(`set role service_role; select public.finish_slack_unfurl_job('${reclaimed[0]}','${reclaimed[1]}','succeeded',null);`);

  const releaseEvent = randomUUID();
  const releaseJob = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${releaseEvent}','link_shared',now(),'${org}','${install[0]}',3,'C_REHEARSAL','4.0','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  const releaseToken = randomUUID();
  psql(`update public.slack_unfurl_jobs set attempts=1,status='processing',claim_token='${releaseToken}',lease_expires_at=now()+interval '1 minute' where id='${releaseJob}';`);
  if (psql(`set role service_role; select public.release_slack_unfurl_job_claim('${releaseJob}','${releaseToken}');`) !== "t") throw new Error("never-started claim release failed");
  if (psql(`select status,attempts from public.slack_unfurl_jobs where id='${releaseJob}';`) !== "queued\t0") throw new Error("released claim did not refund its attempt");

  // A late v1 token error must not revoke the active v3 reinstall. The
  // generation-fenced RPC returns zero for stale v2 and revokes only v3 for
  // the matching call.
  psql(`set role service_role; select public.upsert_slack_account_link('${install[0]}','${org}','${user}','U_REHEARSAL');`);
  psql(`set role service_role; select public.approve_slack_channel('${install[0]}','${org}','C_REHEARSAL','${user}',true);`);
  const generationEvent = randomUUID();
  const generationJob = psql(`set role service_role; select job_id from public.enqueue_slack_unfurl_event('${team}','${app}','${generationEvent}','link_shared',now(),'${org}','${install[0]}',3,'C_REHEARSAL','4.5','U_REHEARSAL',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null);`);
  if (psql(`set role service_role; select public.revoke_slack_installation_generation('${team}','${app}','${install[0]}',2,'invalid_auth');`) !== "0") throw new Error("stale generation unexpectedly revoked current installation");
  if (psql(`select status from public.slack_installations where id='${install[0]}';`) !== "active") throw new Error("stale generation revoked the active reinstall");
  if (psql(`select status from public.slack_unfurl_jobs where id='${generationJob}';`) !== "queued") throw new Error("stale generation cancelled a current job");
  if (psql(`set role service_role; select public.revoke_slack_installation_generation('${team}','${app}','${install[0]}',3,'invalid_auth');`) !== "1") throw new Error("matching generation did not revoke installation");
  if (psql(`select status from public.slack_installations where id='${install[0]}';`) !== "revoked") throw new Error("matching generation left installation active");
  if (psql(`select status from public.slack_account_links where installation_id='${install[0]}' and slack_user_id='U_REHEARSAL';`) !== "revoked") throw new Error("matching generation did not revoke link");
  if (psql(`select status from public.slack_channel_approvals where installation_id='${install[0]}' and channel_id='C_REHEARSAL';`) !== "revoked") throw new Error("matching generation did not revoke approval");
  if (psql(`select status from public.slack_unfurl_jobs where id='${generationJob}';`) !== "cancelled") throw new Error("matching generation did not cancel job");
  if (psql(`select status from public.slack_event_receipts where id=(select receipt_id from public.slack_unfurl_jobs where id='${generationJob}');`) !== "revoked") throw new Error("matching generation did not close receipt");

  const lifecycleEvent = randomUUID();
  if (psql(`set role service_role; select public.process_slack_lifecycle_event('${team}','${app}','${lifecycleEvent}','app_uninstalled',now(),null,array[]::text[],'installation');`) !== "t") throw new Error("lifecycle event was not applied");
  if (psql(`select status from public.slack_installations where id='${install[0]}';`) !== "revoked") throw new Error("lifecycle event did not revoke installation");
  if (psql(`set role service_role; select installation_version from public.upsert_slack_installation('${org}','${team}','${app}','Rehearsal','B_REHEARSAL','xoxb-redacted-6',array[]::text[],'${user}','rehearsal-key');`) !== "4") throw new Error("lifecycle reconnect did not rotate version");
  if (psql(`set role service_role; select public.process_slack_lifecycle_event('${team}','${app}','${lifecycleEvent}','app_uninstalled',now(),null,array[]::text[],'installation');`) !== "f") throw new Error("duplicate lifecycle delivery was reapplied");
  if (psql(`select status from public.slack_installations where id='${install[0]}';`) !== "active") throw new Error("duplicate lifecycle delivery revoked the reconnected installation");

  psql(`update public.slack_event_receipts set created_at=now()-interval '8 days' where team_id='${team}' and event_id='${event}';`);
  if (psql("set role service_role; select public.cleanup_slack_unfurl_data(now()-interval '7 days');") === "0") throw new Error("seven-day cleanup did not remove receipt");
  console.log("Slack unfurl rehearsal passed: disposable PG17, narrowed facts RPC, nonce, atomic install/link, approval, installation version, enqueue/dedupe, fencing, reclaim and cleanup");
} finally {
  if (started) run("pg_ctl", ["-D", cluster, "-m", "immediate", "-w", "stop"]);
  rmSync(socket, { recursive: true, force: true });
  rmSync(cluster, { recursive: true, force: true });
}
