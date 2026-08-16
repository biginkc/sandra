#!/usr/bin/env node
// Applies the real backend safety migration twice to a disposable, host-only
// PostgreSQL cluster. Exercises tenant derivation, paid-boundary DNC ordering,
// contact/sidecar finalization guards, and sequence-history immutability.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cluster = mkdtempSync(join(tmpdir(), "sandra-backend-safety-"));
const socketDir = mkdtempSync("/tmp/sbssock-");
const port = 6900 + Math.floor(Math.random() * 250);
const migration = fileURLToPath(
  new URL(
    "../supabase/migrations/20260816010000_backend_paid_safety.sql",
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
      "-At",
      "-c",
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    execFile(
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
        "-At",
        "-c",
        sql,
      ],
      { encoding: "utf8" },
      (error, stdout, stderr) =>
        error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()),
    );
  });
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const orgA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const contact = "11111111-1111-1111-1111-111111111111";
const replacementContact = "11111111-1111-1111-1111-111111111112";
const property = "22222222-2222-2222-2222-222222222222";
const sequence = "33333333-3333-3333-3333-333333333333";
const enrollment = "44444444-4444-4444-4444-444444444444";
const runId = "55555555-5555-5555-5555-555555555555";

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
    create table public.jobs(
      id uuid primary key,
      error_class text check (error_class in (
        'validation','transient','provider','database','authorization','configuration'
      ))
    );
    create table public.job_items(
      id uuid primary key,
      error_class text check (error_class in (
        'validation','transient','provider','database','authorization','configuration',
        'internal','provider_no_data','address_unverified','provider_transient','provider_unknown'
      ))
    );
    create table public.organizations(id uuid primary key);
    create table public.contacts(
      id uuid primary key, org_id uuid not null, do_not_contact boolean not null default false,
      first_name text, unique(id, org_id)
    );
    create table public.properties(
      id uuid primary key, org_id uuid not null, homeowner_contact_id uuid,
      is_dnc_locked boolean not null default false, deleted_at timestamptz,
      foreign key(homeowner_contact_id, org_id) references public.contacts(id, org_id)
    );
    create table public.homeowner_details(
      contact_id uuid primary key, org_id uuid not null,
      mailing_address text, foreign key(contact_id, org_id) references public.contacts(id, org_id)
    );
    create table public.agent_details(
      contact_id uuid primary key, org_id uuid not null,
      foreign key(contact_id, org_id) references public.contacts(id, org_id)
    );
    create table public.consent_events(
      id uuid primary key default gen_random_uuid(), contact_id uuid not null,
      org_id uuid not null, event_type text,
      foreign key(contact_id, org_id) references public.contacts(id, org_id)
    );
    create table public.sequences(id uuid primary key);
    create table public.sequence_enrollments(
      id uuid primary key, sequence_id uuid not null, property_id uuid not null,
      contact_id uuid, status text not null default 'active', current_step_index int not null default 0,
      next_run_at timestamptz, enrolled_at timestamptz not null default now(),
      enrolled_by_user_id uuid, pause_reason text, completed_at timestamptz,
      updated_at timestamptz not null default now()
    );
    create table public.sequence_step_runs(
      id uuid primary key, enrollment_id uuid not null references public.sequence_enrollments(id) on delete cascade,
      step_id uuid, scheduled_for timestamptz, run_at timestamptz, skipped_reason text,
      created_at timestamptz not null default now()
    );
    insert into organizations values ('${orgA}'), ('${orgB}');
    insert into contacts(id, org_id) values
      ('${contact}', '${orgB}'), ('${replacementContact}', '${orgB}');
    insert into properties(id, org_id, homeowner_contact_id) values ('${property}', '${orgB}', '${contact}');
    insert into sequences values ('${sequence}');
    insert into sequence_enrollments(id, sequence_id, property_id) values ('${enrollment}', '${sequence}', '${property}');
    insert into sequence_step_runs(id, enrollment_id) values ('${runId}', '${enrollment}');
  `);

  run(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration],
    { stdio: "ignore" },
  );
  run(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration],
    { stdio: "ignore" },
  );

  psql(`
    insert into jobs(id, error_class)
    values ('66666666-6666-6666-6666-666666666666', 'submission_unknown');
    insert into job_items(id, error_class) values
      ('77777777-7777-7777-7777-777777777771', 'dnc_locked'),
      ('77777777-7777-7777-7777-777777777772', 'submission_unknown'),
      ('77777777-7777-7777-7777-777777777773', 'provider_persist_failed');
  `);

  psql(`insert into consent_events(contact_id, org_id, event_type) values ('${contact}', '${orgA}', 'opt_out')`);
  equal(
    psql(`select org_id from consent_events where contact_id='${contact}'`),
    orgB,
    "consent org derived from contact",
  );
  psql(`insert into homeowner_details(contact_id, org_id) values ('${contact}', '${orgA}')`);
  equal(
    psql(`select org_id from homeowner_details where contact_id='${contact}'`),
    orgB,
    "sidecar org derived from contact",
  );

  equal(
    psql(`set role service_role; select public.claim_paid_property_enrichment('${property}','${orgA}'); reset role;`).split("\n").at(-2),
    "f",
    "cross-tenant paid claim rejected",
  );
  equal(
    psql(`set role service_role; select public.claim_paid_property_enrichment('${property}','${orgB}'); reset role;`).split("\n").at(-2),
    "t",
    "unlocked paid claim accepted",
  );

  const dncFirst = psqlAsync(`begin; update properties set is_dnc_locked=true where id='${property}'; select pg_sleep(0.25); commit;`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const concurrentClaim = psqlAsync(`set role service_role; select public.claim_paid_property_enrichment('${property}','${orgB}');`);
  await dncFirst;
  equal((await concurrentClaim).split("\n").at(-1), "f", "DNC winning concurrent lock prevents paid claim");

  let contactRejected = false;
  try { psql(`update contacts set first_name='late data' where id='${contact}'`); }
  catch (error) { contactRejected = /DNC_LOCKED/.test(String(error)); }
  equal(String(contactRejected), "true", "locked property rejects late contact persistence");

  let sidecarMoveRejected = false;
  try { psql(`update homeowner_details set contact_id='${replacementContact}' where contact_id='${contact}'`); }
  catch (error) { sidecarMoveRejected = /DNC_LOCKED/.test(String(error)); }
  equal(String(sidecarMoveRejected), "true", "locked contact sidecar cannot move away from its old property");

  psql(`update sequence_enrollments set status='opted_out', pause_reason='dnc' where id='${enrollment}'`);
  equal(psql(`select status||':'||pause_reason from sequence_enrollments where id='${enrollment}'`), "opted_out:dnc", "narrow compliance stop allowed");

  let enrollmentDeleteRejected = false;
  try { psql(`delete from sequence_enrollments where id='${enrollment}'`); }
  catch (error) { enrollmentDeleteRejected = /DNC_LOCKED/.test(String(error)); }
  equal(String(enrollmentDeleteRejected), "true", "locked enrollment delete rejected");

  let auditDeleteRejected = false;
  try { psql(`delete from sequence_step_runs where id='${runId}'`); }
  catch (error) { auditDeleteRejected = /DNC_LOCKED/.test(String(error)); }
  equal(String(auditDeleteRejected), "true", "locked step audit delete rejected");

  let auditUpdateRejected = false;
  try { psql(`update sequence_step_runs set skipped_reason='rewritten' where id='${runId}'`); }
  catch (error) { auditUpdateRejected = /DNC_LOCKED/.test(String(error)); }
  equal(String(auditUpdateRejected), "true", "locked step audit update rejected");

  console.log("backend paid safety rehearsal: PASS");
} finally {
  if (started) {
    try { run("pg_ctl", ["-D", cluster, "stop", "-m", "immediate"], { stdio: "ignore" }); } catch {}
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
