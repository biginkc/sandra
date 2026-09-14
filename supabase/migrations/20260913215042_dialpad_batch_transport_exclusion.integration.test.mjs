/** Reciprocal database lock proof; minimal fixtures, not full schema rehearsal. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import pg from "pg";
const bin=process.env.PG17_BIN??"/opt/homebrew/opt/postgresql@17/bin";
const dir=mkdtempSync(path.join(tmpdir(),"dialpad-batch-"));
const data=path.join(dir,"data");let started=false;let a,b;
try {
 execFileSync(path.join(bin,"initdb"),["-D",data,"-A","trust","-U","postgres","--no-locale"],{stdio:"pipe"});
 execFileSync(path.join(bin,"pg_ctl"),["-D",data,"-l",path.join(dir,"log"),"-o",`-k ${dir} -c listen_addresses=''`,"-w","start"],{stdio:"pipe"});started=true;
 a=new pg.Client({host:dir,user:"postgres",database:"postgres"});b=new pg.Client({host:dir,user:"postgres",database:"postgres"});await a.connect();await b.connect();
 await a.query(`create role anon;create role authenticated;create role service_role;
 create table dialer_batches(id integer primary key,org_id uuid,status text);
 create table dialpad_voice_intents(id integer primary key,org_id uuid,status text);`);
 await a.query(readFileSync(new URL("./20260913215042_dialpad_batch_transport_exclusion.sql",import.meta.url),"utf8"));
 const org="11111111-1111-4111-8111-111111111111",other="22222222-2222-4222-8222-222222222222";
 await a.query("insert into dialer_batches values(1,$1,'pending')",[org]);
 const pid=(await b.query("select pg_backend_pid() pid")).rows[0].pid;
 async function assertWaiting() {
  for(let i=0;i<100;i++) {
   const r=await a.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted",[pid]);
   if(r.rowCount===1)return;
   await new Promise(r=>setTimeout(r,10));
  }
  assert.fail("competing transaction never acquired an advisory lock wait");
 }
 // Dialpad owns the reservation first: a simultaneous batch claim waits, then fails.
 await a.query("begin");await a.query("insert into dialpad_voice_intents values(1,$1,'prepared')",[org]);
 let blocked=b.query("update dialer_batches set status='claimed' where id=1").then(()=>({ok:true}),e=>({code:e.code}));
 await assertWaiting();await a.query("commit");assert.equal((await blocked).code,"23514");
 assert.equal((await a.query("select status from dialer_batches where id=1")).rows[0].status,"pending");
 // Unrelated org is not blocked. Finishing the Dialpad intent permits a claim.
 await a.query("insert into dialer_batches values(2,$1,'claimed')",[other]);
 await a.query("update dialpad_voice_intents set status='completed' where id=1");
 // Batch owns the claim first: simultaneous Dialpad start waits, then fails.
 await a.query("begin");await a.query("update dialer_batches set status='claimed' where id=1");
 blocked=b.query("insert into dialpad_voice_intents values(3,$1,'prepared')",[org]).then(()=>({ok:true}),e=>({code:e.code}));
 await assertWaiting();await a.query("commit");assert.equal((await blocked).code,"23514");
 assert.equal((await a.query("select count(*) from dialpad_voice_intents where id=3")).rows[0].count,"0");
 await a.query("update dialer_batches set status='in_progress' where id=1");
 await assert.rejects(a.query("insert into dialpad_voice_intents values(4,$1,'prepared')",[org]),{code:"23514"});
 await a.query("insert into dialpad_voice_intents values(6,$1,'failed')",[org]);
 await assert.rejects(a.query("update dialpad_voice_intents set status='linked' where id=6"),{code:"23514"});
 assert.equal((await a.query("select status from dialpad_voice_intents where id=6")).rows[0].status,"failed");
 await a.query("update dialer_batches set status='completed' where id=1");
 await a.query("insert into dialpad_voice_intents values(5,$1,'prepared')",[org]);
 assert.equal((await a.query("select has_function_privilege('authenticated','public.batch_exclude_active_dialpad()','execute') allowed")).rows[0].allowed,false);
 console.log("PASS: reciprocal batch/Dialpad exclusion, both concurrent orderings, cross-org separation, terminal transitions, private trigger functions.");
} finally {
 if(a)await a.query("rollback").catch(()=>{});
 if(a)await a.end().catch(()=>{});if(b)await b.end().catch(()=>{});
 if(started)execFileSync(path.join(bin,"pg_ctl"),["-D",data,"-m","immediate","-w","stop"],{stdio:"pipe"});
 rmSync(dir,{recursive:true,force:true});
}
