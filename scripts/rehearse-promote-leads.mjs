#!/usr/bin/env node
// Applies the real promotion migration twice to a disposable, host-only
// PostgreSQL cluster, then exercises tenant, replay, DNC-race, concurrency,
// membership-expiry, startup-failure, and retry invariants. No hosted database.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cluster = mkdtempSync(join(tmpdir(), "sandra-promote-leads-"));
const socketDir = mkdtempSync("/tmp/splsock-");
const port = 6480 + Math.floor(Math.random() * 300);
const migration = fileURLToPath(
  new URL("../supabase/migrations/20260815230000_promote_leads_jobs.sql", import.meta.url),
);
let started = false;

function run(name, args, options = {}) {
  return execFileSync(name, args, { stdio: "inherit", ...options });
}

function psql(sql, { quiet = true } = {}) {
  return execFileSync(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    { encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" },
  ).trim();
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
      { encoding: "utf8" },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim())),
    );
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const orgA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const userA = "11111111-1111-1111-1111-111111111111";
const userB = "22222222-2222-2222-2222-222222222222";
const ids = {
  eligible: "10000000-0000-0000-0000-000000000001",
  locked: "10000000-0000-0000-0000-000000000002",
  lead: "10000000-0000-0000-0000-000000000003",
  lateLock: "10000000-0000-0000-0000-000000000004",
  race: "10000000-0000-0000-0000-000000000005",
  startup: "10000000-0000-0000-0000-000000000006",
  expired: "10000000-0000-0000-0000-000000000007",
  wrongOrgItem: "10000000-0000-0000-0000-000000000008",
  hardDelete: "10000000-0000-0000-0000-000000000009",
  workflowFail: "10000000-0000-0000-0000-000000000010",
  concurrentDelete: "10000000-0000-0000-0000-000000000011",
  hardDeleteItemFail: "10000000-0000-0000-0000-000000000012",
  hardDeleteWorkflowFail: "10000000-0000-0000-0000-000000000013",
  hardDeleteStartFail: "10000000-0000-0000-0000-000000000014",
  hardDeleteAfterFail: "10000000-0000-0000-0000-000000000015",
  otherOrg: "20000000-0000-0000-0000-000000000001",
};

