#!/usr/bin/env node
// Apply/replay and adversarially exercise the paid-job safety migration in a
// disposable host-only PostgreSQL cluster. Never connects to Supabase.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cluster = mkdtempSync(join(tmpdir(), "sandra-paid-job-safety-"));
const socketDir = mkdtempSync("/tmp/spjssock-");
const port = 7200 + Math.floor(Math.random() * 300);
const migration = fileURLToPath(
  new URL(
    "../supabase/migrations/20260816070000_paid_job_authorization_safety.sql",
    import.meta.url,
  ),
);
let started = false;

function run(name, args, options = {}) {
  return execFileSync(name, args, { stdio: "inherit", ...options });
}

function psql(sql) {
  return execFileSync(
    "psql",
    [
      "-h", socketDir, "-p", String(port), "-U", "postgres",
      "-v", "ON_ERROR_STOP=1", "-At", "-c", sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function expectRejected(sql, pattern, label) {
  try {
    psql(sql);
  } catch (error) {
    const detail = `${String(error)}\n${error?.stderr?.toString?.() ?? ""}`;
    if (pattern.test(detail)) return;
    throw new Error(`${label}: wrong rejection: ${detail}`);
  }
  throw new Error(`${label}: mutation unexpectedly succeeded`);
}

const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userA = "11111111-1111-4111-8111-111111111111";
const propertyA = "22222222-2222-4222-8222-222222222222";
const propertyA2 = "23232323-2323-4232-8232-232323232323";
const contactA = "33333333-3333-4333-8333-333333333333";
const importA = "44444444-4444-4444-8444-444444444444";
const csvJob = "55555555-5555-4555-8555-555555555555";
const ordinaryJob = "66666666-6666-4666-8666-666666666666";
const standaloneRequest = "77777777-7777-4777-8777-777777777777";
const importRequest = "88888888-8888-4888-8888-888888888888";
const retryRequest = "99999999-9999-4999-8999-999999999999";
const concurrentRequest = "12121212-1212-4212-8212-121212121212";
const skipParent = "13131313-1313-4313-8313-131313131313";

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres"], {
    stdio: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  run(
    "pg_ctl",
    ["-D", cluster, "-o", `-p ${port} -k ${socketDir}`, "-l", join(cluster, "server.log"), "start"],
    { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } },
  );
  started = true;

  psql(`
    create extension if not exists pgcrypto;
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

    create table organizations(id uuid primary key);
    create table memberships(
      user_id uuid not null references auth.users(id), org_id uuid not null,
      access_status text not null default 'active', deletion_prepared_at timestamptz,
      access_expires_at timestamptz, primary key(user_id, org_id)
    );
    create table csv_imports(id uuid primary key, org_id uuid not null, unique(id, org_id));
    create table contacts(
      id uuid primary key, org_id uuid not null, do_not_contact boolean not null default false,
      first_name text, updated_at timestamptz not null default now(), unique(id, org_id)
    );
    create table properties(
      id uuid primary key, org_id uuid not null, deleted_at timestamptz,
      is_dnc_locked boolean not null default false, homeowner_contact_id uuid,
      unique(id, org_id),
      foreign key(homeowner_contact_id, org_id) references contacts(id, org_id)
    );
    create function reject_locked_property_contact_mutation() returns trigger
      language plpgsql as $$ begin return new; end $$;
    create function claim_paid_property_enrichment(uuid, uuid) returns boolean
      language sql as $$ select true $$;
    create trigger contacts_reject_dnc_locked_property
      before update or delete on contacts for each row
      execute function reject_locked_property_contact_mutation();
    create table jobs(
      id uuid primary key default gen_random_uuid(), org_id uuid not null,
      created_at timestamptz not null default now(), created_by uuid references auth.users(id),
      type text not null, status text not null default 'queued', total_items int not null default 0,
      processed_items int not null default 0, succeeded_items int not null default 0,
      failed_items int not null default 0, started_at timestamptz, completed_at timestamptz,
      worker_heartbeat_at timestamptz, retry_count int not null default 0,
      max_retries int not null default 3, error_class text, parent_job_id uuid references jobs(id),
      related_import_id uuid references csv_imports(id), provider text, input_params jsonb,
      provider_run_id text, idempotency_key uuid, result_summary jsonb,
      error_message text, title text, description text,
      unique(id, org_id)
    );
    create unique index idx_jobs_org_type_idempotency_key
      on jobs(org_id, type, idempotency_key) where idempotency_key is not null;
    create table job_items(
      id uuid primary key default gen_random_uuid(), job_id uuid not null references jobs(id) on delete cascade,
      property_id uuid references properties(id) on delete cascade, status text not null default 'pending',
      item_key text, error_class text, error_message text, output_payload jsonb,
      processed_at timestamptz
    );
    create table csv_import_job_provenance(
      job_id uuid primary key, org_id uuid not null, csv_import_id uuid not null,
      foreign key(job_id, org_id) references jobs(id, org_id),
      foreign key(csv_import_id, org_id) references csv_imports(id, org_id)
    );
    alter table jobs enable row level security;
    create policy jobs_all on jobs for all to authenticated using (true) with check (true);
    grant usage on schema public, auth to authenticated, service_role;
    grant execute on function auth.uid(), auth.role() to authenticated, service_role;
    grant select, insert, update, delete on jobs to authenticated;
    grant select on memberships, properties, job_items, csv_import_job_provenance to authenticated;

    insert into organizations values ('${orgA}'), ('${orgB}');
    insert into auth.users values ('${userA}');
    insert into memberships(user_id, org_id) values ('${userA}', '${orgA}');
    insert into contacts(id, org_id) values ('${contactA}', '${orgA}');
    insert into properties(id, org_id, homeowner_contact_id)
      values ('${propertyA}', '${orgA}', '${contactA}');
    insert into properties(id, org_id) values ('${propertyA2}', '${orgA}');
    insert into csv_imports values ('${importA}', '${orgA}');
    insert into jobs(id, org_id, created_by, type, status, related_import_id,
      retry_count, max_retries, error_class)
      values ('${csvJob}', '${orgA}', '${userA}', 'csv_import', 'failed', '${importA}', 0, 1, 'database');
    insert into csv_import_job_provenance values ('${csvJob}', '${orgA}', '${importA}');
    insert into jobs(id, org_id, type, status) values ('${ordinaryJob}', '${orgA}', 'sweeper', 'queued');
    insert into jobs(id, org_id, created_by, type, status, provider, input_params)
      values ('${skipParent}', '${orgA}', '${userA}', 'skip_trace', 'failed', 'tracerfy',
        jsonb_build_object('property_ids', array['${propertyA}'::uuid]));
    insert into job_items(job_id, property_id, status, error_class)
      values ('${skipParent}', '${propertyA}', 'error', 'provider_transient');
  `);

  for (let i = 0; i < 2; i++) {
    run(
      "psql",
      ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }

  const authPrefix = `set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${userA}';`;
  expectRejected(
    `${authPrefix} insert into jobs(org_id,type,status,input_params) values ('${orgA}','cass_dsf2_ncoa','queued','{"property_ids":["${propertyA}"]}');`,
    /CASS_JOB_AUTHORIZATION_REQUIRED/,
    "fabricated authenticated CASS insert",
  );
  expectRejected(
    `${authPrefix} update jobs set type='cass_dsf2_ncoa' where id='${ordinaryJob}';`,
    /CASS_JOB_AUTHORIZATION_REQUIRED/,
    "fabricated CASS type transition",
  );

  const [cassJob, claimToken] = psql(`${authPrefix}
    select job_id||'|'||claim_token from public.create_authorized_cass_job(
      '${orgA}', array['${propertyA}'::uuid,'${propertyA2}'::uuid], 'standalone', null, null, null,
      '${userA}', true, null, '${standaloneRequest}'
    );`).split("\n").at(-1).split("|");
  expectEqual(
    psql(`select status from jobs where id='${cassJob}'`),
    "running",
    "authorized CASS claim starts job",
  );
  expectEqual(
    psql(`${authPrefix} select public.claim_authorized_cass_job_start('${cassJob}','${orgA}','${claimToken}');`).split("\n").at(-1),
    claimToken,
    "same start receipt is idempotent",
  );
  expectEqual(
    psql(`${authPrefix}
      select job_id||':'||created::text from public.create_authorized_cass_job(
        '${orgA}', array['${propertyA}'::uuid,'${propertyA2}'::uuid], 'standalone', null, null, null,
        '${userA}', true, null, '${standaloneRequest}'
      );`).split("\n").at(-1),
    `${cassJob}:false`,
    "lost create response reuses the same paid job",
  );
  expectRejected(
    `${authPrefix} select * from public.create_authorized_cass_job(
      '${orgA}', array['${propertyA}'::uuid], 'standalone', null, null, null,
      '${userA}', true, null, '${standaloneRequest}'
    );`,
    /CASS_REQUEST_KEY_CONFLICT/,
    "standalone request-key replay cannot shrink its paid target set",
  );
  const concurrentSql = `${authPrefix}
    select job_id from public.create_authorized_cass_job(
      '${orgA}', array['${propertyA}'::uuid], 'standalone', null, null, null,
      '${userA}', true, null, '${concurrentRequest}'
    );`;
  await Promise.all(
    [0, 1].map(() =>
      execFileAsync("psql", [
        "-h", socketDir, "-p", String(port), "-U", "postgres",
        "-v", "ON_ERROR_STOP=1", "-At", "-c", concurrentSql,
      ]),
    ),
  );
  expectEqual(
    psql(`select count(*) from cass_job_authorizations
      where org_id='${orgA}' and request_key='${concurrentRequest}'`),
    "1",
    "concurrent starts create one paid job",
  );

  psql(`insert into job_items(job_id, property_id, status) values
    ('${csvJob}', '${propertyA}', 'success'),
    ('${csvJob}', '${propertyA2}', 'success')`);
  const importCassJob = psql(`
    set role service_role; set request.jwt.claim.role='service_role';
    select job_id from public.create_authorized_cass_job(
      '${orgA}', array['${propertyA}'::uuid,'${propertyA2}'::uuid], 'import', '${csvJob}', '${importA}',
      null, '${userA}', true, null, '${importRequest}'
    );`).split("\n").at(-1);
  expectEqual(
    psql(`set role service_role; set request.jwt.claim.role='service_role';
      select job_id||':'||created::text from public.create_authorized_cass_job(
        '${orgA}', array['${propertyA}'::uuid], 'import', '${csvJob}', '${importA}',
        null, '${userA}', true, null, '${importRequest}'
      );`).split("\n").at(-1),
    `${importCassJob}:false`,
    "import replay may shrink to the surviving eligible subset",
  );
  psql(`insert into job_items(job_id, property_id, status, error_class)
    values ('${importCassJob}', '${propertyA}', 'error', 'database')`);
  expectEqual(
    psql(`set role service_role; set request.jwt.claim.role='service_role';
      select action from public.claim_cass_property_lookup(
        '${importCassJob}','${orgA}','${propertyA}','smartystreets'
      );`).split("\n").at(-1),
    "claimed",
    "first lookup owns paid boundary",
  );
  expectEqual(
    psql(`set role service_role; set request.jwt.claim.role='service_role';
      select public.complete_cass_property_lookup(
        '${importCassJob}','${orgA}','${propertyA}','completed','result',
        '{"standardized":"1 Main St","cassStatus":"verified","components":{},"raw":{}}',null
      );`).split("\n").at(-1),
    "t",
    "provider result checkpoint",
  );
  const retryCassJob = psql(`${authPrefix}
    select job_id from public.create_authorized_cass_job(
      '${orgA}', array['${propertyA}'::uuid], 'retry', '${csvJob}', '${importA}',
      '${importCassJob}', '${userA}', true, null, '${retryRequest}'
    );`).split("\n").at(-1);
  expectEqual(
    psql(`select purpose||':'||(requested_by='${userA}')::text
      from cass_job_authorizations where job_id='${retryCassJob}'`),
    "retry:true",
    "retry provenance derives the active caller",
  );
  expectEqual(
    psql(`set role service_role; set request.jwt.claim.role='service_role';
      select action from public.claim_cass_property_lookup(
        '${retryCassJob}','${orgA}','${propertyA}','smartystreets'
      );`).split("\n").at(-1),
    "reused",
    "retry reuses saved provider output",
  );

  expectRejected(
    `update contacts set do_not_contact=true, first_name='piggyback' where id='${contactA}';`,
    /DNC_RATCHET_ONLY/,
    "DNC ratchet piggyback",
  );
  psql(`update contacts set do_not_contact=true where id='${contactA}'`);

  for (const [assignment, label] of [
    ["retry_count=99", "retry count"],
    ["max_retries=99", "retry budget"],
    ["status='completed'", "CSV status"],
    ["error_class='validation'", "CSV failure classification"],
    ["type='sweeper'", "CSV type"],
  ]) {
    expectRejected(
      `${authPrefix} update jobs set ${assignment} where id='${csvJob}';`,
      /CSV_IMPORT_JOB_CONTROLLED_FIELDS/,
      `authenticated direct ${label} mutation`,
    );
  }
  expectRejected(
    `${authPrefix} insert into jobs(org_id, type, status, retry_count, max_retries)
      values ('${orgA}', 'csv_import', 'queued', 0, 99);`,
    /CSV_IMPORT_JOB_CONTROLLED_FIELDS/,
    "authenticated fabricated CSV retry budget",
  );
  expectRejected(
    `${authPrefix} insert into jobs(org_id, type, status, error_class)
      values ('${orgA}', 'csv_import', 'queued', 'database');`,
    /CSV_IMPORT_JOB_CONTROLLED_FIELDS/,
    "authenticated fabricated CSV failure classification",
  );

  const retryChildSql = `set role service_role; set request.jwt.claim.role='service_role';
    select job_id from public.create_skip_trace_retry_job(
      '${skipParent}', array['${propertyA}'::uuid]
    );`;
  const skipChildren = await Promise.all(
    [0, 1].map(() =>
      execFileAsync("psql", [
        "-h", socketDir, "-p", String(port), "-U", "postgres",
        "-v", "ON_ERROR_STOP=1", "-At", "-c", retryChildSql,
      ]),
    ),
  );
  expectEqual(
    skipChildren[0].stdout.trim().split("\n").at(-1),
    skipChildren[1].stdout.trim().split("\n").at(-1),
    "concurrent skip-trace retries return one child",
  );
  expectEqual(
    psql(`select count(*) from jobs where parent_job_id='${skipParent}' and type='skip_trace'`),
    "1",
    "concurrent skip-trace retries create one child",
  );

  psql(`update jobs set error_class='validation' where id='${csvJob}'`);
  expectEqual(
    psql(`${authPrefix} select public.claim_csv_import_retry('${csvJob}');`).split("\n").at(-1),
    "f",
    "validation failure classification cannot be retried",
  );
  psql(`update jobs set error_class='database' where id='${csvJob}'`);
  expectEqual(
    psql(`${authPrefix} select public.claim_csv_import_retry('${csvJob}');`).split("\n").at(-1),
    "t",
    "first retry within custom budget",
  );
  psql(`update jobs set status='failed', error_class='database' where id='${csvJob}'`);
  expectEqual(
    psql(`${authPrefix} select public.claim_csv_import_retry('${csvJob}');`).split("\n").at(-1),
    "f",
    "custom retry budget exhausted",
  );
  psql(`update jobs set retry_count=0; update memberships set access_status='suspended' where user_id='${userA}' and org_id='${orgA}'`);
  expectEqual(
    psql(`${authPrefix} select public.claim_csv_import_retry('${csvJob}');`).split("\n").at(-1),
    "f",
    "suspended membership cannot retry",
  );

  psql(`update memberships set access_status='active', deletion_prepared_at=now()
    where user_id='${userA}' and org_id='${orgA}'`);
  expectEqual(
    psql(`${authPrefix} select public.claim_csv_import_retry('${csvJob}');`).split("\n").at(-1),
    "f",
    "deletion-prepared membership cannot retry",
  );
  psql(`update memberships set deletion_prepared_at=null, access_expires_at=now()-interval '1 minute'
    where user_id='${userA}' and org_id='${orgA}'`);
  expectEqual(
    psql(`${authPrefix} select public.claim_csv_import_retry('${csvJob}');`).split("\n").at(-1),
    "f",
    "expired membership cannot retry",
  );

  psql(`insert into job_items(job_id, property_id, status) values ('${ordinaryJob}', '${propertyA}', 'success')`);
  expectRejected(
    `update properties set org_id='${orgB}' where id='${propertyA}'`,
    /foreign key constraint/,
    "referenced property tenant transfer",
  );
  expectRejected(
    `update jobs set org_id='${orgB}' where id='${ordinaryJob}'`,
    /foreign key constraint/,
    "referenced job tenant transfer",
  );
  psql(`delete from properties where id='${propertyA}'`);
  expectEqual(
    psql(`select count(*)||':'||count(property_id) from job_items where job_id='${importCassJob}'`),
    "1:0",
    "property deletion preserves job-item history",
  );

  console.log("paid job authorization safety rehearsal: PASS");
} finally {
  if (started) {
    try {
      run("pg_ctl", ["-D", cluster, "stop", "-m", "immediate"], { stdio: "ignore" });
    } catch {}
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
