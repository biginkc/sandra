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
 sql(`create role anon;create role authenticated;create role service_role;create table dialpad_voice_intents(id uuid,org_id uuid,actor_user_id uuid,status text,provider_call_id text);create table dialpad_intent_configuration(org_id uuid,intent_id uuid,primary key(org_id,intent_id));create table dialpad_sequence_pause_controls(intent_id uuid,dispatch_started boolean);create function dialpad_history_immutable() returns trigger language plpgsql as $$begin raise exception 'immutable';end$$;`);
 sql(readFileSync(new URL('./20260914035000_dialpad_dispatch_response_receipts.sql',import.meta.url),'utf8'));
 const id=n=>`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,org=id(1),actor=id(2),intent=id(3);
 sql(`insert into dialpad_voice_intents values('${intent}','${org}','${actor}','initiation_unconfirmed',null);insert into dialpad_intent_configuration values('${org}','${intent}');insert into dialpad_sequence_pause_controls values('${intent}',false)`);
 const request=(call='9007199254740993',who=actor,tenant=org,role='service_role')=>`set role ${role};select fn_record_dialpad_dispatch_response('${tenant}','${who}','${intent}','${call}')`;
 assert.throws(()=>sql(request()));sql(`update dialpad_sequence_pause_controls set dispatch_started=true`);
 assert.throws(()=>sql(request('1',id(4))));assert.throws(()=>sql(request('1',actor,id(5))));assert.throws(()=>sql(request('1',actor,org,'authenticated')));assert.throws(()=>sql(request('1e10')));
 const invoke=async()=>JSON.parse((await promisify(execFile)(join(bin,'psql'),['-h',dir,'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',request()])).stdout.split('\n').find(x=>x.startsWith('{')));
 const results=await Promise.all([invoke(),invoke()]);assert.equal(results.filter(r=>r.duplicate===false).length,1);assert.equal(results.filter(r=>r.duplicate===true).length,1);
 assert.throws(()=>sql(request('999')));assert.throws(()=>sql(`update dialpad_dispatch_response_receipts set candidate_call_id='999'`));
 assert.equal(sql(`select status||':'||coalesce(provider_call_id,'null') from dialpad_voice_intents`),'initiation_unconfirmed:null');
 sql(`update dialpad_voice_intents set status='completed'`);assert.match(sql(request()),/"duplicate": true/);
 console.log('PASS response receipt tenant/actor scope, prior dispatch required, concurrent replay, conflict rejection, immutable candidate and unchanged authoritative call state; prerequisite fixtures');

}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
