import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'dp-connection-'));let started=false;
const bin=process.env.PG_BIN??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:'pipe'});
const sql=q=>run('psql',['-h',dir,'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',q]).trim();
try {
 run('initdb',['-D',join(dir,'data'),'-A','trust','-U','postgres']);run('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'log'),'-o',`-k ${dir} -c listen_addresses=''`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;create table organizations(id uuid primary key);create table memberships(user_id uuid,org_id uuid,role text,access_status text default 'active',deletion_prepared_at timestamptz,access_expires_at timestamptz,acquisitions_enabled boolean default true,unique(user_id,org_id));create table acquisition_org_settings(org_id uuid primary key,my_leads_enabled boolean);`);
 for(const f of ['20260914021149_dialpad_org_connections.sql','20260914021514_dialpad_member_number_grants.sql','20260914024248_dialpad_inventory_verification_receipts.sql','20260914025258_dialpad_atomic_member_configuration.sql'])sql(readFileSync(new URL('./'+f,import.meta.url),'utf8'));
 const uuid=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,org=uuid(1),owner=uuid(2),member=uuid(3),second=uuid(4);
 sql(`insert into organizations values('${org}');insert into memberships(user_id,org_id,role) values('${owner}','${org}','owner'),('${member}','${org}','member'),('${second}','${org}','member');insert into acquisition_org_settings values('${org}',true);insert into dialpad_org_connections(id,org_id,provider_company_id,credential_reference,enabled,verified_at) values('${org}','${org}','101','env:KEY',true,now());`);
 const caller=(type='user',id='201')=>({identity_type:type,provider_identity_id:id,number_e164:'+12025550101'});
 const timestamp=sql('select statement_timestamp()');
 const q=v=>"'"+String(v).replaceAll("'","''")+"'";
 const commandSql=(request,patch={},role='service_role')=>{
  const p={org,owner,member,connection:org,version:1,company:'101',user:'201',verified:timestamp,callers:JSON.stringify([caller(),caller('office','301')]),selected:JSON.stringify([caller('office','301')]),revision:0,request:uuid(request),...patch};
  return `set role ${role};select fn_configure_dialpad_member(${Object.values(p).map(q)})`;
 };
 const call=(...args)=>JSON.parse(sql(commandSql(...args)).split('\n').find(x=>x.startsWith('{')));
 const replay=(patch={},role='service_role')=>{
  const p={org,owner,member,user:'201',version:1,revision:0,selected:JSON.stringify([caller('office','301')]),request:uuid(10),...patch};
  return sql(`set role ${role};select fn_replay_dialpad_member_configuration(${Object.values(p).map(q)})`).split('\n').filter(x=>x!=='SET').join('');
 };
 const counts=()=>sql('select (select count(*) from dialpad_inventory_verifications),(select count(*) from dialpad_member_bindings),(select count(*) from dialpad_number_grants),(select count(*) from dialpad_configuration_commands)');
 const configured=call(10);
 sql(`create table contacts(id uuid,org_id uuid,phone_1 text,phone_2 text,phone_3 text,do_not_contact boolean);
 create table properties(id uuid,org_id uuid,assigned_user_id uuid,homeowner_contact_id uuid,deleted_at timestamptz,is_dnc_locked boolean,status text);
 create table acquisition_assignment_episodes(id uuid,org_id uuid,property_id uuid,assignee_user_id uuid,ended_at timestamptz);
 create table acquisition_commands(org_id uuid,operation text,context_key_hash text,result jsonb);
 create table dialpad_voice_intents(id uuid,org_id uuid,actor_user_id uuid,property_id uuid,assignment_episode_id uuid,binding_token_hash text,dialpad_user_id text,destination_e164 text,caller_id_e164 text,client_idempotency_key uuid,status text default 'prepared',unique(id,org_id),unique(org_id,actor_user_id,client_idempotency_key));
 insert into contacts values('${uuid(20)}','${org}','+12025550199',null,null,false);
 insert into properties values('${uuid(21)}','${org}','${member}','${uuid(20)}',null,false,'new_lead');
 insert into acquisition_assignment_episodes values('${uuid(22)}','${org}','${uuid(21)}','${member}',null);`);
 for(const f of ['20260914030350_dialpad_connection_history.sql','20260914030923_dialpad_intent_configuration.sql'])sql(readFileSync(new URL('./'+f,import.meta.url),'utf8'));
 const intent=uuid(30);
 sql(`insert into acquisition_commands values('${org}','bind_call_context',encode(extensions.digest('${intent}','sha256'),'hex'),'${JSON.stringify({orgId:org,propertyId:uuid(21),actorUserId:member,assignmentEpisodeId:uuid(22)})}')`);
 const prepare=(patch={})=>{const p={org,actor:member,property:uuid(21),intent,key:intent,grant:configured.grants[0].id,verification:configured.verificationId,device:'native-fixture',deviceTime:timestamp,destination:'+12025550199',...patch};return JSON.parse(sql(`set role service_role;select fn_prepare_dialpad_configured_intent(${Object.values(p).map(q)})`).split('\n').find(x=>x.startsWith('{')));};
 assert.throws(()=>prepare({actor:second}));assert.throws(()=>prepare({grant:uuid(99)}));assert.throws(()=>prepare({destination:'+12025550999'}));
 assert.equal(prepare().duplicate,false);assert.equal(prepare().duplicate,true);
 assert.equal(sql('select count(*) from dialpad_voice_intents'),'1');
 assert.equal(sql('select count(*) from dialpad_intent_configuration'),'1');
 assert.equal(sql('select dialpad_user_id from dialpad_voice_intents'),'201');
 assert.equal(sql('select caller_id_e164 from dialpad_voice_intents'),'+12025550101');
 assert.throws(()=>sql(`update dialpad_intent_configuration set device_id='changed'`));
 sql(`update dialpad_number_grants set revoked_at=now() where id='${configured.grants[0].id}'`);assert.throws(()=>prepare());
 assert.equal(sql('select count(*) from dialpad_intent_configuration'),'1');
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','fn_prepare_dialpad_configured_intent(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text)','execute')`),'f');
 console.log('PASS configured preparation scope, exact grant/device snapshot, duplicate identity, stale grant denial, immutable history; prerequisite fixture tables, not full schema');

}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
