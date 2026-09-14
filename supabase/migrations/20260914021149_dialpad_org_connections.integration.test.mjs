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
 sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema extensions;create extension pgcrypto with schema extensions;create table organizations(id uuid primary key);`);
 sql(readFileSync(new URL('./20260914021149_dialpad_org_connections.sql',import.meta.url),'utf8'));
 const org='11111111-1111-4111-8111-111111111111';
 sql(`insert into organizations values('${org}');set role service_role;
 insert into dialpad_org_connections(org_id,provider_company_id,credential_reference) values('${org}','123','env:DIALPAD_VOICE_API_KEY');`);
 const state=()=>JSON.parse(sql('select row_to_json(c) from dialpad_org_connections c'));
 assert.equal(state().enabled,false);assert.equal(state().config_version,1);
 assert.throws(()=>sql(`update dialpad_org_connections set enabled=true,config_version=2`));
 sql(`set role service_role;update dialpad_org_connections set config_version=2,cti_client_id='issued-client',allowed_origins=array['https://sandra.bmhgroupkc.com']`);
 assert.equal(state().config_version,2);
 sql(`update dialpad_org_connections set verified_at=now(),enabled=true,config_version=3`);

 for(const origin of ['http://example.com','https://localhost','https://127.0.0.1','https://example.com/path','https://*.example.com','https://example.com:65536']){
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,enabled=false,verified_at=null,allowed_origins=array['${origin}']`));}
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,enabled=false,verified_at=null,allowed_origins=array['https://example.com','https://example.com']`));
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,enabled=false,verified_at=null,allowed_origins=array[null]::text[]`));
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=5`));
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,id='22222222-2222-4222-8222-222222222222'`));
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,credential_reference='secret-value'`));
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,provider_company_id='1e3'`));
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,verified_at='infinity'`));
 assert.throws(()=>sql(`insert into dialpad_org_connections(org_id,provider_company_id,credential_reference) values('22222222-2222-4222-8222-222222222222','123','env:KEY')`));
 for(const change of ["provider_company_id='456'","credential_reference='env:OTHER_KEY'"]){
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,${change}`));}
 sql(`set role service_role;update dialpad_org_connections set config_version=4,provider_company_id='456',credential_reference='env:OTHER_KEY',enabled=false,verified_at=null`);
 assert.equal(state().enabled,false);assert.equal(state().verified_at,null);
 sql(`set role service_role;update dialpad_org_connections set config_version=5,enabled=true,verified_at=now()`);
 assert.equal(state().enabled,true);assert.equal(state().provider_company_id,'456');
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=6,enabled=false,verified_at=null,cti_client_id=repeat('a',129)`));
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_table_privilege('${role}','dialpad_org_connections','select,insert,update,delete')`),'f');
 assert.equal(sql(`select has_table_privilege('service_role','dialpad_org_connections','delete')`),'f');
 assert.equal(sql(`select relrowsecurity from pg_class where oid='dialpad_org_connections'::regclass`),'t');
 console.log('PASS private org connection foundation, service metadata access, identity/version guards, origin/credential validation, tenant FK');

}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
