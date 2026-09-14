import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'dp-duration-'));let started=false;
const run=(name,args)=>execFileSync('/opt/homebrew/opt/postgresql@17/bin/'+name,args,{encoding:'utf8',stdio:'pipe'});
const sql=q=>run('psql',['-h',dir,'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',q]).trim();
try {
 run('initdb',['-D',join(dir,'data'),'-A','trust','-U','postgres']);run('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'log'),'-o',`-k ${dir} -c listen_addresses=''`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role;
 create table call_activities(id uuid primary key,provider text,started_at timestamptz,provider_ended_at timestamptz,ended_at timestamptz,duration_seconds integer,recording_expected boolean);`);
 sql(readFileSync(new URL('./20260913224220_dialpad_duration_evidence_ordering.sql',import.meta.url),'utf8'));
 const id='11111111-1111-4111-8111-111111111111';
 sql(`insert into call_activities(id,provider,started_at) values('${id}','dialpad',to_timestamp(1000))`);
 const apply=(end,duration,event)=>sql(`select dialpad_enrich_activity('${id}','${JSON.stringify({date_ended:end,duration,event_timestamp:event})}')`);
 const state=()=>JSON.parse(sql('select row_to_json(c) from call_activities c'));
 apply(999000,71000,1100000);assert.equal(state().duration_seconds,null);assert.equal(state().provider_ended_at,null);
 apply(1071000,0,1071000);assert.equal(state().duration_seconds,0);
 apply(1071000,71000,1072000);assert.equal(state().duration_seconds,71);
 apply(1071000,0,1071000);assert.equal(state().duration_seconds,71);
 apply(1071000,0,1072000);assert.equal(state().duration_seconds,71); // equal timestamp cannot overwrite
 apply(1072000,72000,1073000);assert.equal(state().duration_seconds,71);assert.equal(Date.parse(state().provider_ended_at),1071000);
 apply(999000,1000,1074000);assert.equal(state().duration_seconds,71);
 apply(1071000,72000,1074000);assert.equal(state().duration_seconds,71); // impossible connected duration
 sql("update call_activities set provider='jitter',duration_seconds=9");apply(1071000,71000,1075000);assert.equal(state().duration_seconds,9);
 for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_table_privilege('${role}','dialpad_duration_evidence','select')`),'f');
 console.log('PASS duration temporal validation,0→71 correction, stale/equal replay, immutable terminal, wrong provider, private watermark');
}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
