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
 for(const patch of [{owner:member},{member:uuid(99)},{version:2},{company:'999'},{revision:1},{selected:'[]'},{selected:JSON.stringify([{number_e164:'+12025550101'}])},{selected:JSON.stringify([caller('office','999')])},{verified:'2000-01-01T00:00:00Z'}]){
  assert.throws(()=>call(10,patch));assert.equal(counts(),'0|0|0|0');
 }
 for(const role of ['anon','authenticated'])assert.throws(()=>call(10,{},role));
 const first=call(10);assert.equal(first.bindingRevision,1);assert.equal(first.grants.length,1);
 assert.deepEqual(call(10),first);assert.equal(counts(),'1|1|1|1');
 const originalEvidence=sql(`select verified_at,callers from dialpad_inventory_verifications where id='${first.verificationId}'`);
 assert.deepEqual(call(10,{verified:sql('select statement_timestamp()'),callers:JSON.stringify([caller('office','301'),caller('office','302')])}),first);
 assert.equal(counts(),'1|1|1|1');
 assert.equal(sql(`select verified_at,callers from dialpad_inventory_verifications where id='${first.verificationId}'`),originalEvidence);
 assert.throws(()=>call(10,{selected:JSON.stringify([caller()])}));
 assert.throws(()=>call(11));assert.equal(counts(),'1|1|1|1');
 assert.deepEqual(JSON.parse(replay()),first);
 for(const patch of [{member:second},{user:'999'},{selected:JSON.stringify([caller()])},{version:99},{revision:99},{owner:member}])assert.throws(()=>replay(patch));
 assert.equal(replay({request:uuid(999)}),'');
 for(const role of ['anon','authenticated'])assert.throws(()=>replay({},role));
 const next=call(11,{revision:1,selected:JSON.stringify([caller(),caller('office','301')])});
 assert.equal(next.bindingRevision,2);assert.equal(next.grants.length,2);
 assert.deepEqual(call(11,{revision:1,selected:JSON.stringify([caller('office','301'),caller(),caller()]),verified:sql('select statement_timestamp()'),callers:JSON.stringify([caller()])}),next);
 assert.equal(counts(),'2|2|3|2');
 assert.equal(sql('select count(*) from dialpad_member_bindings where revoked_at is not null'),'1');
 assert.equal(sql('select count(*) from dialpad_number_grants where revoked_at is not null'),'1');
 assert.deepEqual(call(10),first); // Replay remains original history, not current state.
 const before=counts();assert.throws(()=>call(12,{member:second}));assert.equal(counts(),before); // Provider user cannot bind to two members.
 const other=call(12,{member:second,user:'202',callers:JSON.stringify([caller('user','202'),caller('office','301')])});assert.equal(other.bindingRevision,1);
 for(const [set,reset] of [
  ["acquisitions_enabled=false","acquisitions_enabled=true"],
  ["access_status='inactive'","access_status='active'"],
  ["access_expires_at=now()-interval '1 second'","access_expires_at=null"],
  ["deletion_prepared_at=now()","deletion_prepared_at=null"],
 ]){sql(`update memberships set ${set} where user_id='${member}'`);assert.deepEqual(JSON.parse(replay()),first);assert.throws(()=>call(13,{revision:2}));sql(`update memberships set ${reset} where user_id='${member}'`);}
 sql('update acquisition_org_settings set my_leads_enabled=false');assert.deepEqual(JSON.parse(replay()),first);assert.throws(()=>call(13,{revision:2}));sql('update acquisition_org_settings set my_leads_enabled=true');
 sql(`update memberships set role='member' where user_id='${owner}'`);assert.throws(()=>call(10));assert.throws(()=>replay());sql(`update memberships set role='owner' where user_id='${owner}'`);
 sql(`update dialpad_org_connections set enabled=false,config_version=2`);assert.throws(()=>call(13,{revision:2}));assert.deepEqual(JSON.parse(replay()),first);
 assert.equal(sql(`select has_table_privilege('service_role','dialpad_configuration_commands','insert,update,delete')`),'f');
 assert.equal(sql(`select count(*) from dialpad_member_bindings where revoked_at is null`),'2');
 // Two concurrent owner saves with the same expected revision: exactly one wins.
 sql('update dialpad_org_connections set enabled=true,config_version=3');
 const races=await Promise.allSettled([14,15].map(request=>promisify(execFile)(join(bin,'psql'),['-h',dir,'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',commandSql(request,{revision:2,version:3})])));
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(races.filter(r=>r.status==='rejected'&&String(r.reason.stderr).includes('DIALPAD_CONFIGURATION_BINDING_STALE')).length,1);
 assert.equal(sql(`select revision from dialpad_member_bindings where member_user_id='${member}' and revoked_at is null`),'3');
 console.log('PASS atomic owner/member configuration, rollback, exact selection, revision CAS, replay, authorization revocation, shared numbers across reps, retained history');
}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
