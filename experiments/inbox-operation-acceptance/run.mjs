import pg from 'pg';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const {Client}=pg;
if(!process.argv.includes('--run-owned-fixture')) throw new Error('Explicit owned fixture opt-in required');
const adminUrl=process.env.LOCAL_REHEARSAL_DATABASE_URL;
if(!adminUrl) throw new Error('Explicit owned local database URL required');
const url=new URL(adminUrl);
if(url.hostname!=='127.0.0.1'||url.port!=='58782'||url.pathname!=='/sandra_inbox_t1') throw new Error('Only owned T1 admin connection allowed');
const admin=new Client({connectionString:adminUrl});await admin.connect();
const db=`sandra_inbox_acceptance_${randomUUID().replaceAll('-','')}`;
const qid=s=>'"'+s.replaceAll('"','""')+'"';
let created=false;const clients=[];const checks=[];
const record=name=>checks.push({name,passed:true});
const connect=async()=>{const dburl=new URL(adminUrl);dburl.pathname='/'+db;const c=new Client({connectionString:dburl.toString()});await c.connect();await c.query("SET statement_timeout='8s'; SET lock_timeout='5s'");clients.push(c);return c;};
const hash=s=>createHash('sha256').update('sandra:inbox:action:v1\0').update(s).digest('hex');
try{
 assert.equal((await admin.query('SELECT marker FROM inbox_t1.fixture_identity')).rows[0]?.marker,'sandra-inbox-stack-t1-owned-synthetic');
 await admin.query(`CREATE DATABASE ${qid(db)}`);created=true;
 const c=await connect();
 await c.query(readFileSync(new URL('./setup.sql',import.meta.url),'utf8'));
 const o=randomUUID(),u=randomUUID(),key=randomUUID(),p=randomUUID(),target1=randomUUID(),target2=randomUUID();
 const def={version:1,steps:[{type:'outcome',value:'not_interested'},{type:'assign',userId:null}]};
 const canonical=JSON.stringify({purpose:'prepare_action',organizationId:o,requesterId:u,targets:[{kind:'conversation',id:target1},{kind:'conversation',id:target2}].sort((a,b)=>a.id.localeCompare(b.id)),definition:def,savedAction:null});
 const a=randomUUID(),b=randomUUID();
 const snapshot={items:[{id:a,kind:'conversation',target_id:target1,resolution:{property_id:p}},{id:b,kind:'conversation',target_id:target2,resolution:{property_id:p}}],effects:[{effect_key:'property:'+p,ordinal:0,action:'outcome',payload:{value:'not_interested'},dependencies:{revision:'1'},item_ids:[a,b]},{effect_key:'property:'+p,ordinal:1,action:'assign',payload:{userId:null},dependencies:{revision:'1'},item_ids:[a,b]}]};
 const prep=async({input=canonical,body=snapshot,expiry='1 hour'}={})=>{const id=randomUUID();await c.query("INSERT INTO inbox_operations.preparations VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8::interval)",[id,o,u,input,hash(input),def,body,expiry]);return id;};
 const accept=(client,id,k=key,org=o,user=u)=>client.query('SELECT inbox_operations.accept_prepared($1,$2,$3,$4) id',[org,user,k,id]);
 const id=await prep();
 await assert.rejects(c.query("INSERT INTO inbox_operations.preparations VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour')",[randomUUID(),randomUUID(),u,canonical,hash(canonical),def,snapshot]),/check constraint/);
 record('Canonical input hash and preparation tenant binding enforced in storage');
 await assert.rejects(accept(c,id),/Authoritative request access unavailable/);
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.operations')).rows[0].count,'0');record('Production core fails closed without authoritative adapter');
 // Fixture ONLY: these synthetic source/authorization tables are not Sandra
 // authorization or production canonical action eligibility.
 await c.query(`CREATE TABLE public.fixture_access(org_id uuid,requester_id uuid,allowed boolean,PRIMARY KEY(org_id,requester_id));
 CREATE TABLE public.fixture_policy(id integer PRIMARY KEY,revision bigint);INSERT INTO public.fixture_policy VALUES(1,1);
 CREATE OR REPLACE FUNCTION inbox_operations.assert_request_access(o uuid,u uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.fixture_access WHERE org_id=o AND requester_id=u AND allowed) THEN RAISE EXCEPTION 'Access unavailable';END IF;END $$;
 CREATE OR REPLACE FUNCTION inbox_operations.assert_current_preparation(p uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$ DECLARE r bigint;BEGIN SELECT revision INTO r FROM public.fixture_policy WHERE id=1 FOR UPDATE;IF r<>1 THEN RAISE EXCEPTION 'Stale fixture preparation';END IF;END $$;`);
 await c.query('INSERT INTO public.fixture_access VALUES($1,$2,true)',[o,u]);
 const op=(await accept(c,id)).rows[0].id;
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.items')).rows[0].count,'2');
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.steps')).rows[0].count,'2');
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.item_steps')).rows[0].count,'4');
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.dispatch_outbox')).rows[0].count,'1');
 assert.equal((await accept(c,id)).rows[0].id,op);record('Atomic accepted operation, two conversation mappings, deduplicated two property steps, and one dispatch event');
 const expired=await prep({expiry:'-1 hour'});
 await c.query('UPDATE public.fixture_policy SET revision=2');
 assert.equal((await accept(c,expired)).rows[0].id,op);
 await assert.rejects(accept(c,expired,randomUUID()),/Preparation expired/);
 await assert.rejects(accept(c,id,randomUUID()),/Stale fixture preparation/);
 const different=await prep({input:canonical+' '});await assert.rejects(accept(c,different),/Idempotency conflict/);
 await c.query('UPDATE public.fixture_access SET allowed=false');await assert.rejects(accept(c,id),/Access unavailable/);
 await c.query('UPDATE public.fixture_access SET allowed=true');await c.query('UPDATE public.fixture_policy SET revision=1');
 await assert.rejects(accept(c,id,randomUUID(),randomUUID()),/Access unavailable/);record('Same-hash replay survives preparation expiry/staleness; changed input conflicts and current response access remains required');
 await assert.rejects(c.query("UPDATE inbox_operations.preparations SET definition='{}' WHERE id=$1",[id]),/Immutable/);
 await assert.rejects(c.query("UPDATE inbox_operations.operations SET definition='{}' WHERE id=$1",[op]),/Immutable/);record('Preparation and accepted saved-definition copy cannot mutate');
 const invalid=await prep({body:{...snapshot,effects:[snapshot.effects[0],snapshot.effects[0]]}});
 const before=(await c.query('SELECT count(*) FROM inbox_operations.operations')).rows[0].count;
 await assert.rejects(accept(c,invalid,randomUUID()),/duplicate key/);
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.operations')).rows[0].count,before);
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.dispatch_outbox')).rows[0].count,before);record('Failure after operation/item materialization rolls back operation, items, steps and dispatch together');
 const steps=(await c.query('SELECT id,ordinal FROM inbox_operations.steps WHERE operation_id=$1 ORDER BY ordinal',[op])).rows;
 const claim=(s,seconds=30)=>c.query('SELECT inbox_operations.claim_step($1,$2,$3,$4) g',[o,op,s,seconds]);
 assert.equal((await claim(steps[1].id)).rows[0].g,null);
 const g=(await claim(steps[0].id,1)).rows[0].g;
 assert.equal((await claim(steps[0].id)).rows[0].g,null);
 await new Promise(r=>setTimeout(r,1100));
 const g2=(await claim(steps[0].id)).rows[0].g;assert.equal(BigInt(g2),BigInt(g)+1n);
 await assert.rejects(c.query('SELECT inbox_operations.finish_step($1,$2,$3,$4,$5)',[o,op,steps[0].id,g,{after_revision:'2'}]),/Stale step claim/);
 await c.query('CREATE TABLE public.fixture_effect(id integer PRIMARY KEY, writes integer NOT NULL); INSERT INTO public.fixture_effect VALUES(1,0)');
 for (const failure of ['invalid_receipt','stale_fence']) {
  await c.query('BEGIN');
  await c.query('SELECT inbox_operations.lock_step_for_effect($1,$2,$3,$4)',[o,op,steps[0].id,g2]);
  await c.query('UPDATE public.fixture_effect SET writes=writes+1 WHERE id=1');
  await assert.rejects(c.query('SELECT inbox_operations.finish_step($1,$2,$3,$4,$5)',[o,op,steps[0].id,failure==='stale_fence'?g:g2,failure==='invalid_receipt'?'[]':{after_revision:'2'}]),failure==='invalid_receipt'?/Invalid receipt/:/Stale step claim/);
  await c.query('ROLLBACK');
  assert.equal((await c.query('SELECT writes FROM public.fixture_effect')).rows[0].writes,0);
  assert.equal((await c.query('SELECT count(*) FROM inbox_operations.receipts')).rows[0].count,'0');
 }
 await c.query('BEGIN');
 await c.query('SELECT inbox_operations.lock_step_for_effect($1,$2,$3,$4)',[o,op,steps[0].id,g2]);
 await c.query('UPDATE public.fixture_effect SET writes=writes+1 WHERE id=1');
 await c.query('SELECT inbox_operations.finish_step($1,$2,$3,$4,$5)',[o,op,steps[0].id,g2,{before_revision:'1',after_revision:'2'}]);
 await c.query('COMMIT');
 // Actual replay entry guard fails before the synthetic effect can run again.
 await c.query('BEGIN');
 await assert.rejects(c.query('SELECT inbox_operations.lock_step_for_effect($1,$2,$3,$4)',[o,op,steps[0].id,g2]),/Stale step claim/);
 await c.query('ROLLBACK');
 assert.equal((await c.query('SELECT writes FROM public.fixture_effect')).rows[0].writes,1);
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.receipts')).rows[0].count,'1');
 record('Synthetic canonical effect rolls back with receipt/fence failure; successful transaction and replay retain one effect and receipt');
 assert.equal((await claim(steps[0].id)).rows[0].g,null);
 const next=(await claim(steps[1].id)).rows[0].g;
 const locked=(await c.query('SELECT inbox_operations.lock_step_for_effect($1,$2,$3,$4) v',[o,op,steps[1].id,next])).rows[0].v;
 assert.equal(locked.predecessor_result.after_revision,'2');record('Expired worker fenced; completion rollback atomic; completed step cannot be reclaimed; dependent assignment receives prior outcome receipt');
 const dispatch=(await c.query('SELECT inbox_operations.claim_dispatch($1,$2,1) v',[o,op])).rows[0].v;
 await new Promise(r=>setTimeout(r,1100));
 const dispatch2=(await c.query('SELECT inbox_operations.claim_dispatch($1,$2,30) v',[o,op])).rows[0].v;
 assert.equal(dispatch.event_id,dispatch2.event_id);assert.notEqual(dispatch.generation,dispatch2.generation);
 assert.equal((await c.query('SELECT inbox_operations.ack_dispatch($1,$2,$3) v',[o,op,dispatch.generation])).rows[0].v,false);
 assert.equal((await c.query('SELECT inbox_operations.ack_dispatch($1,$2,$3) v',[o,op,dispatch2.generation])).rows[0].v,true);record('Dispatcher lease reclaim retains stable event identity and rejects stale acknowledgement');
 // Revoke PUBLIC access is independent of owning connection's RLS bypass.
 const acl=(await c.query("SELECT count(*) n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname='inbox_operations' AND a.grantee=0 AND a.privilege_type='EXECUTE'")).rows[0].n;
 // Fixture CREATE OR REPLACE retains the original private ACL.
 assert.equal(acl,'0');
 const deniedRoles=(await c.query("SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated','service_role')")).rows.map(r=>r.rolname);
 for(const role of deniedRoles) {
  await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${qid(role)}`);
  try { await assert.rejects(c.query('SELECT inbox_operations.accept_prepared($1,$2,$3,$4)',[o,u,key,id]),e=>e.code==='42501'); }
  finally { await c.query('ROLLBACK'); }
 }
 record('No PUBLIC execute grants; direct acceptance denied for existing roles: '+(deniedRoles.join(', ')||'none present (ACL evidence only)'));
 const c2=await connect();const c3=await connect();const concurrentKey=randomUUID();
 await c2.query('BEGIN');const concurrentOp=(await accept(c2,id,concurrentKey)).rows[0].id;
 const pending=accept(c3,expired,concurrentKey);let blocked=false;
 for(let i=0;i<40;i++) {if((await c.query('SELECT cardinality(pg_blocking_pids($1))>0 b',[c3.processID])).rows[0].b){blocked=true;break;}await new Promise(r=>setTimeout(r,25));}
 assert.equal(blocked,true);await c2.query('COMMIT');assert.equal((await pending).rows[0].id,concurrentOp);
 assert.equal((await c.query('SELECT count(*) FROM inbox_operations.operations WHERE idempotency_key=$1',[concurrentKey])).rows[0].count,'1');record('Concurrent replay with expired preparation waits for the accepted key and returns the same durable operation');
}finally{
 await Promise.allSettled(clients.map(c=>c.end()));
 if(created){await admin.query(`DROP DATABASE ${qid(db)}`);assert.equal((await admin.query('SELECT count(*) FROM pg_database WHERE datname=$1',[db])).rows[0].count,'0');}
 await admin.end();
}
const evidence={at:new Date().toISOString(),checks,cleanup:'Exact created disposable database removed',setup_sha256:createHash('sha256').update(readFileSync(new URL('./setup.sql',import.meta.url))).digest('hex'),runner_sha256:createHash('sha256').update(readFileSync(new URL('./run.mjs',import.meta.url))).digest('hex'),limits:['Synthetic private adapter only; real authorization and canonical effects not integrated','No provider calls, no application endpoints, no production migration','No cross-replica admission budgets, failure/retry receipts or cancellation implemented yet']};
writeFileSync(new URL('./evidence.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
