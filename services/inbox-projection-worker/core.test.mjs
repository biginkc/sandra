import test from 'node:test';
import assert from 'node:assert/strict';
import {projectionRound} from './core.mjs';
function fixture({publication='applied',candidate={org_id:'o'},claims=[{org_id:'o',target_kind:'known_conversation',target_id:'c',claim_token:'token'}],perClaim={},snapshotError}={}){
  const calls=[];
  const client={async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('backfill.claim')||sql.includes('parent.claim'))return {rows:[]};
    if(sql.includes('wake_due_expiries'))return {rows:[{count:0}]};
    if(sql.includes('claim_work'))return {rows:claims};
    if(sql.includes('.snapshot')){
      const targetId=params[2];
      if(snapshotError && targetId===snapshotError)throw Object.assign(Error('connection terminated unexpectedly'),{code:'08006'});
      const override=perClaim[targetId];
      const value='candidate' in (override||{}) ? override.candidate : candidate;
      return {rows:[{candidate:value}]};
    }
    if(sql.includes('finish_work')){
      const token=params[0];
      const claim=claims.find(c=>c.claim_token===token);
      const override=claim?perClaim[claim.target_id]:undefined;
      const value='publication' in (override||{}) ? override.publication : publication;
      return {rows:[{result:value}]};
    }
    if(sql.includes('.readiness'))return {rows:[{readiness:{queue_pending:false}}]};
    return {rows:[]};
  }};
  return {calls,client};
}
test('claims commit separately and the same token/candidate reaches publication',async()=>{
  const {client,calls}=fixture();const r=await projectionRound(client,{batchSize:25});
  assert.equal(r.counts.summary,1);
  assert.equal(r.counts.poisoned,0);
  const claim=calls.findIndex(x=>x.sql.includes('claim_work'));
  const snap=calls.findIndex(x=>x.sql.includes('.snapshot'));
  const finish=calls.findIndex(x=>x.sql.includes('finish_work'));
  assert.ok(claim<snap&&snap<finish);
  assert.deepEqual(calls[claim].params,[25,300]);
  assert.deepEqual(calls[finish].params,['token',{org_id:'o'}]);
  assert.ok(calls.every(x=>!/^BEGIN|^COMMIT/.test(x.sql)));
});
test('stale claims are reported without a replacement token or invented receipt',async()=>{
  const {client,calls}=fixture({publication:'stale_claim'});const r=await projectionRound(client);
  assert.equal(r.counts.stale,1);assert.equal(calls.filter(x=>x.sql.includes('finish_work')).length,1);
});
test('shutdown before work obtains no lease, and invalid batches issue no query',async()=>{
  const f=fixture();assert.equal((await projectionRound(f.client,{shouldStop:()=>true})).stopped,true);assert.equal(f.calls.length,0);
  await assert.rejects(projectionRound(f.client,{batchSize:101}),/Invalid/);assert.equal(f.calls.length,0);
});
test('a poisoned item (claim 2 of 3) is logged without payload, skipped, and does not stop the round',async()=>{
  const claims=[
    {org_id:'org-1',target_kind:'known_conversation',target_id:'a',claim_token:'ta'},
    {org_id:'org-1',target_kind:'known_conversation',target_id:'b',claim_token:'tb'},
    {org_id:'org-1',target_kind:'known_conversation',target_id:'c',claim_token:'tc'},
  ];
  const {client,calls}=fixture({claims,perClaim:{b:{candidate:null}}});
  const originalError=console.error;const logs=[];
  console.error=(...args)=>logs.push(args.join(' '));
  let result;
  try{result=await projectionRound(client,{batchSize:25});}
  finally{console.error=originalError;}
  assert.equal(result.stopped,false);
  assert.equal(result.counts.summary,2);
  assert.equal(result.counts.poisoned,1);
  const finishCalls=calls.filter(x=>x.sql.includes('finish_work'));
  assert.equal(finishCalls.length,2);
  assert.deepEqual(finishCalls.map(x=>x.params[0]),['ta','tc']);
  assert.equal(logs.length,1);
  const logged=JSON.parse(logs[0]);
  assert.equal(logged.event,'projection_item_failed');
  assert.equal(logged.org_id,'org-1');
  assert.equal(logged.target_kind,'known_conversation');
  assert.equal(logged.target_id,'b');
  assert.equal(logged.code,'missing_candidate');
  assert.deepEqual(Object.keys(logged).sort(),['code','event','org_id','target_id','target_kind']);
});
test('an invalid publication result poisons only that item and the round still returns',async()=>{
  const claims=[
    {org_id:'org-1',target_kind:'known_conversation',target_id:'a',claim_token:'ta'},
    {org_id:'org-1',target_kind:'known_conversation',target_id:'b',claim_token:'tb'},
  ];
  const {client}=fixture({claims,perClaim:{b:{publication:'invalid_generation'}}});
  const originalError=console.error;console.error=()=>{};
  let result;
  try{result=await projectionRound(client);}finally{console.error=originalError;}
  assert.equal(result.counts.summary,1);
  assert.equal(result.counts.poisoned,1);
});
test('a pool/connection error during an item still propagates and stops the round (supervision path)',async()=>{
  const claims=[
    {org_id:'org-1',target_kind:'known_conversation',target_id:'a',claim_token:'ta'},
    {org_id:'org-1',target_kind:'known_conversation',target_id:'b',claim_token:'tb'},
  ];
  const {client,calls}=fixture({claims,snapshotError:'b'});
  await assert.rejects(projectionRound(client),/connection terminated/);
  assert.equal(calls.filter(x=>x.sql.includes('finish_work')).length,1);
});
