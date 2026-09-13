#!/usr/bin/env node
// Real read model, reconciliation, and metrics migrations in disposable PostgreSQL.
// Minimal pre-acquisition fixture schema; no hosted credentials or durable writes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster=mkdtempSync(join(tmpdir(),'my-leads-metrics-'));
const socket=mkdtempSync('/tmp/mlmsock-');
const port=19000+Math.floor(Math.random()*1000);
const run=(name,args)=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=q=>run('psql',['-h',socket,'-p',String(port),'-U','postgres','-v','ON_ERROR_STOP=1','-Atq','-c',q]).trim();
const migration=name=>sql(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),rep=id(2),other=id(3),owner=id(4),property=id(10);
const auth=`select set_config('request.jwt.claim.sub','${rep}',false); set role authenticated;`;
const kpi=()=>JSON.parse(sql(`${auth} select public.fn_get_acquisition_kpis('${org}','${rep}',date_trunc('day',now())-interval '1 day',date_trunc('day',now())+interval '1 day');`).split('\n').at(-1));
let started=false;
try {
 run('initdb',['-D',cluster,'-A','trust','-U','postgres','--no-locale']);
 run('pg_ctl',['-D',cluster,'-l',join(cluster,'server.log'),'-o',`-k ${socket} -p ${port} -h ''`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role;create schema auth;create schema extensions;
 create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
 create table memberships(org_id uuid,user_id uuid,role text default 'member',access_status text default 'active',deletion_prepared_at timestamptz,access_expires_at timestamptz,acquisitions_enabled boolean default true);
 create table acquisition_org_settings(org_id uuid primary key,my_leads_enabled boolean);
 create table contacts(id uuid,org_id uuid,first_name text,last_name text,phone_1 text,phone_2 text,phone_3 text,do_not_contact boolean);
 create table properties(id uuid primary key,org_id uuid,assigned_user_id uuid,address text,city text,state text,zip text,status text default 'contacted',motivation_level text,homeowner_contact_id uuid,deleted_at timestamptz,is_dnc_locked boolean default false);
 create table acquisition_assignment_episodes(id uuid primary key,org_id uuid,property_id uuid,assignee_user_id uuid,assigned_at timestamptz,initialized_at timestamptz default now(),ended_at timestamptz,eligible boolean default false,episode_kind text default 'live',first_call_started_at timestamptz);
 create table acquisition_queue_states(property_id uuid,org_id uuid,stage text,version bigint default 1,stage_entered_at timestamptz default now(),motivation_kind text,motivation_text text,archived_at timestamptz);
 create table acquisition_commands(id uuid primary key default gen_random_uuid(),org_id uuid,actor_kind text,actor_user_id uuid,operation text,idempotency_key uuid,request_hash text,result jsonb);
 create table call_activities(id uuid primary key,org_id uuid,property_id uuid,operator_user_id uuid,provider text,jitter_attempt_id text,provider_call_id text,outcome text,notes text,recording_path text,ended_at timestamptz,duration_seconds integer);
 create table call_recordings(id uuid default gen_random_uuid(),call_activity_id uuid,status text,storage_path text);
 create table acquisition_attempts(id uuid primary key,org_id uuid,property_id uuid,actor_user_id uuid,attempt_kind text,source text,outcome text,occurred_at timestamptz,call_activity_id uuid,command_id uuid,note text,recording_url text);
 create table acquisition_offers(id uuid primary key,org_id uuid,property_id uuid,actor_user_id uuid,sent_at timestamptz,amount_cents bigint,sent_via text,follow_up_at timestamptz,outcome text);
 create table tasks(id uuid primary key,org_id uuid,related_property_id uuid,assignee_id uuid,type text,status text,due_at timestamptz,snoozed_until timestamptz,outcome text);
 create function acquisition_working_deadline(timestamptz) returns timestamptz language sql as $$select $1+interval '4 hours'$$;
 create function my_leads_command_hash(text,uuid,uuid,jsonb) returns text language sql as $$select md5($1||$2::text||$3::text||$4::text)$$;
 insert into auth.users values('${rep}'),('${other}'),('${owner}');insert into organizations values('${org}');
 insert into memberships(org_id,user_id,role) values('${org}','${rep}','member'),('${org}','${owner}','owner');
 insert into acquisition_org_settings values('${org}',true);
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 `);
 migration('20260912110000_acquisition_read_model.sql');
 migration('20260912111000_acquisition_kpis.sql');
 migration('20260912130000_acquisition_call_reconciliation.sql');
 // Existing inferred outcome and an explicit receipt must diverge at migration.
 sql(`insert into properties(id,org_id,assigned_user_id) values('${property}','${org}','${rep}');
 insert into acquisition_assignment_episodes(id,org_id,property_id,assignee_user_id) values('${id(11)}','${org}','${property}','${rep}');
 insert into acquisition_queue_states(property_id,org_id,stage) values('${property}','${org}','contacted');
 insert into acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at)
 values('${id(20)}','${org}','${property}','${rep}','call','sandra','reached',now()-interval '1 hour'),
 ('${id(21)}','${org}','${property}','${rep}','call','sandra','no_answer',now()-interval '1 hour');
 insert into acquisition_commands(org_id,operation,result) values('${org}','finalize_acquisition_attempt','{"attemptId":"${id(21)}"}');`);
 migration('20260913100000_my_leads_metrics.sql');
 assert.equal(sql(`select coalesce(outcome,'pending') from acquisition_attempts where id='${id(20)}'`),'pending');
 assert.equal(sql(`select outcome from acquisition_attempts where id='${id(21)}'`),'no_answer');
 let result=kpi();assert.equal(result.contactWithoutFollowUp,1);assert.equal(result.attempts,2);assert.equal(result.firstCallSamples,0);assert.equal(result.appointmentsHeld,0);assert.equal(result.reached,0);assert.equal(result.recordingExpectationUnknown,2);
 // A callback does not fulfill an appointment requirement.
 sql(`insert into tasks values('${id(30)}','${org}','${property}','${rep}','callback','open',now()+interval '1 day',null,null)`);
 assert.equal(kpi().contactWithoutFollowUp,1);
 sql(`insert into tasks values('${id(31)}','${org}','${property}','${rep}','appointment','open',now()+interval '1 day',null,null)`);
 assert.equal(kpi().contactWithoutFollowUp,0);
 sql(`update tasks set due_at=now()-interval '2 days' where id='${id(31)}'`);
 result=kpi();assert.equal(result.contactWithoutFollowUp,1);assert.equal(result.appointmentsOverdue,1);
 sql(`update tasks set status='snoozed',snoozed_until=now()+interval '1 day' where id='${id(31)}'`);
 result=kpi();assert.equal(result.contactWithoutFollowUp,0);assert.equal(result.appointmentsOverdue,1);
 sql(`insert into tasks values('${id(32)}','${org}','${property}','${rep}','appointment','open',now()-interval '3 days',null,null),
 ('${id(33)}','${org}','${property}','${other}','appointment','open',now()-interval '3 days',null,null),
 ('${id(34)}','${org}','${property}','${rep}','appointment','completed',now()-interval '3 days',null,'rescheduled');`);
 assert.equal(kpi().appointmentsOverdue,2);
 sql(`update tasks set assignee_id='${other}' where id='${id(32)}'; update acquisition_queue_states set stage='needs_offer' where property_id='${property}'`);
 result=kpi();assert.equal(result.needsOffers,1);assert.equal(result.appointmentsOverdue,1);
 sql(`update properties set is_dnc_locked=true where id='${property}'`);assert.equal(kpi().needsOffers,0);assert.equal(kpi().appointmentsOverdue,0);
 sql(`update properties set is_dnc_locked=false where id='${property}'`);
 // Explicit outcomes determine reaches; total duration never becomes talk time.
 for(const [n,outcome,talk,expected,path,age] of [
 [40,'reached',300,true,null,'10 minutes'],[41,'reached',301,true,'stored.wav','10 minutes'],
 [42,'reached',null,null,null,'10 minutes'],[43,'no_answer',600,true,null,'10 minutes'],
 [44,'no_answer',null,true,null,'1 minute'],[45,'no_answer',null,false,null,'10 minutes']]) {
 sql(`insert into call_activities(id,org_id,property_id,provider,ended_at,duration_seconds,talk_duration_seconds,recording_expected,recording_path)
 values('${id(n)}','${org}','${property}','dialpad',now()-interval '${age}',900,${talk??'null'},${expected??'null'},${path?`'${path}'`:'null'});
 insert into acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,call_activity_id)
 values('${id(n+100)}','${org}','${property}','${rep}','call','dialpad','${outcome}',now()-interval '1 hour','${id(n)}');`);
 }
 sql(`insert into acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at)
 values('${id(150)}','${org}','${property}','${rep}','outreach','manual','reached',now()-interval '1 minute');
 insert into acquisition_offers(id,org_id,property_id,actor_user_id,sent_at) values('${id(151)}','${org}','${property}','${rep}',now());`);
 result=kpi();assert.equal(result.attempts,9);assert.equal(result.reached,4);assert.equal(result.missingRecordings,2);
 assert.equal(result.averageTalkSeconds,300.5);assert.equal(result.talkTimeSamples,2);assert.equal(result.talkTimeUnknown,1);
 assert.equal(result.conversationsOverFiveMinutes,1);assert.equal(result.recordingExpectationUnknown,3);assert.equal(result.offersSent,1);
 // Date range affects activity only. Both half-open boundaries are exercised.
 sql(`insert into acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at)
 values('${id(180)}','${org}','${property}','${rep}','outreach','manual','reached','2026-01-01T06:00:00Z'),
 ('${id(181)}','${org}','${property}','${rep}','outreach','manual','reached','2026-01-02T06:00:00Z');`);
 const historical=JSON.parse(sql(`${auth} select fn_get_acquisition_kpis('${org}','${rep}','2026-01-01T06:00:00Z','2026-01-02T06:00:00Z')`).split('\n').at(-1));
 assert.equal(historical.attempts,1);assert.equal(historical.reached,1);assert.equal(historical.needsOffers,1);assert.equal(historical.appointmentsOverdue,1);
 // A queue filter with no results has no effect on subsequent KPIs.
 sql(`${auth} select fn_get_acquisition_queue_page('${org}','${rep}','no matching address');`);
 assert.equal(kpi().attempts,9);assert.equal(kpi().needsOffers,1);
 assert.equal(sql(`select max(occurred_at) from acquisition_attempts where id='${id(150)}'`),sql(`select ('${result.lastAttemptAt}'::timestamptz)`));
 sql(`update acquisition_attempts set recording_url='https://example.test/recording' where id='${id(140)}'`);assert.equal(kpi().missingRecordings,1);
 // Authoritative provider end wins over a later browser wrap-up timestamp.
 sql(`update call_activities set provider_ended_at=now()-interval '10 minutes',ended_at=now() where id='${id(43)}'`);assert.equal(kpi().missingRecordings,1);
 // A late child recording counts as available without denormalized activity path.
 sql(`insert into call_recordings(call_activity_id,status,storage_path) values('${id(43)}','pending',null)`);assert.equal(kpi().missingRecordings,1);
 sql(`insert into call_recordings(call_activity_id,status,storage_path) values('${id(43)}','available','recording.wav'),('${id(43)}','available','duplicate.wav')`);
 assert.equal(kpi().missingRecordings,0);assert.equal(kpi().attempts,9);assert.equal(kpi().talkTimeSamples,2);
 // Browser grants cannot manufacture provider evidence, including inserts.
 sql('grant select,insert,update on call_activities to authenticated');
 assert.throws(()=>sql(`${auth} update call_activities set talk_duration_seconds=100 where id='${id(42)}'`),/PROVIDER_EVIDENCE_READ_ONLY/);
 assert.throws(()=>sql(`${auth} insert into call_activities(id,recording_expected) values('${id(160)}',true)`),/PROVIDER_EVIDENCE_READ_ONLY/);
 assert.throws(()=>sql(`${auth} update call_activities set provider_ended_at=now() where id='${id(43)}'`),/PROVIDER_EVIDENCE_READ_ONLY/);
 // Late provider answer links the call but cannot finalize it. Rep then selects voicemail/no-answer.
 sql(`insert into acquisition_commands(id,org_id,operation,result) values('${id(170)}','${org}','record_call_start','{"jitterCallId":"test-call","sellerProviderCallId":"seller"}');
 insert into acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,occurred_at,command_id)
 values('${id(171)}','${org}','${property}','${rep}','call','sandra',now(),'${id(170)}');
 insert into call_activities(id,org_id,property_id,operator_user_id,provider,jitter_attempt_id,provider_call_id,outcome)
 values('${id(172)}','${org}','${property}','${rep}','sandra_softphone','sandra-test-call','seller','connected_human');`);
 assert.equal(sql(`select (call_activity_id='${id(172)}')::text||':'||coalesce(outcome,'pending') from acquisition_attempts where id='${id(171)}'`),'true:pending');
 const finalize={orgId:org,propertyId:property,callActivityId:id(172),outcome:'no_answer',idempotencyKey:id(173)};
 sql(`${auth} select fn_finalize_acquisition_attempt('${JSON.stringify(finalize)}')`);
 assert.equal(sql(`select outcome from acquisition_attempts where id='${id(171)}'`),'no_answer');
 sql(`update call_activities set notes='late artifact' where id='${id(172)}'`);
 assert.equal(sql(`select outcome from acquisition_attempts where id='${id(171)}'`),'no_answer');
 assert.match(sql(`${auth} select fn_finalize_acquisition_attempt('${JSON.stringify(finalize)}')`),/"duplicate": true/);
 assert.throws(()=>sql(`${auth} select fn_finalize_acquisition_attempt('${JSON.stringify({...finalize,idempotencyKey:id(174),outcome:'reached'})}')`),/STALE_STATE/);
 assert.throws(()=>sql(`${auth} select fn_get_acquisition_kpis('${org}','${other}',now()-interval '1 day',now())`),/FORBIDDEN/);
 assert.throws(()=>sql(`${auth} select fn_get_acquisition_kpis('${id(999)}','${rep}',now()-interval '1 day',now())`),/FORBIDDEN/);
 console.log('PASS: actual SQL inventory, overdue/snooze/reassignment, all attempts, call-only quality/coverage, recording grace, provider field protection, explicit outcomes, replay, tenant/rep guards.');
} finally {
 if(started)run('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);
 rmSync(cluster,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
}
