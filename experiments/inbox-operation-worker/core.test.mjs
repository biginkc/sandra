import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRunner,dispatchBatch} from './core.mjs';
const id=n=>`abcdef00-0000-4000-8000-${String(n).padStart(12,'0')}`;
const entry={org_id:id(1),operation_id:id(2),event_id:id(3),generation:'1'};
function pool(results){const calls=[];return {calls,query:async(sql,args)=>{calls.push({sql,args});const result=results.shift();if(result instanceof Error)throw result;return {rows:[{result}]};}};}
test('stable event identity and ack only after accepted engine response',async()=>{const db=pool([[entry],true]);let sent;assert.equal(await dispatchBatch(db,async(url,options)=>{sent={url:String(url),options};return new Response(JSON.stringify({status:'Accepted',invocationId:'inv_abc123'}));},'http://restate:8080/'),1);assert.equal(sent.options.headers['idempotency-key'],id(3));assert.deepEqual(JSON.parse(sent.options.body),{orgId:id(1),operationId:id(2)});assert.deepEqual(db.calls[1].args,[id(1),id(2),'1']);});
test('lost response never acknowledges SQL outbox',async()=>{const db=pool([[entry]]);await assert.rejects(()=>dispatchBatch(db,async()=>{throw Error('lost');},'http://restate:8080/'),/lost/);assert.equal(db.calls.length,1);});
test('unrecognized durable response never acknowledges SQL outbox',async()=>{const db=pool([[entry]]);await assert.rejects(()=>dispatchBatch(db,async()=>new Response(JSON.stringify({status:'Maybe'})),'http://restate:8080/'));assert.equal(db.calls.length,1);});
test('reconciles committed terminal failure as a completed durable step',async()=>{const db=pool([{org_id:id(1),operation_id:id(2),steps:[id(4)]},{step_id:id(4),state:'conflicted',receipt:{code:'record_changed'}}]);const runner=createRunner(db),operation=await runner.load({orgId:id(1),operationId:id(2)});assert.deepEqual(await runner.step(operation,id(4)),{stepId:id(4),state:'conflicted'});});
test('retries only explicit aborted whole SQL statement with stable identity',async()=>{const aborted=Object.assign(Error('deadlock'),{code:'40P01'});const db=pool([aborted,{step_id:id(4),state:'succeeded',receipt:{}}]);await createRunner(db).step({orgId:id(1),operationId:id(2),steps:[id(4)]},id(4));assert.deepEqual(db.calls[0],db.calls[1]);});
test('ambiguous step response is not eagerly retried',async()=>{const db=pool([Error('lost')]);await assert.rejects(()=>createRunner(db).step({orgId:id(1),operationId:id(2),steps:[id(4)]},id(4)),/lost/);assert.equal(db.calls.length,1);});
test('rejects unknown step before database access',async()=>{const db=pool([]);await assert.rejects(()=>createRunner(db).step({orgId:id(1),operationId:id(2),steps:[id(4)]},id(5)));assert.equal(db.calls.length,0);});
import {workerConfiguration,createReadinessProbe} from './core.mjs';
test('false acknowledgment fence does not count as dispatch success',async()=>{const db=pool([[entry],false]);await assert.rejects(()=>dispatchBatch(db,async()=>new Response(JSON.stringify({status:'Accepted',invocationId:'inv_a'})),'http://restate:8080/'),/fence expired/);});
test('streaming durable response is cancelled at byte bound before ack',async()=>{const db=pool([[entry]]);let cancelled=false;const body=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}});await assert.rejects(()=>dispatchBatch(db,async()=>new Response(body),'http://restate:8080/'),/Invalid durable/);assert.equal(cancelled,true);assert.equal(db.calls.length,1);});
test('runtime requires exact private host, signing keys and two-connection ceiling',()=>{const env={INBOX_RESTATE_INGRESS_URL:'http://inbox-restate.railway.internal:8080/',INBOX_RESTATE_IDENTITY_KEYS:JSON.stringify(['publickeyv1_'+'A'.repeat(43)])};assert.equal(workerConfiguration(env).connections,2);for(const change of [{INBOX_RESTATE_INGRESS_URL:'https://public.example:8080/'},{INBOX_RESTATE_IDENTITY_KEYS:'[]'},{INBOX_ACTION_CONNECTIONS:'3'}])assert.throws(()=>workerConfiguration({...env,...change}));});
test('readiness probes coalesce and invalidation defeats late healthy reply',async()=>{let resolve,calls=0,now=100;const ready=createReadinessProbe(()=>{calls++;return new Promise(r=>{resolve=r;});},()=>now);const first=ready.read(),second=ready.read();assert.equal(calls,1);ready.invalidate();resolve(true);assert.deepEqual(await Promise.all([first,second]),[false,false]);assert.equal(await ready.read(),false);now=2201;const third=ready.read();resolve(true);assert.equal(await third,true);assert.equal(calls,2);});
import {databaseConfiguration} from './core.mjs';
test('production database TLS verifies chain and exact hostname; URL cannot override ssl',()=>{const env={INBOX_ACTION_DATABASE_URL:'postgres://inbox_action_worker:synthetic@db.example.supabase.co:5432/postgres'};const c=databaseConfiguration(env);assert.equal(c.ssl.rejectUnauthorized,true);assert.equal(c.ssl.servername,'db.example.supabase.co');assert.throws(()=>databaseConfiguration({...env,INBOX_ACTION_DATABASE_URL:env.INBOX_ACTION_DATABASE_URL+'?sslmode=require'}));assert.throws(()=>databaseConfiguration({...env,INBOX_ACTION_LOCAL_FIXTURE:'1'}));});
test('plaintext is restricted to explicit test mode and exact owned database alias/name',()=>{const env={INBOX_ACTION_DATABASE_URL:'postgres://inbox_action_worker:synthetic@sandra-inbox-actions-db-owned:5432/sandra_inbox_action_runtime_20260913',INBOX_ACTION_LOCAL_FIXTURE:'1',NODE_ENV:'test'};assert.equal(databaseConfiguration(env).ssl,false);assert.throws(()=>databaseConfiguration({...env,NODE_ENV:'production'}));assert.throws(()=>databaseConfiguration({...env,INBOX_ACTION_DATABASE_URL:env.INBOX_ACTION_DATABASE_URL.replace('runtime_20260913','other')}));});

