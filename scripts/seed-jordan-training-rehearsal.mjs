import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const db=`seed_jordan_rehearsal_${process.pid}`;
const supplied=process.env.LOCAL_REHEARSAL_DATABASE_URL;
assert.ok(supplied,'LOCAL_REHEARSAL_DATABASE_URL is required');
const parsed=new URL(supplied);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'Rehearsal requires localhost');
parsed.pathname='/';
const base=parsed.toString();
const admin=new Client({connectionString:base+'postgres'});
let client;
try {
 await admin.connect(); await admin.query(`create database ${db}`);
 client=new Client({connectionString:base+db}); await client.connect();
 await client.query(`create schema auth; create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
 create table contacts(id uuid primary key,org_id uuid,first_name text,last_name text,phone_1 text,phone_2 text,phone_3 text,phone_1_type text default 'unknown',phone_2_type text default 'unknown',phone_3_type text default 'unknown',email text,do_not_contact boolean default false,sms_opted_out boolean default false,sms_opted_out_at timestamptz);
 create table properties(id uuid primary key,org_id uuid,address text,city text,state text,homeowner_contact_id uuid references contacts(id),status text,year_built int,beds int,baths numeric,sqft int,mortgage_balance numeric,listing_price numeric,is_vacant boolean,absentee_flag boolean,notes text,is_dnc_locked boolean default false,outreach_dispo text,ai_responder_disabled boolean default false,skip_trace_disabled boolean default false);
 create table lead_notes(id uuid primary key,org_id uuid,property_id uuid references properties(id),body text);
 create table messages(id uuid,property_id uuid,contact_id uuid,direction text,to_address text);
 create table sequence_enrollments(id uuid,property_id uuid,contact_id uuid);
 create table tasks(id uuid,related_property_id uuid,contact_id uuid);
 create table esign_requests(id uuid,property_id uuid,contact_id uuid);
 create table consent_events(id uuid,property_id uuid,contact_id uuid);`);
 // Cluster roles are dependencies only, never changed or removed.
 const roles=await admin.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')");
 for (const role of ['anon','authenticated','service_role']) {
  if (!roles.rows.some(row=>row.rolname===role)) await admin.query(`create role ${role} nologin`);
 }
 await client.query(await readFile(new URL('../supabase/migrations/20260908120000_training_lead_guards.sql',import.meta.url),'utf8'));
 const phoneMigration=await readFile(new URL('../supabase/migrations/20260902174035_save_unverified_lead_phone.sql',import.meta.url),'utf8');
 await client.query(phoneMigration.slice(phoneMigration.indexOf('create or replace function public.enforce_phone_type_on_write()'),phoneMigration.indexOf('create or replace function public.save_unverified_lead_phone(')));
 await assert.rejects(client.query("insert into contacts(id,phone_1) values('00000000-0000-4000-8000-000000000002','+18165440196')"), /phone_1 requires a line type/);
 function run(args=[],ok=true){const x=spawnSync(process.execPath,[new URL('./seed-jordan-training.mjs',import.meta.url).pathname,'--local-rehearsal',...args],{env:{...process.env,SANDRA_PRODUCTION_DATABASE_URL:base+db},encoding:'utf8'});assert.equal(x.status,ok?0:1,x.stderr);return x.stdout;}
 assert.match(run(),/would_create/);assert.equal((await client.query('select * from contacts')).rowCount,0);
 assert.match(run(['--apply']),/committed/);assert.match(run(['--apply']),/already_seeded/);assert.match(run(),/already_seeded/);
 const p=(await client.query('select * from properties')).rows;assert.equal(p.length,1);assert.equal(p[0].is_training,true);assert.equal(p[0].ai_responder_disabled,true);assert.equal(p[0].skip_trace_disabled,true);assert.match(p[0].notes,/age 47/);
 assert.equal((await client.query('select * from contacts')).rowCount,1);assert.equal((await client.query('select phone_1_type from contacts')).rows[0].phone_1_type,'unknown');assert.equal((await client.query('select * from lead_notes')).rowCount,1);
 await client.query('begin');
 await client.query("select set_config('sandra.allow_unverified_lead_phone','on',true)");
 await client.query("insert into contacts(id,phone_1) values('00000000-0000-4000-8000-000000000001','+18165440196')");
 await client.query('commit');run(['--apply'],false);assert.equal((await client.query('select * from properties')).rowCount,1);
 await client.query("delete from contacts where id='00000000-0000-4000-8000-000000000001'");
 await client.query('alter table messages disable trigger guard_training_messages');run(['--apply'],false);
 console.log('Jordan seed rehearsal passed: actual guards, dry-run no writes, atomic apply, repeat/no duplicates, factual fields, conflicts and missing guard refusal.');
} finally {await client?.end();await admin.query(`drop database if exists ${db}`);await admin.end();}
