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
 sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;create table organizations(id uuid primary key);create table memberships(user_id uuid,org_id uuid,unique(user_id,org_id));`);
 for(const f of ['20260914021149_dialpad_org_connections.sql','20260914021514_dialpad_member_number_grants.sql'])sql(readFileSync(new URL('./'+f,import.meta.url),'utf8'));
 const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64);
 sql(`insert into organizations values('${org}'),('${other}');insert into memberships values('${org}','${org}'),('${other}','${other}');
 insert into dialpad_org_connections(id,org_id,provider_company_id,credential_reference) values('${org}','${org}','123','env:KEY'),('${other}','${other}','456','env:KEY');`);
 const bind=(id,scope=org,connection=org,member=org,revision=1)=>sql(`set role service_role;insert into dialpad_member_bindings(id,org_id,connection_id,connection_version,member_user_id,revision,provider_user_id,verification_reference,verification_sha256,verified_at) values('${id}','${scope}','${connection}',1,'${member}',${revision},'789','${id}','${hash}',now())`);
 bind(org);assert.throws(()=>bind(other));assert.throws(()=>bind(other,other,org,other));assert.throws(()=>bind(other,org,org,other));
 const grant=(id,binding=org,scope=org,type='user',identity='789',revision=1)=>sql(`set role service_role;insert into dialpad_number_grants(id,org_id,binding_id,revision,identity_type,provider_identity_id,number_e164,verification_reference,verification_sha256,verified_at) values('${id}','${scope}','${binding}',${revision},'${type}','${identity}','+18165550101','${id}','${hash}',now())`);
 grant(org);assert.throws(()=>grant(other));assert.throws(()=>grant(other,org,other));
 assert.throws(()=>sql(`update dialpad_member_bindings set provider_user_id='999'`));
 assert.throws(()=>sql(`update dialpad_number_grants set number_e164='+18165550999'`));
 sql(`set role service_role;update dialpad_member_bindings set revoked_at=now() where id='${org}'`);
 assert.throws(()=>sql(`update dialpad_member_bindings set revoked_at=null`));
 assert.throws(()=>grant(other));assert.throws(()=>bind(other));bind(other,org,org,org,2);grant(other,other);
 assert.equal(sql('select count(*) from dialpad_member_bindings'),'2');
 assert.equal(sql('select count(*) from dialpad_number_grants'),'2');
 assert.equal(sql(`select provider_user_id from dialpad_member_bindings where id='${org}'`),'789');
 assert.throws(()=>grant('33333333-3333-4333-8333-333333333333',other,org,'user','999'));
 for(const [index,type] of ['office','department','callcenter'].entries()) {
 const id=`44444444-4444-4444-8444-${String(index).padStart(12,'0')}`;
 grant(id,other,org,type,'555');
 sql(`set role service_role;update dialpad_number_grants set revoked_at=now() where id='${id}'`);
 assert.throws(()=>grant(`55555555-5555-4555-8555-${String(index).padStart(12,'0')}`,other,org,type,'555'));
 grant(`66666666-6666-4666-8666-${String(index).padStart(12,'0')}`,other,org,type,'555',2);
 }
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_table_privilege('${role}','dialpad_member_bindings','select,insert,update,delete')`),'f');
 assert.equal(sql(`select has_column_privilege('service_role','dialpad_member_bindings','provider_user_id','update')`),'f');
 console.log('PASS binding/grant tenant FKs, uniqueness, immutable revision, revocation/rebinding history, service-only grants');

}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
