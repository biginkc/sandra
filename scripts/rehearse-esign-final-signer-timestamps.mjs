import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

export async function rehearseFinalSignerTimestamps(client, ids) {
  await client.query(`alter table public.esign_request_signers
    add column if not exists provider_signature_id text,
    add column if not exists status text default 'awaiting',
    add column if not exists signed_at timestamptz,
    add column if not exists viewed_at timestamptz,
    add column if not exists reminder_claim_token uuid,
    add column if not exists reminder_claimed_at timestamptz,
    add column if not exists updated_at timestamptz default now()`);
  const migration = readFileSync('supabase/migrations/20260912233100_esign_final_signer_timestamps.sql','utf8');
  await client.query('begin');
  await client.query(migration.replace(/^begin;$/m,'').replace(/^commit;$/m,''));
  await client.query('rollback');
  assert.equal((await client.query("select to_regclass('public.esign_completion_reconciliation_audits') t")).rows[0].t,null);
  await client.query(migration); await client.query(migration);
  const id=randomUUID(); const template=(await client.query('select id from public.esign_templates where org_id=$1 limit 1',[ids.org])).rows[0].id;
  const seller=1789249085, buyer=1789249116, event=1789249120;
  await client.query(`insert into public.esign_requests(id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,status,delivery_state,send_intent_id,payload_hash,sign_request_id,completed_at) values($1,$2,$3,$4,'[]','{}','signed','sent',$5,$6,$8,to_timestamp($7))`,[id,ids.org,ids.property,template,randomUUID(),'a'.repeat(64),seller,id]);
  for(const [role,order] of [['Seller',0],['Buyer',1]]) await client.query(`insert into public.esign_request_signers(org_id,request_id,role_name,signer_order,signer_name,signer_email,provider_signature_id,status,signed_at) values($1,$2,$3,$4,$3,$5,$3,'signed',to_timestamp($6))`,[ids.org,id,role,order,`${role}@example.com`,seller]);
  const hash=createHash('sha256').update(id).digest('hex');
  const c=(await client.query('select * from public.claim_verified_esign_webhook_receipt($1,$2,$3,$3,$3,$4,$5,null,$6,to_timestamp($7),now(),$8)',[ids.org,ids.consumer,hash,'signature_request_all_signed',id,JSON.stringify({event_type:'signature_request_all_signed',event_time:String(event),sign_request_id:id,related_signature_id:null,reported_for_app_id:null}),event,randomUUID()])).rows[0];
  const proof=[{signatureId:'Seller',statusCode:'signed',signedAt:seller},{signatureId:'Buyer',statusCode:'signed',signedAt:buyer}];
  const reconcile=(values,lease=c.lease_id) => client.query('select * from public.reconcile_esign_webhook_provider_signers($1,$2,$3,$4,to_timestamp($5),$6,null)',[ids.org,id,c.receipt_id,lease,event,JSON.stringify(values)]);
  for(const values of [[],proof.slice(0,1),[proof[0],proof[0]],[proof[0],{...proof[1],signatureId:'foreign'}],[proof[0],{...proof[1],signedAt:null}],[proof[0],{...proof[1],signedAt:event+1}],[proof[0],{...proof[1],statusCode:'awaiting_signature'}]]) await assert.rejects(reconcile(values),/provider signer/);
  await assert.rejects(reconcile(proof,randomUUID()),/receipt lease/);
  assert.equal((await client.query('select count(*)::int n from public.esign_completion_reconciliation_audits')).rows[0].n,0);
  await reconcile(proof);
  const rows=(await client.query('select role_name,extract(epoch from signed_at)::bigint::text signed from public.esign_request_signers where request_id=$1 order by signer_order',[id])).rows;
  assert.deepEqual(rows,[{role_name:'Seller',signed:String(seller)},{role_name:'Buyer',signed:String(buyer)}]);
  const audit=(await client.query('select * from public.esign_completion_reconciliation_audits where request_id=$1',[id])).rows[0];
  assert.equal(audit.signer_snapshot.length,2);
  assert.ok(audit.signer_snapshot.every(s => new Date(s.signed_at).getTime()/1000===seller));
  assert.equal(new Date(audit.request_snapshot.completed_at).getTime()/1000,seller);
  await reconcile(proof);
  assert.equal((await client.query('select count(*)::int n from public.esign_completion_reconciliation_audits where request_id=$1',[id])).rows[0].n,1);
  assert.deepEqual((await client.query('select signer_snapshot from public.esign_completion_reconciliation_audits where request_id=$1',[id])).rows[0].signer_snapshot,audit.signer_snapshot);
  console.log('Final signer SQL: exact persisted IDs, missing/duplicate/foreign/incomplete/future rejection, authoritative timestamps, pre-repair audit, retry idempotence, rollback/reapply passed');
}
