// Component SQL proof against disposable local Postgres, never hosted Supabase.
// Prerequisite relation shapes are fixtures; this is not a full migration replay.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Dialpad service persistence constraints, identity, RLS and retained audio', () => {
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
    const org=randomUUID(),otherOrg=randomUUID(),actor=randomUUID(),property=randomUUID(),episode=randomUUID(),intent=randomUUID();
    const hash=createHash('sha256').update(intent).digest('hex');
    sql(`insert into organizations values('${org}'),('${otherOrg}');insert into auth.users values('${actor}');
      insert into properties values('${property}','${org}');insert into acquisition_assignment_episodes values('${episode}','${property}','${org}');
      insert into acquisition_commands values('${org}','bind_call_context','${hash}','${JSON.stringify({tracked:true,orgId:org,propertyId:property,actorUserId:actor,assignmentEpisodeId:episode})}');`);
    const insertIntent=`insert into dialpad_voice_intents(id,org_id,actor_user_id,property_id,assignment_episode_id,binding_token_hash,dialpad_user_id,destination_e164,caller_id_e164,client_idempotency_key) values('${intent}','${org}','${actor}','${property}','${episode}','${hash}','4904023124647936','+18165550101','+18165550102','${randomUUID()}')`;
    sql(asService(insertIntent));
    denied(asService(insertIntent),/duplicate key/);
    denied(asService(`update dialpad_voice_intents set destination_e164='+18165550103'`),/DIALPAD_INTENT_IDENTITY_IMMUTABLE/);
    denied(asService(`update dialpad_voice_intents set assignment_episode_id=null`),/DIALPAD_INTENT_IDENTITY_IMMUTABLE/);
    const unbound=randomUUID();
    denied(asService(insertIntent.replaceAll(intent,unbound).replaceAll(hash,createHash('sha256').update(unbound).digest('hex'))),/DIALPAD_CALL_BINDING_REQUIRED/);
    denied(asService(insertIntent.replaceAll(intent,randomUUID())),/DIALPAD_BINDING_DIGEST_MISMATCH/);
    sql(asService(`update dialpad_voice_intents set provider_call_id='9007199254740993',status='linked'`));
    denied(asService(`update dialpad_voice_intents set provider_call_id='9007199254740994'`),/DIALPAD_INTENT_IDENTITY_IMMUTABLE/);
    assert.equal(sql('select provider_call_id from dialpad_voice_intents'),'9007199254740993');
    const inbox=`insert into dialpad_voice_event_inbox(org_id,envelope_sha256,payload) values('${org}','${'a'.repeat(64)}','{"state":"ringing"}')`;
    sql(asService(inbox));denied(asService(inbox),/duplicate key/);
    denied(asService(`update dialpad_voice_event_inbox set payload='{}'`),/DIALPAD_ENVELOPE_IMMUTABLE/);
    denied(asService(`update dialpad_voice_event_inbox set status='processing'`),/check constraint/);
    const lease=randomUUID();
    sql(asService(`update dialpad_voice_event_inbox set status='processing',lease_token='${lease}',lease_expires_at=now()+interval '1 minute',attempt_count=attempt_count+1 where status='pending'`));
    assert.equal(sql(asService(`with changed as (update dialpad_voice_event_inbox set status='processed',processed_at=now(),lease_token=null,lease_expires_at=null where lease_token='${randomUUID()}' returning id) select count(*) from changed`)).split('\n').at(-1),'0');
    sql(asService(`update dialpad_voice_event_inbox set status='processed',processed_at=now(),lease_token=null,lease_expires_at=null where lease_token='${lease}'`));
    const artifact=`insert into dialpad_recording_artifacts(org_id,provider_call_id,provider_recording_id,recording_kind,intent_id) values('${org}','9007199254740993','segment-1','admincallrecording','${intent}')`;
    sql(asService(artifact));denied(asService(artifact),/duplicate key/);
    denied(asService(artifact.replace('9007199254740993','9007199254740994').replace('segment-1','segment-2')),/DIALPAD_RECORDING_CALL_MISMATCH/);
    denied(asService(artifact.replaceAll(org,otherOrg)),/DIALPAD_RECORDING_CALL_MISMATCH/);
    denied(asService(`update dialpad_recording_artifacts set status='available',storage_bucket='private-recordings'`),/check constraint/);
    const available=`update dialpad_recording_artifacts set status='available',storage_bucket='private-recordings',storage_path='${org}/call/segment.mp3',content_sha256='${'b'.repeat(64)}',byte_count=100,decoded_duration_seconds=2.5,media_type='audio/mpeg',verified_at=now()`;
    denied(asService(available.replace('private-recordings','public-recordings')),/DIALPAD_PRIVATE_STORAGE_REQUIRED/);
    sql(asService(available));
    denied(asService(`update dialpad_recording_artifacts set storage_path='https://dialpad.com/file'`),/check constraint/);
    denied(asService(`update dialpad_recording_artifacts set decoded_duration_seconds='NaN'`),/check constraint/);
    denied(asService(`update dialpad_recording_artifacts set decoded_duration_seconds=0`),/check constraint/);
    denied(asService(`update dialpad_recording_artifacts set intent_id=null`),/DIALPAD_RECORDING_INTENT_IMMUTABLE/);
    for(const table of ['dialpad_voice_intents','dialpad_voice_event_inbox','dialpad_recording_artifacts']) {
      assert.equal(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`),'t');
      for(const role of ['anon','authenticated']) {
        for(const privilege of ['SELECT','INSERT','UPDATE','DELETE']) assert.equal(sql(`select has_table_privilege('${role}','public.${table}','${privilege}')`),'f');
        denied(`set role ${role};select * from ${table}`,/permission denied/);
      }
      assert.equal(sql(`select has_table_privilege('service_role','public.${table}','DELETE')`),'f');
    }
    assert.equal(sql(`select has_function_privilege('authenticated','public.dialpad_voice_persistence_guard()','EXECUTE')`),'f');
  } finally {
    if(started)run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
    rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
  }
});
