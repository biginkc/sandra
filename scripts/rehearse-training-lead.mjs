#!/usr/bin/env node
// Local disposable PostgreSQL only; no hosted credentials or provider calls.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster = mkdtempSync(join(tmpdir(), 'training-lead-'));
const socket = mkdtempSync('/tmp/tlsock-');
const port = 19000 + Math.floor(Math.random() * 1000);
const run = (name,args) => execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql = query => run('psql',['-h',socket,'-p',String(port),'-U','postgres','-v','ON_ERROR_STOP=1','-At','-c',query]).trim();
const property = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contact = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ordinary = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const org = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deny = query => assert.throws(() => sql(query), /TRAINING_PROTECTED/);
let started=false;
try {
  run('initdb',['-D',cluster,'-A','trust','-U','postgres','--no-locale']);
  run('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-k ${socket} -p ${port} -h ''`,'-w','start']); started=true;
  sql(`create role anon; create role authenticated; create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    create table contacts(id uuid primary key,org_id uuid,phone_1 text,phone_2 text,phone_3 text,do_not_contact boolean default false,sms_opted_out boolean default false,sms_opted_out_at timestamptz);
    create table properties(id uuid primary key,org_id uuid,homeowner_contact_id uuid references contacts(id),is_dnc_locked boolean default false,outreach_dispo text,status text default 'new_lead',notes text);
    create table messages(id uuid default gen_random_uuid(),property_id uuid,contact_id uuid,direction text,to_address text,status text);
    create table sequence_enrollments(id uuid default gen_random_uuid(),property_id uuid,contact_id uuid,status text);
    create table tasks(id uuid default gen_random_uuid(),related_property_id uuid,contact_id uuid,type text);
    create table esign_requests(id uuid default gen_random_uuid(),property_id uuid);
    create table consent_events(id uuid default gen_random_uuid(),contact_id uuid,event_type text);
    insert into contacts(id,org_id,phone_1) values('${contact}','${org}','+12025550196'),('${ordinary}','${org}','+12025550197');
  `);
  sql(readFileSync(new URL('../supabase/migrations/20260908120000_training_lead_guards.sql',import.meta.url),'utf8'));
  const seed=`insert into properties(id,org_id,homeowner_contact_id,is_training) values('${property}','${org}','${contact}',true)`;
  deny(seed);
  sql(`select set_config('request.jwt.claim.role','service_role',false); ${seed}`);
  sql(`insert into properties(id,org_id,homeowner_contact_id) values('${ordinary}','${org}','${ordinary}')`);
  for (const change of [`id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'`,'is_training=false',`homeowner_contact_id='${ordinary}'`,'is_dnc_locked=true',"outreach_dispo='dnc'","status='offer_sent'",`org_id='${ordinary}'`]) deny(`update properties set ${change} where id='${property}'`);
  deny(`update properties set is_training=true where id='${ordinary}'`);
  deny(`update properties set homeowner_contact_id='${contact}' where id='${ordinary}'`);
  deny(`delete from properties where id='${property}'`);
  for (const change of [`id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'`,"phone_1='+12025550198'","phone_2='+12025550198'","phone_3='+12025550198'",'do_not_contact=true','sms_opted_out=true',`org_id='${ordinary}'`]) deny(`update contacts set ${change} where id='${contact}'`);
  deny(`delete from contacts where id='${contact}'`);
  for (const table of ['messages','sequence_enrollments','tasks','esign_requests']) {
    const field=table==='tasks'?'related_property_id':'property_id';
    const extra=table==='messages'?",direction":"";
    const value=table==='messages'?",'outbound'":"";
    deny(`insert into ${table}(${field}${extra}) values('${property}'${value})`);
    sql(`insert into ${table}(${field}${extra}) values('${ordinary}'${value})`);
    deny(`update ${table} set ${field}='${property}' where ${field}='${ordinary}'`);
    if(table!=='esign_requests') deny(`insert into ${table}(contact_id${extra}) values('${contact}'${value})`);
  }
  deny(`insert into messages(direction,to_address) values('outbound','+12025550196')`);
  deny(`insert into consent_events(contact_id,event_type) values('${contact}','opt_out')`);
  sql(`insert into consent_events(contact_id,event_type) values('${ordinary}','opt_out');
    insert into messages(direction,contact_id) values('inbound','${contact}');
    update properties set notes='Fictional profile facts' where id='${property}';
    update properties set outreach_dispo='nurture' where id='${ordinary}';`);
  assert.equal(sql(`select count(*) from properties where is_training`),'1');
  assert.equal(sql(`select count(*) from messages where direction='outbound' and (contact_id='${contact}' or property_id='${property}')`),'0');
  console.log('PASS: training seed authority, immutable marker/contact/phones, no outbound messaging/enrollment/tasks/esign/consent, update bypass rejection, ordinary customer and inbound/profile paths preserved.');
} finally {
  if(started) run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
  rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
}
