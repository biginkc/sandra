#!/usr/bin/env node
// Applies the CSV recovery migration twice to disposable local PostgreSQL,
// then exercises tenant, terminal-failure, replay, and concurrency invariants.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cluster = mkdtempSync(join(tmpdir(), "sandra-csv-recovery-"));
const socketDir = mkdtempSync("/tmp/scrsock-");
const port = 6900 + Math.floor(Math.random() * 300);
const migration = fileURLToPath(
  new URL("../supabase/migrations/20260816020000_csv_import_recovery_safety.sql", import.meta.url),
);
let started = false;

function run(name, args, options = {}) {
  return execFileSync(name, args, { stdio: "inherit", ...options });
}
function psql(sql) {
  return execFileSync(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql],
      { encoding: "utf8" },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()),
    );
  });
}
function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

const orgA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const userA = "11111111-1111-1111-1111-111111111111";
const importA = "10000000-0000-0000-0000-000000000001";
const importB = "10000000-0000-0000-0000-000000000002";
const jobA = "20000000-0000-0000-0000-000000000001";
const jobB = "20000000-0000-0000-0000-000000000002";
const county = "30000000-0000-0000-0000-000000000001";
const contactA = "40000000-0000-0000-0000-000000000001";
const lockedProperty = "50000000-0000-0000-0000-000000000001";
const consentProperty = "50000000-0000-0000-0000-000000000002";
const shaA = "a".repeat(64);
const shaB = "b".repeat(64);
const service = "set request.jwt.claim.role='service_role';";
const authA = `set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${userA}';`;

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres"], { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } });
  run("pg_ctl", ["-D", cluster, "-o", `-p ${port} -k ${socketDir}`, "-l", join(cluster, "server.log"), "start"], { stdio: "ignore" });
  started = true;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { run("pg_isready", ["-h", socketDir, "-p", String(port), "-U", "postgres"], { stdio: "ignore" }); break; }
    catch { if (attempt === 49) throw new Error("PostgreSQL did not start"); await new Promise((r) => setTimeout(r, 100)); }
  }

  psql(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table memberships (user_id uuid not null, org_id uuid not null);
    create table counties (id uuid primary key);
    create table lists (id uuid primary key, org_id uuid not null);
    create table sequences (id uuid primary key, org_id uuid not null);
    create table csv_imports (
      id uuid primary key, org_id uuid not null, storage_path text,
      source text, market text, county_id uuid, dataset_sha256 text,
      review_contract_sha256 text, dataset_version int, total_rows int,
      inserted_properties int default 0, skipped_duplicates int default 0, failed_rows int default 0,
      unique(id,org_id)
    );
    create table jobs (
      id uuid primary key, org_id uuid not null, type text not null, status text not null,
      related_import_id uuid, error_class text, error_message text, result_summary jsonb,
      total_items int not null default 0, processed_items int not null default 0,
      succeeded_items int not null default 0, failed_items int not null default 0,
      retry_count int not null default 0, completed_at timestamptz, worker_heartbeat_at timestamptz
    );
    create table contacts (
      id uuid primary key, org_id uuid not null,
      do_not_contact boolean not null default false,
      sms_opted_out boolean not null default false,
      phone_1 text, phone_2 text, phone_3 text,
      unique(id, org_id)
    );
    create table properties (
      id uuid primary key default gen_random_uuid(), org_id uuid not null,
      status text, address text, city text, state text, zip text, market text, county_id uuid,
      fips_code text, apn text, apn_normalized text, zpid text, mls_number text,
      address_normalized text, beds numeric, baths numeric, sqft numeric, year_built int,
      listing_price numeric, arv numeric, repair_estimate numeric, mortgage_balance numeric,
      equity_estimate numeric, lat numeric, lon numeric, source text, source_import_id uuid,
      source_imported_at timestamptz, homeowner_contact_id uuid, agent_contact_id uuid,
      outreach_dispo text, is_dnc_locked boolean not null default false
    );
    create table consent_events (
      id uuid primary key default gen_random_uuid(), org_id uuid not null,
      contact_id uuid not null, channel text not null, event_type text not null,
      source text, occurred_at timestamptz not null default now(),
      foreign key(contact_id, org_id) references contacts(id, org_id)
    );
    create table sms_phone_suppressions (
      org_id uuid not null, channel text not null, phone_e164 text not null
    );
    create table job_items (
      id uuid primary key default gen_random_uuid(), job_id uuid not null references jobs(id),
      status text not null, source_row_index int, property_id uuid references properties(id),
      compliance_locked boolean not null default false
    );
    insert into memberships values ('${userA}','${orgA}');
    insert into counties values ('${county}');
    insert into contacts(id,org_id) values ('${contactA}','${orgA}');
    insert into properties(
      id,org_id,status,address,state,source,homeowner_contact_id,is_dnc_locked
    ) values (
      '${lockedProperty}','${orgA}','prospect','Locked Duplicate','MO','dealmachine','${contactA}',true
    ), (
      '${consentProperty}','${orgA}','prospect','Consent Eligible','MO','dealmachine','${contactA}',false
    );
    insert into csv_imports(id,org_id,storage_path,source,market,county_id,dataset_sha256,review_contract_sha256,dataset_version,total_rows) values
      ('${importA}','${orgA}','${orgA}/a.csv','dealmachine','Kansas City','${county}','${shaA}','${shaB}',1,3),
      ('${importB}','${orgB}','${orgB}/b.csv','dealmachine','Kansas City','${county}','${shaA}','${shaB}',1,1);
    insert into jobs(id,org_id,type,status,related_import_id,total_items) values
      ('${jobA}','${orgA}','csv_import','failed','${importA}',3),
      ('${jobB}','${orgB}','csv_import','failed','${importB}',1);
  `);

  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration]);
  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration]);

  psql(`${service}
    insert into csv_import_job_provenance(job_id,org_id,csv_import_id,storage_path,source,market,county_id,mapping,dataset_sha256,review_contract_sha256,dataset_version,expected_total_rows)
    values ('${jobA}','${orgA}','${importA}','${orgA}/a.csv','dealmachine','Kansas City','${county}','{}','${shaA}','${shaB}',1,3);
    update csv_import_job_provenance set sms_consent=true where job_id='${jobA}';
    insert into job_items(job_id,status,source_row_index) values
      ('${jobA}','success',0),('${jobA}','skipped',1),('${jobA}','error',2);
  `);
  equal(psql(`${authA} select claim_csv_import_retry('${jobB}')`), "f", "cross-tenant retry denied");
  equal(psql(`${authA} select claim_csv_import_retry('${jobA}')`), "t", "owned retry claimed");
  psql(`update jobs set status='processing'; ${service} select fail_csv_import_workflow('${jobA}','${importA}','${orgA}','synthetic exhaustion');`);
  equal(psql(`select status||':'||processed_items||':'||succeeded_items||':'||failed_items from jobs where id='${jobA}'`), "partial:3:1:1", "failure checkpoint counts conserve success + blank skip + error");

  const call = `${service} select property_id||':'||original_outcome from checkpoint_csv_import_property_outcome('${jobA}','${importA}','${orgA}',5,'{"address":"1 Main St","state":"MO","status":"prospect","source":"dealmachine"}'::jsonb);`;
  const first = psql(call);
  const replay = psql(call);
  equal(replay, first, "row replay preserves inserted outcome");
  equal(first.endsWith(":inserted"), true, "first row is inserted");
  const concurrent = await Promise.all([psqlAsync(call), psqlAsync(call)]);
  equal(concurrent[0], first, "concurrent replay A");
  equal(concurrent[1], first, "concurrent replay B");
  equal(psql(`select count(*) from properties where org_id='${orgA}' and address='1 Main St'`), "1", "one replayed business row");
  equal(psql(`select count(*) from csv_import_row_outcomes where job_id='${jobA}' and source_row_index=5`), "1", "one immutable outcome");

  psql(`
    create or replace function reject_locked_property_update()
    returns trigger language plpgsql as $$ begin
      if old.is_dnc_locked and new is distinct from old then
        raise exception 'DNC_LOCKED';
      end if;
      return new;
    end $$;
    create trigger reject_locked_property_update
      before update on properties for each row
      execute function reject_locked_property_update();
  `);
  const lockedCall = `${service} select property_id||':'||original_outcome from checkpoint_csv_import_property_outcome('${jobA}','${importA}','${orgA}',7,'{}'::jsonb,'${lockedProperty}','{"source_imported_at":"2026-08-16T00:00:00Z","outreach_dispo":"dnc"}'::jsonb);`;
  equal(psql(lockedCall), `${lockedProperty}:duplicate`, "locked duplicate checkpoint succeeds without mutation");
  equal(psql(lockedCall), `${lockedProperty}:duplicate`, "locked duplicate replay is stable");
  equal(psql(`select count(*) from csv_import_row_outcomes where job_id='${jobA}' and source_row_index=7`), "1", "one locked duplicate outcome");

  psql(`${service}
    select checkpoint_csv_import_property_outcome(
      '${jobA}','${importA}','${orgA}',8,'{}'::jsonb,'${consentProperty}','{}'::jsonb
    );
    select record_csv_import_consents('${jobA}','${orgA}');
    select record_csv_import_consents('${jobA}','${orgA}');
  `);
  equal(
    psql(`select count(*) from consent_events where idempotency_key='csv-import:${jobA}:contact:${contactA}'`),
    "1",
    "consent audit is idempotent across retry",
  );

  let wrongOrgRejected = false;
  try {
    psql(`${service} select checkpoint_csv_import_property_outcome('${jobA}','${importA}','${orgB}',6,'{"address":"Bad","state":"MO"}'::jsonb);`);
  } catch (error) { wrongOrgRejected = /identity mismatch/.test(String(error)); }
  equal(wrongOrgRejected, true, "cross-tenant row write rejected");

  console.log("CSV import recovery migration rehearsal: PASS");
  console.log("- migration apply + replay");
  console.log("- tenant-checked retry and row writes");
  console.log("- exhausted failure terminal counts");
  console.log("- atomic row outcome replay + concurrency");
  console.log("- locked duplicate DNC replay without mutation");
  console.log("- written-consent idempotency across retry");
} finally {
  if (started) { try { run("pg_ctl", ["-D", cluster, "-m", "immediate", "stop"], { stdio: "ignore" }); } catch {} }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
