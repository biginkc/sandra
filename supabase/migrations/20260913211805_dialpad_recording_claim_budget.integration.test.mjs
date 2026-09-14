// Component SQL proof against disposable local Postgres, never hosted Supabase.
// Prerequisite relation shapes are fixtures; this is not a full migration replay.
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Dialpad artifact claims share durable detail budget', async () => {
  const cluster=mkdtempSync(join(tmpdir(),'dialpad-pg-'));
  const socket=mkdtempSync('/tmp/dialpad-sock-');
  const run=(name,args)=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const sql=q=>run('psql',['-h',socket,'-U','postgres','-v','ON_ERROR_STOP=1','-At','-c',q]).trim();
  const denied=(q,pattern)=>assert.throws(()=>sql(q),error=>pattern.test(String(error.stderr)));
  const asService=q=>`set role service_role;${q}`;
  let started=false;
  try {
    run('initdb',['-D',cluster,'-A','trust','-U','postgres','--no-locale']);
    run('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-k ${socket} -c listen_addresses=''`,'-w','start']);started=true;
    sql(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema extensions;create schema storage;create extension pgcrypto with schema extensions;
      grant usage on schema public,extensions to service_role;
      create table organizations(id uuid primary key);
      create table auth.users(id uuid primary key);
      create table properties(id uuid,org_id uuid,unique(id,org_id));
      create table acquisition_assignment_episodes(id uuid,property_id uuid,org_id uuid,unique(id,property_id,org_id));
      create table acquisition_commands(org_id uuid,operation text,context_key_hash text,result jsonb);
      create table storage.buckets(id text primary key,public boolean);
      insert into storage.buckets values('private-recordings',false),('public-recordings',true);`);
    sql(readFileSync(new URL('./20260913210206_dialpad_voice_persistence_foundation.sql',import.meta.url),'utf8'));
    sql(readFileSync(new URL('./20260913211805_dialpad_recording_claim_budget.sql',import.meta.url),'utf8'));
    const org=randomUUID(),otherOrg=randomUUID();
    sql(`insert into organizations values('${org}'),('${otherOrg}');`);
    sql(asService(`insert into dialpad_recording_artifacts(org_id,provider_call_id,provider_recording_id,recording_kind,status) values('${org}','1','one','admincallrecording','pending'),('${org}','2','two','admincallrecording','pending'),('${otherOrg}','3','three','admincallrecording','pending')`));
    const claim=o=>sql(asService(`select count(*) from fn_claim_dialpad_recording('${o}',180)`)).split('\n').at(-1);
    assert.equal(claim(org),'1');assert.equal(claim(org),'0');assert.equal(claim(otherOrg),'1');
    assert.equal(sql(`select next_allowed_at>now()+interval '5 seconds' from dialpad_detail_api_budget where org_id='${org}'`),'t');
    sql(asService(`select fn_defer_dialpad_detail_budget('${org}',120)`));
    assert.equal(sql(`select next_allowed_at>now()+interval '110 seconds' from dialpad_detail_api_budget where org_id='${org}'`),'t');
    sql(asService(`select fn_defer_dialpad_detail_budget('${org}',7)`));
    assert.equal(sql(`select next_allowed_at>now()+interval '110 seconds' from dialpad_detail_api_budget where org_id='${org}'`),'t');
    assert.equal(claim(org),'0');
    const oldLease=sql(`select lease_token from dialpad_recording_artifacts where org_id='${org}' and status='processing'`);
    sql(`update dialpad_recording_artifacts set lease_expires_at=now()-interval '1 second' where org_id='${org}' and status='processing';
      update dialpad_recording_artifacts set next_attempt_at=now()+interval '1 hour' where org_id='${org}' and status='pending';
      update dialpad_detail_api_budget set next_allowed_at=now()-interval '1 second' where org_id='${org}'`);
    assert.equal(claim(org),'1');
    assert.equal(sql(`select attempt_count from dialpad_recording_artifacts where org_id='${org}' and status='processing'`),'2');
    assert.notEqual(sql(`select lease_token from dialpad_recording_artifacts where org_id='${org}' and status='processing'`),oldLease);
    sql(`update dialpad_recording_artifacts set status='pending',lease_token=null,lease_expires_at=null,next_attempt_at=now() where org_id='${org}';
      update dialpad_detail_api_budget set next_allowed_at=now()-interval '1 second' where org_id='${org}'`);
    const concurrentClaim=()=>new Promise((resolve,reject)=>execFile('psql',['-h',socket,'-U','postgres','-v','ON_ERROR_STOP=1','-At','-c',asService(`select count(*) from fn_claim_dialpad_recording('${org}',180)`)],{encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(Number(stdout.trim().split('\n').at(-1)))));
    const concurrent=await Promise.all([concurrentClaim(),concurrentClaim()]);
    assert.equal(concurrent.reduce((sum,n)=>sum+n,0),1);
    denied(asService(`select fn_claim_dialpad_recording(null,180)`),/INVALID_INPUT/);
    denied(asService(`select fn_defer_dialpad_detail_budget('${org}',3601)`),/INVALID_INPUT/);
    for(const role of ['anon','authenticated']) {
      denied(`set role ${role};select fn_claim_dialpad_recording('${org}',180)`,/permission denied/);
      denied(`set role ${role};select fn_defer_dialpad_detail_budget('${org}',60)`,/permission denied/);
    }
    for(const role of ['anon','authenticated','service_role']) assert.equal(sql(`select has_table_privilege('${role}','dialpad_detail_api_budget','SELECT')`),'f');
    assert.equal(sql(`select relrowsecurity from pg_class where oid='dialpad_detail_api_budget'::regclass`),'t');
  } finally {
    if(started)run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
    rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
  }
});
