import {execFileSync} from 'node:child_process';
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
 sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;grant usage on schema extensions to service_role;create table organizations(id uuid primary key);create table memberships(user_id uuid,org_id uuid,unique(user_id,org_id));`);
 for(const f of ['20260914021149_dialpad_org_connections.sql','20260914021514_dialpad_member_number_grants.sql','20260914024248_dialpad_inventory_verification_receipts.sql'])sql(readFileSync(new URL('./'+f,import.meta.url),'utf8'));
 const uuid=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,org=uuid(1),other=uuid(2),member=uuid(3),second=uuid(4);
 sql(`insert into organizations values('${org}'),('${other}');insert into memberships values('${member}','${org}'),('${second}','${org}'),('${second}','${other}');insert into dialpad_org_connections(id,org_id,provider_company_id,credential_reference) values('${org}','${org}','101','env:KEY'),('${other}','${other}','102','env:KEY');`);
 const caller=(type='user',id='201',number='+12025550101')=>({identity_type:type,provider_identity_id:id,number_e164:number});
 const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
 const receipt=(n,patch={})=>{
  const {_timestamp, ...values}=patch;
  const r={id:uuid(n),org_id:org,connection_id:org,connection_version:1,provider_company_id:'101',member_user_id:member,provider_user_id:'201',member_email_matched:true,callers:JSON.stringify([caller(),caller('office','301'),caller('office','302')]),...values};
  return sql(`set role service_role;insert into dialpad_inventory_verifications(${Object.keys(r)},verified_at) values(${Object.values(r).map(quote)},${_timestamp??'statement_timestamp()'}) returning id`).split('\n').find(x=>x===uuid(n));
 };
 const bind=(n,receiptId=uuid(10),patch={})=>{
  const r={id:uuid(n),org_id:org,connection_id:org,connection_version:1,member_user_id:member,revision:1,provider_user_id:'201',...patch};
  return sql(`set role service_role;insert into dialpad_member_bindings(${Object.keys(r)},verification_reference,verification_sha256,verified_at) select ${Object.values(r).map(quote)},id,verification_sha256,verified_at from dialpad_inventory_verifications where id='${receiptId}'`);
 };
 const grant=(n,binding=uuid(20),receiptId=uuid(10),patch={})=>{
  const r={id:uuid(n),org_id:org,binding_id:binding,revision:1,identity_type:'office',provider_identity_id:'301',number_e164:'+12025550101',...patch};
  return sql(`set role service_role;insert into dialpad_number_grants(${Object.keys(r)},verification_reference,verification_sha256,verified_at) select ${Object.values(r).map(quote)},id,verification_sha256,verified_at from dialpad_inventory_verifications where id='${receiptId}'`);
 };
 receipt(10);bind(20);grant(30);grant(31,uuid(20),uuid(10),{provider_identity_id:'302'});
 assert.equal(sql('select count(*) from dialpad_number_grants'),'2');
 for(const patch of [{provider_company_id:'999'},{connection_version:2},{connection_id:other},{member_user_id:uuid(999)},{member_email_matched:false},{callers:'{}'},{callers:JSON.stringify([caller('user','999')])},{callers:JSON.stringify([{...caller(),secret:'forbidden'}])},{callers:JSON.stringify([caller('unknown')])},{callers:JSON.stringify([caller('office',301)])}])assert.throws(()=>receipt(11,patch));
 for(const patch of [{member_user_id:second},{provider_user_id:'999'},{connection_id:other},{connection_version:2},{org_id:other}])assert.throws(()=>bind(21,uuid(10),patch));
 for(const patch of [{number_e164:'+12025550109'},{provider_identity_id:'999'},{identity_type:'department'},{org_id:other}])assert.throws(()=>grant(32,uuid(20),uuid(10),patch));
 receipt(12,{member_user_id:second,provider_user_id:'202',callers:JSON.stringify([caller('user','202'),caller('office','301')])});
 assert.throws(()=>grant(32,uuid(20),uuid(12)));
 // FK also rejects fabricated evidence even if it copies a known receipt ID.
 assert.throws(()=>sql(`set role service_role;insert into dialpad_member_bindings(id,org_id,connection_id,connection_version,member_user_id,revision,provider_user_id,verification_reference,verification_sha256,verified_at) values('${uuid(22)}','${org}','${org}',1,'${second}',1,'202','${uuid(12)}','${'a'.repeat(64)}',now())`));
 // Staleness cannot be bypassed with supplied creation timestamps.
 for(const timestamp of ["statement_timestamp()-interval '6 minutes'","statement_timestamp()+interval '1 minute'"])
 assert.throws(()=>sql(`set role service_role;insert into dialpad_inventory_verifications(org_id,connection_id,connection_version,provider_company_id,member_user_id,provider_user_id,member_email_matched,callers,verified_at) values('${org}','${org}',1,'101','${member}','201',true,'[]',${timestamp})`));
 for(const statement of ["update dialpad_inventory_verifications set callers='[]'","delete from dialpad_inventory_verifications"]){assert.throws(()=>sql(statement));assert.throws(()=>sql('set role service_role;'+statement));}
 receipt(13,{callers:'[]'});assert.throws(()=>grant(32,uuid(20),uuid(13)));
 receipt(14,{callers:JSON.stringify([caller(),caller()])});assert.equal(sql(`select jsonb_array_length(callers) from dialpad_inventory_verifications where id='${uuid(14)}'`),'1');
 // Fresh at retention, expired by revision creation: no old receipt reuse.
 receipt(15,{_timestamp:"statement_timestamp()-interval '299.5 seconds'"});sql('select pg_sleep(0.6)');
 assert.throws(()=>grant(32,uuid(20),uuid(15),{identity_type:'user',provider_identity_id:'201'}));
 // Connection rotation prevents fresh receipt reuse but never rewrites evidence.
 const hash=sql(`select verification_sha256 from dialpad_inventory_verifications where id='${uuid(10)}'`);
 sql(`set role service_role;update dialpad_org_connections set provider_company_id='999',config_version=2 where id='${org}'`);
 assert.throws(()=>grant(32,uuid(20),uuid(10),{identity_type:'user',provider_identity_id:'201'}));
 sql(`set role service_role;update dialpad_member_bindings set revoked_at=now() where id='${uuid(20)}'`);
 assert.equal(sql(`select verification_sha256 from dialpad_inventory_verifications where id='${uuid(10)}'`),hash);
 assert.equal(sql(`select provider_company_id from dialpad_inventory_verifications where id='${uuid(10)}'`),'101');
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_table_privilege('${role}','dialpad_inventory_verifications','select,insert,update,delete')`),'f');
 assert.equal(sql(`select relrowsecurity from pg_class where oid='dialpad_inventory_verifications'::regclass`),'t');
 assert.equal(sql(`select convalidated from pg_constraint where conname='dialpad_binding_verification_fk'`),'t');
 assert.equal(sql(`select convalidated from pg_constraint where conname='dialpad_grant_verification_fk'`),'t');
 // The migration refuses to fabricate receipts for existing revisions.
 assert.throws(()=>sql(readFileSync(new URL('./20260914024248_dialpad_inventory_verification_receipts.sql',import.meta.url),'utf8')),error=>String(error.stderr).includes('DIALPAD_EXISTING_REVISIONS_REQUIRE_VERIFICATION_MIGRATION'));
 console.log('PASS retained scoped verification, exact number/group provenance, malformed/stale rejection, immutable history, validated FKs, service-only access');
}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
