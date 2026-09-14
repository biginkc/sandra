import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'dp-rest-'));let started=false;
const bin=process.env.PG_BIN??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
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
 sql(`create table dialpad_intent_configuration(org_id uuid,intent_id uuid,connection_id uuid,connection_version bigint,binding_id uuid,binding_revision bigint,grant_id uuid,grant_revision bigint);
 create table dialpad_connection_revisions(org_id uuid,connection_id uuid,config_version bigint);
 create table dialpad_member_bindings(org_id uuid,id uuid,revision bigint,member_user_id uuid,provider_user_id text,connection_id uuid,connection_version bigint,revoked_at timestamptz);
 create table dialpad_number_grants(org_id uuid,id uuid,revision bigint,binding_id uuid,number_e164 text,revoked_at timestamptz);`);
 sql(readFileSync(new URL('./20260914034127_dialpad_configured_rest_reconciliation.sql',import.meta.url),'utf8'));
 const org='00000000-0000-0000-0000-000000000aaa',other='00000000-0000-0000-0000-000000000ccc';
 sql(`insert into organizations values('${org}'),('${other}');`);
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
 for(let n=0;n<3;n++){
 const id=ids[n],scope=n===2?other:org,call=String(100+n),user=String(200+n);
 sql(`insert into call_activities(id,org_id,provider,provider_call_id,operator_user_id,property_id,started_at) values('${id}','${scope}','dialpad','${call}','${id}','${id}',to_timestamp(1000));
 insert into dialpad_voice_intents values('${id}','${scope}','${call}','${user}','${id}','${id}','+18165550101','+18165550102');
 insert into dialpad_connection_revisions values('${scope}','${id}',1);
 insert into dialpad_member_bindings values('${scope}','${id}',1,'${id}','${user}','${id}',1,now());
 insert into dialpad_number_grants values('${scope}','${id}',1,'${id}','+18165550101',now());
 insert into dialpad_intent_configuration values('${scope}','${id}','${id}',1,'${id}',1,'${id}',1);`);
 }
 const claim=scope=>JSON.parse(sql(`select row_to_json(j) from fn_claim_dialpad_rest_reconciliation('${scope}') j`));
 const payload=j=>({call_id:j.provider_call_id,state:'hangup',event_timestamp:1100000,date_started:1000000,date_ended:1100000,duration:100000,direction:'outbound',target:{id:String(Number(j.provider_call_id)+100),type:'user'},internal_number:'+18165550101',external_number:'+18165550102'});
 const apply=(j,p)=>sql(`select fn_apply_dialpad_rest_reconciliation('${j.id}','${j.lease_token}','${JSON.stringify(p)}')`);
 for(let n=0;n<2;n++){
 const j=claim(org);assert.equal(j.org_id,org);assert.equal(apply(j,payload(j)),'t');assert.equal(apply(j,payload(j)),'f');
 sql(`update dialpad_detail_api_budget set next_allowed_at='-infinity'`);
 }
 assert.equal(sql(`select count(*) from call_activities where org_id='${org}' and duration_seconds=100`),'2');
 assert.equal(sql(`select count(*) from dialpad_rest_reconciliation_jobs where org_id='${other}'`),'0');
 let j=claim(other);assert.equal(apply({...j,lease_token:ids[0]},payload(j)),'f');
 assert.equal(apply(j,{...payload(j),target:{id:'200',type:'user'}}),'t');assert.equal(sql(`select status from dialpad_rest_reconciliation_jobs where id='${j.id}'`),'quarantined');
 assert.equal(sql('select count(*) from call_activities'),'3');
 assert.equal(sql('select count(*) from dialpad_rest_reconciliation_receipts'),'3');
 assert.equal(sql("select count(*) from dialpad_rest_reconciliation_receipts where source='authenticated_rest_get_call'"),'3');
 // Missing history cannot authorize any additional call; wrong frozen tenant,
 // member and binding revision fail even if runtime jobs already exist.
 sql(`delete from dialpad_connection_revisions where org_id='${org}' and connection_id='${ids[0]}';`);
 assert.equal(sql(`select dialpad_reconciliation_has_frozen_configuration('${org}','${ids[0]}')`),'f');
 assert.equal(sql(`select dialpad_reconciliation_has_frozen_configuration('${other}','${ids[1]}')`),'f');
 sql(`update dialpad_member_bindings set member_user_id='${ids[0]}' where id='${ids[1]}';`);
 assert.equal(sql(`select dialpad_reconciliation_has_frozen_configuration('${org}','${ids[1]}')`),'f');
 sql(`update dialpad_member_bindings set member_user_id=id,revision=2 where id='${ids[1]}';`);
 assert.equal(sql(`select dialpad_reconciliation_has_frozen_configuration('${org}','${ids[1]}')`),'f');
 sql(`update dialpad_rest_reconciliation_jobs set status='pending',next_attempt_at=now() where intent_id='${ids[0]}';update dialpad_detail_api_budget set next_allowed_at='-infinity';`);
 j=claim(org);assert.equal(apply(j,payload(j)),'t');assert.equal(sql(`select status from dialpad_rest_reconciliation_jobs where id='${j.id}'`),'quarantined');
 // A genuine second connection holds the activity lock beyond the worker lease.
 sql(`update dialpad_rest_reconciliation_jobs set status='pending',next_attempt_at=now() where intent_id='${ids[0]}';update dialpad_detail_api_budget set next_allowed_at='-infinity';`);
 j=claim(org);
 const receiptCount=sql('select count(*) from dialpad_rest_reconciliation_receipts');
 const holder=spawn(join(bin,'psql'),['-h',dir,'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',`set application_name='dp_recon_lease_holder';begin;select id from call_activities where id='${ids[0]}' for update;select pg_sleep(1.5);commit;`],{stdio:'ignore'});
 const holderDone=new Promise((resolve,reject)=>{holder.once('error',reject);holder.once('exit',code=>code===0?resolve():reject(Error('lock holder failed')));});
 let holding=false;
 for(let attempt=0;attempt<50;attempt++){
  if(sql("select count(*) from pg_stat_activity where application_name='dp_recon_lease_holder' and wait_event='PgSleep'")==='1'){holding=true;break;}
 }
 assert.equal(holding,true,'activity lock holder must be observed before applying');
 sql(`update dialpad_rest_reconciliation_jobs set lease_expires_at=clock_timestamp()+interval '250 milliseconds' where id='${j.id}'`);
 assert.equal(apply(j,payload(j)),'f','lease expires while waiting for activity lock');
 await holderDone;
 assert.equal(sql('select count(*) from dialpad_rest_reconciliation_receipts'),receiptCount);
 assert.equal(sql(`select status from dialpad_rest_reconciliation_jobs where id='${j.id}'`),'processing');
 assert.throws(()=>sql('select * from fn_claim_dialpad_rest_reconciliation(null)'));
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.fn_apply_dialpad_rest_reconciliation(uuid,uuid,jsonb)','execute')`),'f');
 console.log('PASS configured reconciliation: two reps, tenant isolation, revoked historical revisions, exact binding, missing history, immutable receipt provenance, no duplicate activity, lease replay');
}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