test('pinned SDK rejects unsigned discovery and callbacks before invoking a handler',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {createEndpointHandler,service}=await import('@restatedev/restate-sdk/fetch');
 const {publicKey}=generateKeyPairSync('ed25519');
 const raw=publicKey.export({format:'der',type:'spki'}).subarray(-32);
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 let number=BigInt('0x'+raw.toString('hex')),encoded='';
 while(number){encoded=alphabet[Number(number%58n)]+encoded;number/=58n;}
 for(const byte of raw){if(byte!==0)break;encoded='1'+encoded;}
 let invoked=0;
 const handler=createEndpointHandler({identityKeys:['publickeyv1_'+encoded],services:[service({name:'InboxMetadataOperation',handlers:{run:async()=>{invoked++;return {};}}})]});
 for(const path of ['/discover','/invoke/InboxMetadataOperation/run']){
  const response=await handler(new Request('http://owned.invalid'+path,{method:'POST',headers:{'content-type':'application/vnd.restate.invocation.v5'},body:new Uint8Array()}));
  assert.equal(response.status,401);assert.match(await response.text(),/Unauthorized/);
 }
 assert.equal(invoked,0);
});

test('rejected dispatch cancels its response stream without acknowledging the lease',async()=>{
 const db=pool([[entry]]);let cancelled=false;
 const body=new ReadableStream({cancel(){cancelled=true;}});
 await assert.rejects(()=>dispatchBatch(db,async()=>new Response(body,{status:503}),'http://restate:8080/'),/Durable dispatch rejected/);
 assert.equal(cancelled,true);assert.equal(db.calls.length,1);
});

test('idle readiness requires the actual engine and registered metadata service',async()=>{
 const {createRestateReadinessProbe}=await import('./core.mjs');let now=1,calls=0;
 const probe=createRestateReadinessProbe(async(url,options)=>{calls++;assert.equal(String(url),'http://restate:8080/restate/health');assert.equal(options.method,'GET');return new Response(JSON.stringify({services:calls===1?['OtherService']:['InboxMetadataOperation']}));},'http://restate:8080/',()=>now);
 assert.equal(await probe.read(),false);assert.equal(await probe.read(),false);assert.equal(calls,1);
 now+=2001;assert.equal(await probe.read(),true);
});
test('engine readiness fails closed on unreachable or oversized health responses',async()=>{
 const {createRestateReadinessProbe}=await import('./core.mjs');
 assert.equal(await createRestateReadinessProbe(async()=>{throw Error('offline');},'http://restate:8080/').read(),false);
 assert.equal(await createRestateReadinessProbe(async()=>new Response('x'.repeat(16385)),'http://restate:8080/').read(),false);
});
