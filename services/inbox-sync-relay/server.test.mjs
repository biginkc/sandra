import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRelayServer, columns } from './server.mjs';
// Shared with src/lib/inbox/sync-upstream-config.test.ts (G4 / #592): both suites must agree on
// which tokens are accepted. Do not fork this file; edit deployment/inbox/relay-token-fixtures.json instead.
const fixturePath = fileURLToPath(new URL('../../deployment/inbox/relay-token-fixtures.json', import.meta.url));
const tokenFixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
const token = 'synthetic-test-token-with-more-than-32-characters';
const params = new URLSearchParams({table:'inbox_bridge.projection',columns,replica:'default',offset:'-1',where:'org_id=$1','params[1]':'synthetic-org'});
async function fixture(transport, run, maxConcurrent = 32) {
 const server=createRelayServer({upstream:'http://electric.invalid/',token,projectionTable:'inbox_bridge.projection',transport,maxConcurrent});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try { await run(`http://127.0.0.1:${server.address().port}`); }
 finally { await new Promise(resolve=>server.close(resolve)); }
}
test('secret protects shape requests and is never forwarded upstream',async()=>{
 let calls=0;
 await fixture(async(url,init)=>{calls++;assert.equal(url.hostname,'electric.invalid');assert.equal(init.headers,undefined);return new Response('[]',{headers:{'electric-offset':'0_0','x-private':'secret','set-cookie':'bad'}});},async base=>{
  assert.equal((await fetch(`${base}/v1/shape?${params}`)).status,401);
  const r=await fetch(`${base}/v1/shape?${params}`,{headers:{authorization:`Bearer ${token}`,cookie:'private-browser-cookie'}});
  assert.equal(r.status,200);assert.equal(await r.text(),'[]');assert.equal(r.headers.get('electric-offset'),'0_0');assert.equal(r.headers.get('x-private'),null);assert.equal(r.headers.get('set-cookie'),null);assert.equal(calls,1);
 });
});
test('rejects other tables, duplicate predicates, arbitrary controls and mutations',async()=>{
 await fixture(()=>{throw Error('must not call upstream');},async base=>{
  const headers={authorization:`Bearer ${token}`};
  for(const suffix of ['&where=other','&secret=leak','&params[0]=bad'])assert.equal((await fetch(`${base}/v1/shape?${params}${suffix}`,{headers})).status,400);
  const other=new URLSearchParams(params);other.set('table','public.messages');assert.equal((await fetch(`${base}/v1/shape?${other}`,{headers})).status,400);
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{method:'POST',headers})).status,405);
 });
});
test('readiness requires upstream200; oversize and upstream failures stay bounded',async()=>{
 let count=0;
 await fixture(async url=>{if(url.pathname==='/v1/health')return new Response('',{status:++count===1?202:200});return new Response('x'.repeat(2_000_001));},async base=>{
  assert.equal((await fetch(`${base}/health`)).status,503);
  await new Promise(resolve=>setTimeout(resolve,1050));
  assert.equal((await fetch(`${base}/health`)).status,200);
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{headers:{authorization:`Bearer ${token}`}})).status,413);
 });
 await fixture(async()=>{throw Error('private database host/secret must not leak');},async base=>{
  const r=await fetch(`${base}/v1/shape?${params}`,{headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,502);assert.equal(await r.text(),'');
 });
});

test('bounds simultaneous buffered requests rather than growing without admission',async()=>{
 let release,started;
 const admitted=new Promise(resolve=>{started=resolve;});
 await fixture(async()=>{started();await new Promise(resolve=>{release=resolve;});return new Response('[]');},async base=>{
  const headers={authorization:`Bearer ${token}`};
  const first=fetch(`${base}/v1/shape?${params}`,{headers});await admitted;
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{headers})).status,503);
  release();assert.equal((await first).status,200);
 },1);
});

test('coalesces public health probes without consuming authenticated shape slots',async()=>{
 let release,started,healthCalls=0;
 const began=new Promise(resolve=>{started=resolve;});
 await fixture(async url=>{
  if(url.pathname==='/v1/health'){healthCalls++;started();await new Promise(resolve=>{release=resolve;});return new Response('');}
  return new Response('[]');
 },async base=>{
  const first=fetch(`${base}/health`);await began;
  const second=fetch(`${base}/health`);
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{headers:{authorization:`Bearer ${token}`}})).status,200);
  release();assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(healthCalls,1);
 },1);
});
test('caches immediate health failures before allowing another probe',async()=>{
 let calls=0;
 await fixture(async()=>{calls++;throw Error('connection refused');},async base=>{
  for(let i=0;i<5;i++)assert.equal((await fetch(`${base}/health`)).status,503);
  assert.equal(calls,1);
  await new Promise(resolve=>setTimeout(resolve,1050));
  assert.equal((await fetch(`${base}/health`)).status,503);assert.equal(calls,2);
 });
});
test('client disconnect aborts the upstream request and releases admission',async()=>{
 let started,aborted,calls=0;
 const began=new Promise(resolve=>{started=resolve;});
 const ended=new Promise(resolve=>{aborted=resolve;});
 await fixture(async(_url,{signal})=>{
  if(++calls>1)return new Response('[]');
  started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted();reject(signal.reason);},{once:true}));
 },async base=>{
  const headers={authorization:`Bearer ${token}`},controller=new AbortController();
  const first=fetch(`${base}/v1/shape?${params}`,{headers,signal:controller.signal});
  const rejected=assert.rejects(first);await began;controller.abort();await rejected;await ended;
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{headers})).status,200);
 },1);
});
test('an idle upstream cannot exceed the relay deadline or retain its admission slot',async()=>{
 let calls=0;
 await fixture(async(_url,{signal})=>{
  if(++calls>1)return new Response('[]');
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 },async base=>{
  const headers={authorization:`Bearer ${token}`},started=Date.now();
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{headers})).status,502);
  assert.ok(Date.now()-started<16000);
  assert.equal((await fetch(`${base}/v1/shape?${params}`,{headers})).status,200);
 },1);
});

async function fixtureWithToken(transport, run, maxConcurrent, tokenOverride) {
 const server=createRelayServer({upstream:'http://electric.invalid/',token:tokenOverride,projectionTable:'inbox_bridge.projection',transport,maxConcurrent});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try { await run(`http://127.0.0.1:${server.address().port}`); }
 finally { await new Promise(resolve=>server.close(resolve)); }
}

test('accepts every Next-valid relay token from the shared parity fixture (G4 / #592)',async()=>{
 for (const fixtureToken of tokenFixtures.valid) {
  await fixtureWithToken(async()=>new Response('[]',{headers:{'electric-offset':'0_0'}}),async base=>{
   const r=await fetch(`${base}/v1/shape?${params}`,{headers:{authorization:`Bearer ${fixtureToken}`}});
   assert.equal(r.status,200,`relay must accept Next-valid fixture token: ${JSON.stringify(fixtureToken)}`);
  },32,fixtureToken);
 }
});
