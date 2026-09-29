import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

async function freePort(){
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  return port;
}
async function harness(fakePg){
  const dir=await mkdtemp(join(tmpdir(),'inbox-projector-'));
  const server=(await readFile(new URL('./server.mjs',import.meta.url),'utf8')).replace("import pg from 'pg';","import pg from './fake-pg.mjs';");
  await writeFile(join(dir,'server.mjs'),server);
  await copyFile(new URL('./core.mjs',import.meta.url),join(dir,'core.mjs'));
  await copyFile(new URL('./config.mjs',import.meta.url),join(dir,'config.mjs'));
  await writeFile(join(dir,'fake-pg.mjs'),fakePg);
  return dir;
}

test('an idle database connection error stops the service with a retryable nonzero exit',async()=>{
 const dir=await harness(`import {EventEmitter} from 'node:events';
   class Pool extends EventEmitter {
    totalCount=1;
    constructor(){super();setTimeout(()=>this.emit('error',Object.assign(Error('private connection detail'),{code:'08006'})),50);}
    async connect(){return {release(){},async query(sql){if(sql.includes(' AS count'))return {rows:[{count:0}]};if(sql.includes(' AS readiness'))return {rows:[{readiness:{}}]};return {rows:[]};}};}
    async end(){}
   }
   export default {Pool};`);
 const port=await freePort();
 try{
  const child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,INBOX_PROJECTION_DATABASE_URL:'postgresql://synthetic:unused@db.example.com/postgres',INBOX_PROJECTION_IDLE_MS:'100',INBOX_PROJECTION_BIND:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  const [code,signal]=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve([code,signal])));clearTimeout(timer);
  assert.equal(signal,null);assert.equal(code,1);assert.match(stderr,/projection_connection_error/);assert.doesNotMatch(stderr,/private connection detail/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a round where every claim is poisoned leaves the process alive with /health 200 and poisoned>0',async()=>{
 const dir=await harness(`import {EventEmitter} from 'node:events';
   class Pool extends EventEmitter {
    totalCount=1;
    async connect(){return {release(){},async query(sql,params){
      if(sql.includes('claim_work'))return {rows:[{org_id:'org-1',target_kind:'known_conversation',target_id:'poison-target',claim_token:'tok-'+Math.random()}]};
      if(sql.includes('.snapshot'))return {rows:[{candidate:null}]};
      if(sql.includes(' AS count'))return {rows:[{count:0}]};
      if(sql.includes(' AS readiness'))return {rows:[{readiness:{}}]};
      return {rows:[]};
    }};}
    async end(){}
   }
   export default {Pool};`);
 const port=await freePort();
 const child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,INBOX_PROJECTION_DATABASE_URL:'postgresql://synthetic:unused@db.example.com/postgres',INBOX_PROJECTION_IDLE_MS:'100',INBOX_PROJECTION_BIND:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 try{
  let body=null;
  for(let attempt=0;attempt<50 && !(body && body.poisoned>0);attempt++){
   await delay(100);
   try{
    const res=await fetch(`http://127.0.0.1:${port}/health`);
    if(res.status===200)body=await res.json();
   }catch{/* server may not be listening yet */}
  }
  assert.ok(body,'expected /health to eventually respond 200');
  assert.equal(body.healthy,true);
  assert.ok(body.poisoned>0,`expected poisoned>0, got ${JSON.stringify(body)}`);
  assert.equal(child.exitCode,null);
  assert.doesNotMatch(stderr,/payload|summary\b.*org-1/);
 }finally{
  child.kill('SIGKILL');
  await new Promise(resolve=>child.on('exit',resolve));
  await rm(dir,{recursive:true,force:true});
 }
});

test('SIGTERM mid-round stops the loop before the remaining claims in that round and exits cleanly',async()=>{
 const dir=await harness(`import {EventEmitter} from 'node:events';
   class Pool extends EventEmitter {
    totalCount=1;
    async connect(){return {release(){},async query(sql,params){
      if(sql.includes('claim_work'))return {rows:Array.from({length:5},(_,i)=>({org_id:'org-1',target_kind:'known_conversation',target_id:'t'+i,claim_token:'tok'+i}))};
      if(sql.includes('.snapshot')){await new Promise(r=>setTimeout(r,150));return {rows:[{candidate:{org_id:'org-1'}}]};}
      if(sql.includes('finish_work'))return {rows:[{result:'applied'}]};
      if(sql.includes(' AS count'))return {rows:[{count:0}]};
      if(sql.includes(' AS readiness'))return {rows:[{readiness:{}}]};
      return {rows:[]};
    }};}
    async end(){}
   }
   export default {Pool};`);
 const port=await freePort();
 try{
  const child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,INBOX_PROJECTION_DATABASE_URL:'postgresql://synthetic:unused@db.example.com/postgres',INBOX_PROJECTION_IDLE_MS:'100',INBOX_PROJECTION_BIND:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  await delay(100);
  const started=performance.now();
  child.kill('SIGTERM');
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  const [code,signal]=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve([code,signal])));
  clearTimeout(timer);
  const elapsed=performance.now()-started;
  assert.equal(signal,null);
  assert.equal(code,0);
  // 5 claims * 150ms snapshot delay each would be >=750ms; a clean mid-round stop
  // exits well before the round would have finished all 5 claims.
  assert.ok(elapsed<700,`expected mid-round SIGTERM to stop quickly, took ${elapsed}ms`);
 }finally{await rm(dir,{recursive:true,force:true});}
});
