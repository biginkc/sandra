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
 const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 sql(`insert into organizations values('${org}'),('${other}');insert into dialpad_org_connections(id,org_id,provider_company_id,credential_reference) values('${org}','${org}','123','env:KEY');update dialpad_org_connections set config_version=2,verified_at=now(),enabled=true;`);
 sql(readFileSync(new URL('./20260914030350_dialpad_connection_history.sql',import.meta.url),'utf8'));
 assert.equal(sql('select count(*) from dialpad_connection_revisions'),'1');assert.equal(sql('select config_version from dialpad_connection_revisions'),'2');
 sql(`set role service_role;update dialpad_org_connections set config_version=3,enabled=false,verified_at=null,credential_reference='env:ROTATED_KEY'`);
 assert.equal(sql(`select credential_reference from dialpad_connection_revisions where config_version=2`),'env:KEY');
 assert.equal(sql(`select enabled from dialpad_connection_revisions where config_version=2`),'t');
 assert.throws(()=>sql(`update dialpad_org_connections set config_version=4,provider_company_id='456'`));
 assert.throws(()=>sql(`insert into dialpad_org_connections(org_id,provider_company_id,credential_reference) values('${other}','456','env:KEY')`));
 sql(`update dialpad_org_connections set config_version=4,provider_company_id='456',credential_reference='env:NEW_COMPANY'`);
 assert.equal(sql(`select provider_company_id from dialpad_connection_revisions where config_version=2`),'123');
 assert.equal(sql('select count(*) from dialpad_connection_revisions'),'3');
 assert.throws(()=>sql(`update dialpad_connection_revisions set enabled=false`));
 assert.throws(()=>sql(`delete from dialpad_connection_revisions`));
 assert.throws(()=>sql(`update dialpad_credential_reference_companies set provider_company_id='999'`));
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_table_privilege('${role}','dialpad_connection_revisions','select,insert,update,delete')`),'f');
 assert.equal(sql(`select has_table_privilege('service_role','dialpad_connection_revisions','insert')`),'f');
 console.log('PASS exact known revision snapshot, historical route preservation, immutable history, cross-company credential reuse rejection, private access');

}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
