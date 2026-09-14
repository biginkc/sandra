import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';

test('an idle database connection error stops the service with a retryable nonzero exit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'inbox-projector-fault-'));
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 try{
  const server=(await readFile(new URL('./server.mjs',import.meta.url),'utf8')).replace("import pg from 'pg';","import pg from './fake-pg.mjs';");
  await writeFile(join(dir,'server.mjs'),server);
  await copyFile(new URL('./core.mjs',import.meta.url),join(dir,'core.mjs'));
  await copyFile(new URL('./config.mjs',import.meta.url),join(dir,'config.mjs'));
  await writeFile(join(dir,'fake-pg.mjs'),`import {EventEmitter} from 'node:events';
   class Pool extends EventEmitter {
    totalCount=1;
    constructor(){super();setTimeout(()=>this.emit('error',Object.assign(Error('private connection detail'),{code:'08006'})),50);}
    async connect(){return {release(){},async query(sql){if(sql.includes(' AS count'))return {rows:[{count:0}]};if(sql.includes(' AS readiness'))return {rows:[{readiness:{}}]};return {rows:[]};}};}
    async end(){}
   }
   export default {Pool};`);
  const child=spawn(process.execPath,[join(dir,'server.mjs')],{env:{...process.env,INBOX_PROJECTION_DATABASE_URL:'postgresql://synthetic:unused@db.example.com/postgres',INBOX_PROJECTION_IDLE_MS:'100',INBOX_PROJECTION_BIND:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  const [code,signal]=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve([code,signal])));clearTimeout(timer);
  assert.equal(signal,null);assert.equal(code,1);assert.match(stderr,/projection_connection_error/);assert.doesNotMatch(stderr,/private connection detail/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
