// No provider, action, or browser authority is accepted by this module.
const terminalPublication = new Set(['applied','already_applied','stale_claim','projection_conflict']);
// A per-item projection failure (bad candidate/publication result) is poison-tolerant:
// it is caught, logged without payload, and left to expire on its own lease. Any other
// error thrown during the claims loop (pool/connection failure) is not an instance of
// this class and propagates to stop the process (supervision path, README stays true).
class ProjectionItemError extends Error {}
export async function projectionRound(client,{batchSize=25,shouldStop=()=>false}={}) {
  if (!Number.isInteger(batchSize) || batchSize<1 || batchSize>100) throw Error('Invalid projection batch');
  const counts={baseline:0,backfill:0,parent:0,expiry:0,summary:0,stale:0,poisoned:0};
  if (shouldStop()) return {counts,stopped:true};
  await client.query('SELECT inbox_control.seed_baseline_batch($1)',[100]);counts.baseline++;
  const jobs=(await client.query('SELECT * FROM inbox_backfill.claim($1,$2)',[2,300])).rows;
  for(const j of jobs){
    if(shouldStop()) return {counts,stopped:true};
    const result=(await client.query('SELECT inbox_backfill.batch($1,$2,$3) AS result',[j.org_id,j.claim_token,100])).rows[0].result;
    if(!['advanced','stale_claim'].includes(result?.result)) throw Error('Unexpected backfill result');counts.backfill++;
  }
  const parents=(await client.query('SELECT * FROM inbox_parent.claim($1,$2)',[10,300])).rows;
  for(const j of parents){
    if(shouldStop()) return {counts,stopped:true};
    const result=(await client.query('SELECT inbox_parent.batch($1,$2,$3,$4,$5) AS result',[j.org_id,j.kind,j.entity_id,j.claim_token,100])).rows[0].result;
    if(!['advanced','next_stream','completed','stale_claim'].includes(result?.result)) throw Error('Unexpected parent result');counts.parent++;
  }
  counts.expiry=Number((await client.query('SELECT inbox_control.wake_due_expiries($1) AS count',[20])).rows[0].count);
  // Every query is a separate autocommit statement. Claims commit before any
  // canonical snapshot; publication rechecks the same durable token and generation.
  const claims=(await client.query('SELECT * FROM inbox_maintained.claim_work($1,$2)',[batchSize,300])).rows;
  for(const j of claims){
    if(shouldStop()) return {counts,stopped:true};
    try{
      const candidate=(await client.query('SELECT inbox_maintained.snapshot($1,$2,$3,statement_timestamp()) AS candidate',[j.org_id,j.target_kind,j.target_id])).rows[0]?.candidate;
      if(!candidate || typeof candidate!=='object' || Array.isArray(candidate)) throw new ProjectionItemError('missing_candidate');
      const result=(await client.query('SELECT inbox_maintained.finish_work($1,$2::jsonb) AS result',[j.claim_token,candidate])).rows[0]?.result;
      if(!terminalPublication.has(result)) throw new ProjectionItemError('unexpected_publication_result');
      counts.summary++;if(result==='stale_claim' || result==='projection_conflict')counts.stale++;
    }catch(error){
      // Pool/connection errors are not ProjectionItemError and must still stop the round.
      if(!(error instanceof ProjectionItemError)) throw error;
      counts.poisoned++;
      console.error(JSON.stringify({event:'projection_item_failed',org_id:j.org_id,target_kind:j.target_kind,target_id:j.target_id,code:error.message}));
      // Leave the claim to expire naturally; bounded to one retry per 300s lease.
    }
  }
  const readiness=(await client.query('SELECT inbox_control.readiness() AS readiness')).rows[0].readiness;
  return {counts,readiness,stopped:false};
}
