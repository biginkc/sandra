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
 sql(`create table dialpad_recording_artifacts(id integer,status text,lease_token text,lease_expires_at timestamptz);insert into dialpad_recording_artifacts values(1,'processing','old',clock_timestamp()-interval '1 second');`);
 sql(readFileSync(new URL('./20260914035500_dialpad_recording_lease_expiry.sql',import.meta.url),'utf8'));
 for(const status of ['available','retry','failed','denied'])assert.throws(()=>sql(`update dialpad_recording_artifacts set status='${status}' where id=1 and lease_token='old'`),/DIALPAD_RECORDING_LEASE_EXPIRED/);
 sql(`update dialpad_recording_artifacts set lease_token='new',lease_expires_at=clock_timestamp()+interval '10 seconds' where id=1`);
 assert.equal(sql(`update dialpad_recording_artifacts set status='available' where id=1 and lease_token='old' returning id`),'UPDATE 0');
 sql(`update dialpad_recording_artifacts set status='available' where id=1 and lease_token='new'`);
 assert.equal(sql('select status from dialpad_recording_artifacts'),'available');
 console.log('PASS expired lease cannot publish available/retry/failed/denied; fresh reclaimed lease succeeds and old token cannot publish');

}finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
