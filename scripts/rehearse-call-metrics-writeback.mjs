#!/usr/bin/env node
// Isolated PostgreSQL rehearsal of the additive wrapper; original matching is
// stubbed here, and remains covered by the existing writeback integration suite.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster=mkdtempSync(join(tmpdir(),'call-metrics-'));
const socket=mkdtempSync('/tmp/cmsock-');
const port=21000+Math.floor(Math.random()*1000);
const run=(name,args)=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=q=>run('psql',['-h',socket,'-p',String(port),'-U','postgres','-v','ON_ERROR_STOP=1','-At','-c',q]).trim();
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let started=false;
try {
  run('initdb',['-D',cluster,'-A','trust','-U','postgres','--no-locale']);
  run('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-k ${socket} -p ${port} -h ''`,'-w','start']);started=true;
  sql(`create role anon;create role authenticated;create role service_role;create schema auth;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    grant usage on schema auth to service_role,authenticated;
    create table call_activities(id uuid primary key,org_id uuid,jitter_attempt_id text,jitter_session_id text,provider text,
      talk_duration_seconds integer,recording_expected boolean,provider_ended_at timestamptz,ended_at timestamptz,notes text,provider_call_id text,property_id uuid,contact_id uuid,operator_user_id uuid);
    create table webhook_events(org_id uuid,provider text,event_type text,external_id text,processing_status text,request_hash text,payload jsonb,processed_at timestamptz);
    insert into call_activities values('${id}','${org}','attempt','session','sandra_softphone',null,null,null,null,'rep notes','seller-leg',null,null,null);
    create function jitter_writeback_call_activity(text,jsonb,uuid,text,text,uuid,text,text) returns jsonb language plpgsql as $$
    begin
      update public.call_activities set ended_at=($2->>'ended_at')::timestamptz where id='${id}';
      return jsonb_build_object('call_activity',jsonb_build_object('id','${id}'));
    end $$;
  `);
  sql(readFileSync(new URL('../supabase/migrations/20260913121000_jitter_call_metrics_evidence.sql',import.meta.url),'utf8'));
  const invoke=(body,key='evidence')=>`select set_config('request.jwt.claim.role','service_role',false);set role service_role;select jitter_writeback_call_activity('attempt','${JSON.stringify({org_id:org,jitter_session_id:'session',provider:'sandra_softphone',provider_call_id:'seller-leg',...body})}'::jsonb,null,'${key}',null,'${org}',null,'hash');`;
  const reserve=key=>sql(`insert into webhook_events(org_id,provider,event_type,external_id,processing_status,request_hash) values('${org}','jitter','call_activity_writeback','${key}','pending','hash')`);
  reserve('evidence');
  sql(invoke({call_evidence_version:1,ended_at:'2026-09-13T12:05:01Z',talk_duration_seconds:301,recording_expected:true,notes:'must not overwrite'}));
  assert.equal(sql(`select talk_duration_seconds||':'||recording_expected||':'||notes from call_activities`),'301:true:rep notes');
  assert.equal(sql(`select processing_status from webhook_events where external_id='evidence'`),'processed');
  sql(invoke({ended_at:'2026-09-13T12:04:00Z',talk_duration_seconds:99,recording_expected:false},'ordinary'));
  assert.equal(sql(`select ended_at=provider_ended_at from call_activities`),'t');
  assert.equal(sql(`select talk_duration_seconds from call_activities`),'301');
  reserve('unknown');sql(invoke({call_evidence_version:1,ended_at:'2026-09-13T12:05:01Z',talk_duration_seconds:null,recording_expected:null},'unknown'));
  assert.equal(sql(`select talk_duration_seconds from call_activities`),'301');
  for(const bad of [{talk_duration_seconds:-1},{talk_duration_seconds:1.5},{talk_duration_seconds:2147483648},{recording_expected:'true'},{call_evidence_version:2,ended_at:'2026-09-13T12:05:01Z'}]) assert.throws(()=>sql(invoke(bad)));
  assert.throws(()=>sql(invoke({call_evidence_version:1,ended_at:'2026-09-13T12:06:00Z',talk_duration_seconds:360},'unreserved')),/reservation/);
  assert.equal(sql(`select talk_duration_seconds from call_activities`),'301','failed receipt rolls back evidence');
  reserve('wrong-leg');assert.throws(()=>sql(invoke({provider_call_id:'agent-leg',call_evidence_version:1,ended_at:'2026-09-13T12:06:00Z'},'wrong-leg')),/identity mismatch/);
  for(const field of ['property_id','contact_id','operator_user_id']) {
    reserve(field);assert.throws(()=>sql(invoke({[field]:org,call_evidence_version:1,ended_at:'2026-09-13T12:06:00Z'},field)),/identity mismatch/);
  }
  reserve('foreign');assert.throws(()=>sql(invoke({org_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',call_evidence_version:1,ended_at:'2026-09-13T12:06:00Z'},'foreign')),/coherence/);
  assert.throws(()=>sql(`set role authenticated;select jitter_writeback_call_activity('attempt','{}',null,null,null,'${org}',null,null)`),/permission denied/);
  assert.equal(sql(`select has_function_privilege('service_role','jitter_writeback_call_activity_before_metrics(text,jsonb,uuid,text,text,uuid,text,text)','execute')`),'f');
  console.log('PASS: signed call evidence validation, exact identity, rep notes preserved, terminal time retained, nullable compatibility, atomic receipt rollback, service-role grants.');
} finally {
  if(started)run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
  rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
}
