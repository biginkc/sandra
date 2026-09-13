import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'dp-rest-'));let started=false;
const bin='/opt/homebrew/opt/postgresql@17/bin';
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:'pipe'});
const sql=q=>run('psql',['-h',dir,'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',q]).trim();
try{
 run('initdb',['-D',join(dir,'data'),'-A','trust','-U','postgres']);run('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'log'),'-o',`-k ${dir} -c listen_addresses=''`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role;create schema extensions;create extension pgcrypto with schema extensions;
 create table call_activities(id uuid primary key,org_id uuid,provider text,provider_call_id text,operator_user_id uuid,property_id uuid,started_at timestamptz,ended_at timestamptz,provider_ended_at timestamptz,duration_seconds integer,recording_expected boolean);
 create table dialpad_voice_intents(id uuid primary key,org_id uuid,provider_call_id text,dialpad_user_id text,actor_user_id uuid,property_id uuid,caller_id_e164 text,destination_e164 text);
 create table organizations(id uuid primary key);
 create table dialpad_recording_artifacts(id uuid default extensions.gen_random_uuid(),created_at timestamptz default now(),next_attempt_at timestamptz default now(),lease_token uuid,lease_expires_at timestamptz,attempt_count integer default 0,org_id uuid,provider_call_id text,provider_recording_id text,recording_kind text,intent_id uuid,status text,unique(org_id,provider_call_id,provider_recording_id));`);
 const enrich=readFileSync(new URL('./20260913210933_dialpad_acquisition_evidence.sql',import.meta.url),'utf8');
 sql(enrich.slice(enrich.indexOf('create function public.dialpad_enrich_activity'),enrich.indexOf('-- Inputs select persisted facts')));
 sql(readFileSync(new URL('./20260913211805_dialpad_recording_claim_budget.sql',import.meta.url),'utf8'));
 sql(readFileSync(new URL('./20260913221606_dialpad_bound_rest_reconciliation.sql',import.meta.url),'utf8'));
 const org='00000000-0000-0000-0000-000000000bbb',id='11111111-1111-4111-8111-111111111111';
 sql(`insert into organizations values('${org}');insert into call_activities(id,org_id,provider,provider_call_id,operator_user_id,property_id,started_at) values('${id}','${org}','dialpad','123','${id}','${id}',to_timestamp(1000));
 insert into dialpad_voice_intents values('${id}','${org}','123','4904023124647936','${id}','${id}','+18165550101','+18165550102');`);
 const claim=()=>JSON.parse(sql(`select row_to_json(j) from fn_claim_dialpad_rest_reconciliation('${org}') j`));
 const apply=(j,p)=>sql(`select fn_apply_dialpad_rest_reconciliation('${j.id}','${j.lease_token}','${JSON.stringify(p)}')`);
 const due=()=>sql(`update dialpad_rest_reconciliation_jobs set status='pending',next_attempt_at=now();update dialpad_detail_api_budget set next_allowed_at=now()-interval '1 second'`);
 const p={call_id:'123',state:'hangup',event_timestamp:1100000,date_started:1000000,date_ended:1100000,duration:100000,direction:'outbound',target:{id:'4904023124647936',type:'User'},internal_number:'+18165550101',external_number:'+18165550102',recording_details:[{id:'one',recording_type:'call'}]};
 let j=claim();assert.equal(sql(`select count(*) from fn_claim_dialpad_rest_reconciliation('${org}')`),'0');
 assert.equal(apply({...j,lease_token:id},p),'f');assert.equal(apply(j,p),'t');assert.equal(apply(j,p),'f');
 assert.equal(sql('select status from dialpad_rest_reconciliation_jobs'),'paused');
 assert.equal(sql('select duration_seconds from call_activities'),'100');assert.equal(sql('select count(*) from call_activities'),'1');
 assert.equal(sql("select payload ? 'custom_data' from dialpad_rest_reconciliation_receipts"),'f');
 sql("update dialpad_recording_artifacts set status='available'");due();j=claim();apply(j,p);assert.equal(sql('select status from dialpad_recording_artifacts'),'available');
 for(const patch of [{call_id:'999'},{target:{id:'999',type:'user'}},{internal_number:'+18165550999'},{date_started:1000001}]){
 due();j=claim();apply(j,{...p,...patch});assert.equal(sql('select status from dialpad_rest_reconciliation_jobs'),'quarantined');}
 due();j=claim();sql(`update dialpad_rest_reconciliation_jobs set lease_expires_at=now()-interval '1 second'`);assert.equal(apply(j,p),'f');sql("update dialpad_detail_api_budget set next_allowed_at=now()-interval '1 second'");const next=claim();assert.notEqual(next.lease_token,j.lease_token);
 sql(`update dialpad_rest_reconciliation_jobs set attempt_count=8`);assert.equal(sql(`select fn_fail_dialpad_rest_reconciliation('${next.id}','${next.lease_token}',false,'provider_unavailable')`),'t');assert.equal(sql('select status from dialpad_rest_reconciliation_jobs'),'failed');
 assert.throws(()=>sql('select * from fn_claim_dialpad_rest_reconciliation(null)'));
 assert.throws(()=>sql(`select * from fn_claim_dialpad_rest_reconciliation('${id}')`));
 due();j=claim();apply(j,{...p,state:'ringing',date_ended:null,duration:null,event_timestamp:1000500});
 assert.equal(sql('select extract(epoch from provider_ended_at)::integer from call_activities'),'1100');
 assert.equal(sql('select count(*) from dialpad_recording_artifacts'),'1');
 // Both worker families contend on exactly the same durable budget.
 due();j=claim();
 assert.equal(sql(`select count(*) from fn_claim_dialpad_recording('${org}')`),'0');
 sql(`update dialpad_detail_api_budget set next_allowed_at=now()-interval '1 second';update dialpad_recording_artifacts set status='pending'`);
 assert.equal(sql(`select count(*) from fn_claim_dialpad_recording('${org}')`),'1');
 sql(`update dialpad_rest_reconciliation_jobs set status='pending',next_attempt_at=now()`);
 assert.equal(sql(`select count(*) from fn_claim_dialpad_rest_reconciliation('${org}')`),'0');
 sql(`select fn_defer_dialpad_detail_budget('${org}',60)`);
 assert.equal(sql(`select next_allowed_at>now()+interval '55 seconds' from dialpad_detail_api_budget`),'t');
 assert.equal(sql(`select count(*) from fn_claim_dialpad_rest_reconciliation('${org}')`),'0');
 sql(`update dialpad_rest_reconciliation_jobs set status='paused';update dialpad_detail_api_budget set next_allowed_at='-infinity'`);
 assert.equal(sql(`select count(*) from fn_claim_dialpad_rest_reconciliation('${org}')`),'0');
 assert.equal(sql(`select next_allowed_at='-infinity'::timestamptz from dialpad_detail_api_budget`),'t');
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.fn_apply_dialpad_rest_reconciliation(uuid,uuid,jsonb)','execute')`),'f');
 assert.equal(sql("select has_table_privilege('service_role','public.dialpad_rest_reconciliation_receipts','update')"),'f');
 console.log('PASS bound REST snapshots: identity, raw provenance, lease/replay, retained artifacts, no activity creation, retry exhaustion, private access');
}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
