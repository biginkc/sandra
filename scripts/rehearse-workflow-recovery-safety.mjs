#!/usr/bin/env node
// Apply/replay and exercise the CSV line-type recovery migration in a
// disposable host-only PostgreSQL cluster. Never connects to Supabase.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cluster = mkdtempSync(join(tmpdir(), "sandra-workflow-recovery-"));
const socketDir = mkdtempSync("/tmp/swrsock-");
const port = 7500 + Math.floor(Math.random() * 250);
const migration = fileURLToPath(
  new URL(
    "../supabase/migrations/20260816060000_workflow_recovery_safety.sql",
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
      "-h",
      socketDir,
      "-p",
      String(port),
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-qAt",
      "-c",
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function rejected(sql, pattern, label) {
  try {
    psql(sql);
  } catch (error) {
    const detail = `${String(error)}\n${error?.stderr?.toString?.() ?? ""}`;
    if (pattern.test(detail)) return;
    throw new Error(`${label}: wrong rejection: ${detail}`);
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}

const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const jobA = "11111111-1111-4111-8111-111111111111";
const phone = "+18165550123";

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres"], {
    stdio: "ignore",
    env: { ...process.env, LC_ALL: "C" },
  });
  run(
    "pg_ctl",
    [
      "-D",
      cluster,
      "-o",
      `-p ${port} -k ${socketDir}`,
      "-l",
      join(cluster, "server.log"),
      "start",
    ],
    { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } },
  );
  started = true;

  psql(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table jobs(
      id uuid primary key, org_id uuid not null, type text not null,
      status text not null, retry_count integer not null default 0,
      unique(id, org_id)
    );
    create table csv_import_job_provenance(
      job_id uuid primary key, org_id uuid not null,
      classify_line_types boolean not null default false,
      foreign key(job_id, org_id) references jobs(id, org_id)
    );
    insert into jobs values ('${jobA}', '${orgA}', 'csv_import', 'running', 0);
    insert into csv_import_job_provenance values ('${jobA}', '${orgA}', true);
    grant usage on schema public, auth to service_role;
    grant select, update on jobs to service_role;
    grant select on csv_import_job_provenance to service_role;
    grant execute on function auth.uid(), auth.role() to service_role;
  `);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    run(
      "psql",
      [
        "-h",
        socketDir,
        "-p",
        String(port),
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        migration,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }

  const service = "set role service_role; set request.jwt.claim.role='service_role';";
  equal(
    psql(`${service} select action from claim_csv_import_line_type_lookup('${jobA}','${orgA}','${phone}');`),
    "claimed",
    "first lookup claims paid boundary",
  );
  equal(
    psql(`${service} select action from claim_csv_import_line_type_lookup('${jobA}','${orgA}','${phone}');`),
    "ambiguous",
    "unresolved replay does not spend again",
  );
  psql(`${service} select complete_csv_import_line_type_lookup(
    '${jobA}','${orgA}','${phone}','retryable','unknown','provider_rejected',429,'rate limited'
  );`);
  equal(
    psql(`${service} select action from claim_csv_import_line_type_lookup('${jobA}','${orgA}','${phone}');`),
    "retry_blocked",
    "same job attempt cannot retry provider rejection",
  );
  psql(`update jobs set retry_count=1 where id='${jobA}'`);
  equal(
    psql(`${service} select action from claim_csv_import_line_type_lookup('${jobA}','${orgA}','${phone}');`),
    "claimed",
    "advanced job retry can claim once",
  );
  psql(`${service} select complete_csv_import_line_type_lookup(
    '${jobA}','${orgA}','${phone}','completed','mobile','classified',200,null
  );`);
  equal(
    psql(`${service} select action||':'||line_type from claim_csv_import_line_type_lookup('${jobA}','${orgA}','${phone}');`),
    "reused:mobile",
    "terminal result is reused",
  );
  equal(
    psql(`select lookup_attempts::text from csv_import_line_type_outcomes where job_id='${jobA}' and phone_e164='${phone}'`),
    "2",
    "ledger conserves paid attempts",
  );
  rejected(
    `${service} select * from claim_csv_import_line_type_lookup('${jobA}','${orgB}','+18165550124');`,
    /CSV_IMPORT_LINE_TYPE_JOB_NOT_ELIGIBLE/,
    "cross-tenant claim",
  );

  console.log("workflow recovery safety rehearsal: PASS");
} finally {
  if (started) {
    try {
      run("pg_ctl", ["-D", cluster, "stop", "-m", "immediate"], {
        stdio: "ignore",
      });
    } catch {}
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
