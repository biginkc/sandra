import test from 'node:test';
import assert from 'node:assert/strict';
import {projectionRound} from './core.mjs';
function fixture({publication='applied',candidate={org_id:'o'},claims=[{org_id:'o',target_kind:'known_conversation',target_id:'c',claim_token:'token'}]}={}){
  const calls=[];
  const client={async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('backfill.claim')||sql.includes('parent.claim'))return {rows:[]};
    if(sql.includes('wake_due_expiries'))return {rows:[{count:0}]};
    if(sql.includes('claim_work'))return {rows:claims};
    if(sql.includes('.snapshot'))return {rows:[{candidate}]};
    if(sql.includes('finish_work'))return {rows:[{result:publication}]};
    if(sql.includes('.readiness'))return {rows:[{readiness:{queue_pending:false}}]};
    return {rows:[]};
  }};
  return {calls,client};
}
test('claims commit separately and the same token/candidate reaches publication',async()=>{
  const {client,calls}=fixture();const r=await projectionRound(client,{batchSize:25});
  assert.equal(r.counts.summary,1);
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
test('missing snapshots and invalid publication results stop rather than spin',async()=>{
  const missing=fixture({candidate:null});await assert.rejects(projectionRound(missing.client),/Missing/);
  assert.equal(missing.calls.some(x=>x.sql.includes('finish_work')),false);
  const invalid=fixture({publication:'invalid_generation'});await assert.rejects(projectionRound(invalid.client),/Unexpected projection/);
});
test('shutdown before work obtains no lease, and invalid batches issue no query',async()=>{
  const f=fixture();assert.equal((await projectionRound(f.client,{shouldStop:()=>true})).stopped,true);assert.equal(f.calls.length,0);
  await assert.rejects(projectionRound(f.client,{batchSize:101}),/Invalid/);assert.equal(f.calls.length,0);
});
test('one claimed item failure prevents later items from being published',async()=>{
  const f=fixture({candidate:null,claims:[{org_id:'o',target_kind:'known_conversation',target_id:'a',claim_token:'a'},{org_id:'o',target_kind:'known_conversation',target_id:'b',claim_token:'b'}]});
  await assert.rejects(projectionRound(f.client));assert.equal(f.calls.filter(x=>x.sql.includes('.snapshot')).length,1);
});
