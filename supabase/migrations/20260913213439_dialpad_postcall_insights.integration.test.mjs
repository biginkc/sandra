// Disposable PostgreSQL component proof, not hosted deployment or full replay.
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
test('postcall insights isolation and monotonic data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'insights-pg-')),socket=mkdtempSync('/tmp/insights-sock-');let started=false;
 const run=(name,args)=>execFileSync(name,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const sql=q=>run('psql',['-h',socket,'-U','postgres','-v','ON_ERROR_STOP=1','-At','-c',q]).trim();
 try {
  run('initdb',['-D',dir,'-A','trust','-U','postgres','--no-locale']);run('pg_ctl',['-D',dir,'-l',join(dir,'postgres.log'),'-o',`-k ${socket} -c listen_addresses=''`,'-w','start']);started=true;
  sql(`create role anon;create role authenticated;create role service_role bypassrls;create table organizations(id uuid primary key);create table call_activities(id uuid primary key,org_id uuid,provider text,provider_call_id text);grant select on call_activities to service_role;`);
  sql(readFileSync(new URL('./20260913213439_dialpad_postcall_insights.sql',import.meta.url),'utf8'));
  const org='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
  sql(`insert into organizations values('${org}'),('${other}');insert into call_activities values('${org}','${org}','dialpad','123');`);
  const store=(o,kind,ts,text)=>sql(`set role service_role;select fn_store_dialpad_insight('${o}','123','${kind}',${ts},'${text}','[]');`).split('\n').at(-1);
  assert.equal(store(other,'transcript',1,'foreign'),'f');assert.equal(sql('select count(*) from dialpad_call_insights'),'0');
  assert.equal(store(org,'transcript',200,'complete'),'t');assert.equal(store(org,'transcript',100,'partial'),'t');
  assert.equal(sql('select transcript_text from dialpad_call_insights'),'complete');
  store(org,'transcript',300,'');assert.equal(sql('select transcript_status from dialpad_call_insights'),'available');
  store(org,'summary',400,'summary');store(org,'summary',100,'older');store(org,'summary',500,'');
  assert.equal(sql('select summary_text from dialpad_call_insights'),'summary');
  assert.throws(()=>sql('set role authenticated;select * from dialpad_call_insights;'));
  assert.throws(()=>sql(`set role authenticated;select fn_store_dialpad_insight('${org}','123','summary',1,'bad','[]');`));
  sql(`insert into call_activities values('${other}','${org}','dialpad','456');set role service_role;select fn_store_dialpad_insight('${org}','456','transcript',1,'','[]');`);
  assert.equal(sql("select transcript_status from dialpad_call_insights where provider_call_id='456'"),'none');
 } finally {if(started)run('pg_ctl',['-D',dir,'-m','immediate','stop']);rmSync(dir,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});}
});