const authA = `select set_config('request.jwt.claim.sub','${userA}',false); select set_config('request.jwt.claim.role','authenticated',false);`;
const service = "select set_config('request.jwt.claim.role','service_role',false);";

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres"], {
    stdio: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  run("pg_ctl", ["-D", cluster, "-o", `-p ${port} -k ${socketDir}`, "-l", join(cluster, "server.log"), "start"], {
    stdio: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  started = true;

  psql(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;

    create table public.organizations (id uuid primary key);
    create table public.memberships (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, org_id uuid not null,
      role text not null default 'member', access_status text not null default 'active',
      deletion_prepared_at timestamptz, access_expires_at timestamptz,
      unique(user_id, org_id)
    );
    create table public.properties (
      id uuid primary key, org_id uuid not null, status text not null default 'prospect',
      is_dnc_locked boolean not null default false, deleted_at timestamptz,
      qualified_at timestamptz, qualified_by text, updated_at timestamptz not null default now()
    );
    create table public.jobs (
      id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(),
      created_by uuid, type text not null constraint jobs_type_check check (type in ('csv_import','csv_update')),
      status text not null default 'queued' check (status in ('queued','running','completed','failed','partial','partially_completed','canceled')),
      total_items int not null default 0, processed_items int not null default 0,
      succeeded_items int not null default 0, failed_items int not null default 0,
      started_at timestamptz, completed_at timestamptz, worker_heartbeat_at timestamptz,
      retry_count int not null default 0, max_retries int not null default 3,
      error_class text, parent_job_id uuid references public.jobs(id), related_import_id uuid,
      provider text, provider_run_id text, provider_webhook_secret text,
      input_params jsonb, result_summary jsonb, error_message text, title text, description text
    );
    create table public.job_items (
      id uuid primary key default gen_random_uuid(), job_id uuid not null references public.jobs(id) on delete cascade,
      property_id uuid references public.properties(id) on delete cascade, contact_id uuid, message_id uuid,
      status text not null default 'pending' check (status in ('pending','success','no_match','error','skipped')),
      input_payload jsonb, output_payload jsonb, error_message text, error_class text,
      retry_count int not null default 0, processed_at timestamptz,
      source_row_index int, compliance_locked boolean not null default false
    );
    insert into public.organizations values ('${orgA}'), ('${orgB}');
    insert into public.memberships(user_id,org_id) values ('${userA}','${orgA}'), ('${userB}','${orgB}');
    insert into public.properties(id,org_id,status,is_dnc_locked) values
      ('${ids.eligible}','${orgA}','prospect',false),
      ('${ids.locked}','${orgA}','prospect',true),
      ('${ids.lead}','${orgA}','new_lead',false),
      ('${ids.lateLock}','${orgA}','prospect',false),
      ('${ids.race}','${orgA}','prospect',false),
      ('${ids.startup}','${orgA}','prospect',false),
      ('${ids.expired}','${orgA}','prospect',false),
      ('${ids.wrongOrgItem}','${orgA}','prospect',false),
      ('${ids.hardDelete}','${orgA}','prospect',false),
      ('${ids.workflowFail}','${orgA}','prospect',false),
      ('${ids.concurrentDelete}','${orgA}','prospect',false),
      ('${ids.hardDeleteItemFail}','${orgA}','prospect',false),
      ('${ids.hardDeleteWorkflowFail}','${orgA}','prospect',false),
      ('${ids.hardDeleteStartFail}','${orgA}','prospect',false),
      ('${ids.hardDeleteAfterFail}','${orgA}','prospect',false),
      ('${ids.otherOrg}','${orgB}','prospect',false);
  `);

  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration], { stdio: "ignore" });
  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration], { stdio: "ignore" });

  const requestKey = "30000000-0000-0000-0000-000000000001";
  const request = psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.eligible}','${ids.eligible}','${ids.locked}','${ids.lead}']::uuid[], '${requestKey}');`);
  const requestJson = JSON.parse(request.split("\n").at(-1));
  assertEqual(requestJson.duplicate, false, "first request is not replay");
  assertEqual(psql(`select total_items||':'||processed_items from jobs where id='${requestJson.job_id}'`), "3:2", "dedup and initial checkpoints");
  assertEqual(psql(`select (result_summary->>'dnc_locked')||':'||(result_summary->>'already_lead') from jobs where id='${requestJson.job_id}'`), "1:1", "initial outcomes");

  const replay = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.lead}','${ids.locked}','${ids.eligible}']::uuid[], '${requestKey}');`).split("\n").at(-1));
  assertEqual(replay.job_id, requestJson.job_id, "request replay job identity");
  assertEqual(replay.duplicate, true, "request replay marker");

  let mixedRejected = false;
  try {
    psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.eligible}','${ids.otherOrg}']::uuid[], '30000000-0000-0000-0000-000000000002');`);
  } catch (error) {
    mixedRejected = /unavailable/.test(String(error));
  }
  assertEqual(mixedRejected, true, "mixed tenant request rejected");

  psql(`${service} update jobs set status='running' where id='${requestJson.job_id}'; select public.process_promote_leads_item('${requestJson.job_id}','${ids.eligible}');`);
  assertEqual(psql(`select status||':'||(result_summary->>'promoted') from jobs where id='${requestJson.job_id}'`), "completed:1", "successful terminal result");

  const lateKey = "30000000-0000-0000-0000-000000000003";
  const lateJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.lateLock}']::uuid[], '${lateKey}');`).split("\n").at(-1)).job_id;
  psql(`update properties set is_dnc_locked=true where id='${ids.lateLock}'; update jobs set status='running' where id='${lateJob}';`);
  psql(`${service} select public.process_promote_leads_item('${lateJob}','${ids.lateLock}');`);
  assertEqual(psql(`select status||':'||is_dnc_locked from properties where id='${ids.lateLock}'`), "prospect:true", "late DNC remains Prospect");
  assertEqual(psql(`select result_summary->>'dnc_locked' from jobs where id='${lateJob}'`), "1", "late DNC counted");

  const raceA = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.race}']::uuid[], '30000000-0000-0000-0000-000000000004');`).split("\n").at(-1)).job_id;
  const raceB = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.race}']::uuid[], '30000000-0000-0000-0000-000000000005');`).split("\n").at(-1)).job_id;
  psql(`update jobs set status='running' where id in ('${raceA}','${raceB}');`);
  await Promise.all([
    psqlAsync(`${service} select public.process_promote_leads_item('${raceA}','${ids.race}');`),
    psqlAsync(`${service} select public.process_promote_leads_item('${raceB}','${ids.race}');`),
  ]);
  assertEqual(psql(`select sum((output_payload->>'outcome'='promoted')::int)||':'||sum((output_payload->>'outcome'='already_lead')::int) from job_items where job_id in ('${raceA}','${raceB}')`), "1:1", "concurrent promotion exactly once");

  const startupJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.startup}']::uuid[], '30000000-0000-0000-0000-000000000006');`).split("\n").at(-1)).job_id;
  psql(`${service} select public.fail_promote_leads_workflow_start('${startupJob}','synthetic startup failure');`);
  assertEqual(psql(`select status||':'||failed_items from jobs where id='${startupJob}'`), "failed:1", "startup failure checkpoint");

  const retryKey = "30000000-0000-0000-0000-000000000007";
  const retryA = JSON.parse(psql(`${authA} select public.retry_promote_leads_job('${startupJob}','${retryKey}');`).split("\n").at(-1));
  const retryReplay = JSON.parse(psql(`${authA} select public.retry_promote_leads_job('${startupJob}','${retryKey}');`).split("\n").at(-1));
  assertEqual(retryA.job_id, retryReplay.job_id, "duplicate retry identity");
  assertEqual(retryReplay.duplicate, true, "duplicate retry marker");

  const expiredJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.expired}']::uuid[], '30000000-0000-0000-0000-000000000008');`).split("\n").at(-1)).job_id;
  psql(`update jobs set status='running' where id='${expiredJob}';`);
  psql(`${service} select public.fail_promote_leads_workflow_start('${expiredJob}','late synthetic start failure');`);
  assertEqual(psql(`select status||':'||(error_class is null)::text||':'||(select status from job_items where job_id='${expiredJob}') from jobs where id='${expiredJob}'`), "running:true:pending", "late startup failure cannot overwrite running job");
  psql(`update memberships set access_expires_at=now()-interval '1 minute' where user_id='${userA}' and org_id='${orgA}';`);
  psql(`${service} select public.process_promote_leads_item('${expiredJob}','${ids.expired}');`);
  assertEqual(psql(`select status||':'||error_class from job_items where job_id='${expiredJob}'`), "error:authorization", "expired membership fails closed");
  psql(`update memberships set access_expires_at=null where user_id='${userA}' and org_id='${orgA}';`);

  const mismatchJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.wrongOrgItem}']::uuid[], '30000000-0000-0000-0000-000000000009');`).split("\n").at(-1)).job_id;
  psql(`update job_items set property_id='${ids.otherOrg}', item_key='${ids.otherOrg}' where job_id='${mismatchJob}'; update jobs set status='running' where id='${mismatchJob}';`);
  psql(`${service} select public.process_promote_leads_item('${mismatchJob}','${ids.otherOrg}');`);
  assertEqual(psql(`select status from properties where id='${ids.otherOrg}'`), "prospect", "job/item org mismatch cannot promote other tenant");
  assertEqual(psql(`select output_payload->>'outcome' from job_items where job_id='${mismatchJob}'`), "missing", "org mismatch records missing");

  const hardDeleteJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.hardDelete}']::uuid[], '30000000-0000-0000-0000-000000000010');`).split("\n").at(-1)).job_id;
  psql(`delete from properties where id='${ids.hardDelete}';`);
  assertEqual(psql(`select count(*)||':'||(property_id is null)::text from job_items where job_id='${hardDeleteJob}' group by property_id`), "1:true", "hard delete preserves durable item history");
  psql(`${service} select public.process_promote_leads_item('${hardDeleteJob}','${ids.hardDelete}');`);
  assertEqual(psql(`select status||':'||(result_summary->>'missing') from jobs where id='${hardDeleteJob}'`), "completed:1", "hard delete records a missing non-failure outcome");

  const hardDeleteItemFailJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.hardDeleteItemFail}']::uuid[], '30000000-0000-0000-0000-000000000013');`).split("\n").at(-1)).job_id;
  psql(`delete from properties where id='${ids.hardDeleteItemFail}';`);
  psql(`${service} select public.fail_promote_leads_item('${hardDeleteItemFailJob}','${ids.hardDeleteItemFail}','synthetic transient item failure');`);
  assertEqual(psql(`select j.status||':'||(j.result_summary->>'missing')||':'||j.failed_items||':'||ji.status||':'||(ji.output_payload->>'retryable') from jobs j join job_items ji on ji.job_id=j.id where j.id='${hardDeleteItemFailJob}'`), "completed:1:0:skipped:false", "removed property cannot become a false retryable item failure");

  const hardDeleteWorkflowFailJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.hardDeleteWorkflowFail}']::uuid[], '30000000-0000-0000-0000-000000000014');`).split("\n").at(-1)).job_id;
  const hardDeleteWorkflowToken = "40000000-0000-0000-0000-000000000003";
  psql(`delete from properties where id='${ids.hardDeleteWorkflowFail}'; update jobs set status='running', workflow_claim_token='${hardDeleteWorkflowToken}' where id='${hardDeleteWorkflowFailJob}';`);
  psql(`${service} select public.fail_promote_leads_workflow('${hardDeleteWorkflowFailJob}','${hardDeleteWorkflowToken}','synthetic exhausted workflow after removal');`);
  assertEqual(psql(`select j.status||':'||(j.result_summary->>'missing')||':'||j.failed_items||':'||ji.status||':'||(ji.output_payload->>'retryable') from jobs j join job_items ji on ji.job_id=j.id where j.id='${hardDeleteWorkflowFailJob}'`), "completed:1:0:skipped:false", "removed property cannot become a false retryable workflow failure");

  const hardDeleteStartFailJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.hardDeleteStartFail}']::uuid[], '30000000-0000-0000-0000-000000000015');`).split("\n").at(-1)).job_id;
  psql(`delete from properties where id='${ids.hardDeleteStartFail}';`);
  psql(`${service} select public.fail_promote_leads_workflow_start('${hardDeleteStartFailJob}','synthetic start failure after removal');`);
  assertEqual(psql(`select j.status||':'||(j.result_summary->>'missing')||':'||j.failed_items||':'||ji.status||':'||(ji.output_payload->>'retryable') from jobs j join job_items ji on ji.job_id=j.id where j.id='${hardDeleteStartFailJob}'`), "completed:1:0:skipped:false", "removed property cannot become a false retryable start failure");

  const hardDeleteAfterFailJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.hardDeleteAfterFail}']::uuid[], '30000000-0000-0000-0000-000000000016');`).split("\n").at(-1)).job_id;
  const hardDeleteAfterFailToken = "40000000-0000-0000-0000-000000000004";
  psql(`update jobs set status='running', workflow_claim_token='${hardDeleteAfterFailToken}' where id='${hardDeleteAfterFailJob}';`);
  psql(`
    create function pause_promote_failure_checkpoint() returns trigger language plpgsql as $$
    begin perform pg_sleep(0.3); return new; end $$;
    create trigger pause_promote_failure_checkpoint after update on job_items
      for each row when (
        new.job_id = '${hardDeleteAfterFailJob}'
        and new.status = 'error'
        and new.output_payload->>'reason' = 'workflow_failed'
      ) execute function pause_promote_failure_checkpoint();
  `);
  const failureFirst = psqlAsync(`${service} select public.fail_promote_leads_workflow('${hardDeleteAfterFailJob}','${hardDeleteAfterFailToken}','synthetic failure wins item lock');`);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const deleteSecond = psqlAsync(`delete from properties where id='${ids.hardDeleteAfterFail}';`);
  await Promise.all([failureFirst, deleteSecond]);
  assertEqual(psql(`select j.status||':'||(j.result_summary->>'missing')||':'||j.failed_items||':'||ji.status||':'||(ji.output_payload->>'outcome')||':'||(ji.output_payload->>'retryable')||':'||(ji.property_id is null)::text from jobs j join job_items ji on ji.job_id=j.id where j.id='${hardDeleteAfterFailJob}'`), "completed:1:0:skipped:missing:false:true", "delete ratchets a concurrent retryable failure to terminal missing");

  const workflowFailJob = JSON.parse(psql(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.workflowFail}']::uuid[], '30000000-0000-0000-0000-000000000011');`).split("\n").at(-1)).job_id;
  const owningToken = "40000000-0000-0000-0000-000000000001";
  const losingToken = "40000000-0000-0000-0000-000000000002";
  psql(`update jobs set status='running', workflow_claim_token='${owningToken}' where id='${workflowFailJob}';`);
  psql(`${service} select public.fail_promote_leads_workflow('${workflowFailJob}','${losingToken}','duplicate runner failure');`);
  assertEqual(psql(`select status||':'||(select status from job_items where job_id='${workflowFailJob}') from jobs where id='${workflowFailJob}'`), "running:pending", "losing workflow cannot fail the owning runner");
  psql(`${service} select public.fail_promote_leads_workflow('${workflowFailJob}','${owningToken}','synthetic exhausted workflow');`);
  assertEqual(psql(`select status||':'||failed_items||':'||(select output_payload->>'retryable' from job_items where job_id='${workflowFailJob}') from jobs where id='${workflowFailJob}'`), "failed:1:true", "owning workflow checkpoints exhausted failure for retry");

  psql(`
    create function pause_concurrent_promote_insert() returns trigger language plpgsql as $$
    begin perform pg_sleep(0.3); return new; end $$;
    create trigger pause_concurrent_promote_insert after insert on jobs
      for each row when (new.idempotency_key = '30000000-0000-0000-0000-000000000012')
      execute function pause_concurrent_promote_insert();
  `);
  const concurrentCreate = psqlAsync(`${authA} select public.create_promote_leads_job('${orgA}', array['${ids.concurrentDelete}']::uuid[], '30000000-0000-0000-0000-000000000012');`);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const concurrentDelete = psqlAsync(`delete from properties where id='${ids.concurrentDelete}';`);
  const [concurrentCreateResult] = await Promise.all([concurrentCreate, concurrentDelete]);
  const concurrentDeleteJob = JSON.parse(concurrentCreateResult.split("\n").at(-1)).job_id;
  assertEqual(psql(`select count(*)||':'||(property_id is null)::text from job_items where job_id='${concurrentDeleteJob}' group by property_id`), "1:true", "concurrent delete cannot escape durable audience ledger");

  console.log("Promote-leads migration apply/replay/multi-org/concurrency rehearsal: PASS");
} finally {
  if (started) {
    try { run("pg_ctl", ["-D", cluster, "-m", "immediate", "stop"], { stdio: "ignore" }); } catch {}
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
