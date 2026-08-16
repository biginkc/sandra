#!/usr/bin/env node
// Applies the real CSV import truthfulness migration twice to a disposable,
// host-only PostgreSQL cluster. This never reads or writes a hosted database.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cluster = mkdtempSync(join(tmpdir(), "sandra-csv-truth-"));
const socketDir = mkdtempSync("/tmp/sctsock-");
const port = 6040 + Math.floor(Math.random() * 400);
const migration = fileURLToPath(
  new URL("../supabase/migrations/20260815120000_csv_import_truthfulness.sql", import.meta.url),
);
let started = false;

function run(name, args, options = {}) {
  return execFileSync(name, args, { stdio: "inherit", ...options });
}

function psql(sql) {
  return execFileSync(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    { encoding: "utf8" },
  ).trim();
}

const orgA = "00000000-0000-0000-0000-00000000000a";
const orgB = "00000000-0000-0000-0000-00000000000b";

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

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      run("pg_isready", ["-h", socketDir, "-p", String(port), "-U", "postgres"], { stdio: "ignore" });
      break;
    } catch {
      if (attempt === 49) throw new Error("Disposable PostgreSQL cluster never became ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  psql(`
    create table organizations (id uuid primary key);
    insert into organizations values ('${orgA}'), ('${orgB}');

    create table contacts (
      id uuid primary key,
      org_id uuid not null references organizations(id),
      contact_type text not null,
      phone_1 text,
      email text,
      first_name text,
      last_name text,
      entity_name text,
      unique (id, org_id)
    );
    create unique index contacts_phone_1_key on contacts(phone_1) where phone_1 is not null;
    create unique index contacts_email_key on contacts(lower(email)) where email is not null and phone_1 is null;
    create unique index contacts_person_name_key on contacts(lower(last_name), lower(first_name))
      where contact_type='person' and phone_1 is null and email is null and last_name is not null and first_name is not null;
    create unique index contacts_entity_name_key on contacts(lower(entity_name))
      where contact_type='entity' and phone_1 is null and email is null and entity_name is not null;

    create table homeowner_details (
      contact_id uuid primary key references contacts(id) on delete cascade,
      org_id uuid not null references organizations(id)
    );
    create table agent_details (
      contact_id uuid primary key references contacts(id) on delete cascade,
      org_id uuid not null references organizations(id)
    );
    create table consent_events (
      id uuid primary key,
      contact_id uuid not null references contacts(id) on delete cascade,
      org_id uuid not null references organizations(id)
    );

    create table csv_imports (id uuid primary key, org_id uuid not null references organizations(id));
    create table properties (
      id uuid primary key,
      org_id uuid not null references organizations(id),
      deleted_at timestamptz,
      fips_code text,
      apn_normalized text,
      regrid_id text,
      attom_id text,
      zpid text,
      mls_number text,
      address_normalized text
    );
    create unique index properties_fips_apn_key on properties(fips_code, apn_normalized)
      where fips_code is not null and apn_normalized is not null and deleted_at is null;
    create unique index properties_regrid_key on properties(regrid_id) where regrid_id is not null and deleted_at is null;
    create unique index properties_attom_key on properties(attom_id) where attom_id is not null and deleted_at is null;
    create unique index properties_zpid_key on properties(zpid) where zpid is not null and deleted_at is null;
    create unique index properties_mls_number_key on properties(mls_number) where mls_number is not null and deleted_at is null;
    create unique index properties_address_normalized_key on properties(address_normalized)
      where address_normalized is not null and deleted_at is null;

    create table jobs (id uuid primary key, status text not null);
    create index idx_jobs_status on jobs(status);
    create table job_items (id uuid primary key, job_id uuid not null references jobs(id));

    insert into contacts values
      ('10000000-0000-0000-0000-000000000001','${orgA}','person','8165550101',null,'Pat','Phone',null),
      ('10000000-0000-0000-0000-000000000002','${orgA}','person',null,'same@example.com','Em','Ail',null),
      ('10000000-0000-0000-0000-000000000003','${orgA}','person',null,null,'Same','Person',null),
      ('10000000-0000-0000-0000-000000000004','${orgA}','entity',null,null,null,null,'Same LLC');
    insert into homeowner_details values ('10000000-0000-0000-0000-000000000001','${orgB}');
    insert into agent_details values ('10000000-0000-0000-0000-000000000002','${orgB}');
    insert into consent_events values (
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '${orgB}'
    );
    insert into properties values (
      '30000000-0000-0000-0000-000000000001','${orgA}',null,
      '29021','apn-1','regrid-1','attom-1','zpid-1','mls-1','1 main st'
    );
  `);

  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration]);
  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration]);

  psql(`
    insert into contacts values
      ('11000000-0000-0000-0000-000000000001','${orgB}','person','8165550101',null,'Pat','Phone',null),
      ('11000000-0000-0000-0000-000000000002','${orgB}','person',null,'same@example.com','Em','Ail',null),
      ('11000000-0000-0000-0000-000000000003','${orgB}','person',null,null,'Same','Person',null),
      ('11000000-0000-0000-0000-000000000004','${orgB}','entity',null,null,null,null,'Same LLC');
    insert into properties(id,org_id,fips_code,apn_normalized,regrid_id,attom_id,zpid,mls_number,address_normalized)
      values ('31000000-0000-0000-0000-000000000001','${orgB}','29021','apn-1','regrid-1','attom-1','zpid-1','mls-1','1 main st');

    do $$ begin
      begin
        insert into contacts values
          ('12000000-0000-0000-0000-000000000001','${orgA}','person','8165550101',null,'Other','Person',null);
        raise exception 'same-org contact duplicate was accepted';
      exception when unique_violation then null; end;
      begin
        insert into properties(id,org_id,address_normalized)
          values ('32000000-0000-0000-0000-000000000001','${orgA}','1 main st');
        raise exception 'same-org property duplicate was accepted';
      exception when unique_violation then null; end;
      begin
        insert into consent_events values (
          '22000000-0000-0000-0000-000000000001',
          '10000000-0000-0000-0000-000000000001',
          '${orgB}'
        );
        raise exception 'cross-org consent event was accepted';
      exception when foreign_key_violation then null; end;
    end $$;
  `);

  const mismatchedSidecars = psql(`
    select count(*) from (
      select contact_id, org_id from homeowner_details
      union all select contact_id, org_id from agent_details
      union all select contact_id, org_id from consent_events
    ) owned join contacts on contacts.id=owned.contact_id
    where owned.org_id is distinct from contacts.org_id;
  `);
  if (mismatchedSidecars !== "0") throw new Error(`Tenant sidecar backfill left ${mismatchedSidecars} mismatch(es)`);

  const importedIndex = psql(`
    select indexdef from pg_indexes
    where schemaname='public' and indexname='idx_properties_org_source_imported_at';
  `).toLowerCase();
  for (const required of ["org_id, source_imported_at", "source_import_id is not null", "source_imported_at is not null", "deleted_at is null"]) {
    if (!importedIndex.includes(required)) throw new Error(`Imported Today index is missing: ${required}`);
  }

  console.log("CSV import truthfulness migration rehearsal: PASS");
  console.log("- real migration applies twice");
  console.log("- identical identifiers coexist across organizations");
  console.log("- same-organization duplicates remain rejected");
  console.log("- sidecars/events are backfilled and composite-FK protected");
  console.log("- Imported Today tenant/time index is structurally correct");
} finally {
  if (started) {
    try {
      run("pg_ctl", ["-D", cluster, "-m", "immediate", "stop"], { stdio: "ignore" });
    } catch {}
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
