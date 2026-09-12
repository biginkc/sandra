import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

export async function rehearseFinalSignedPdf(client, ids) {
  const foundation = readFileSync('supabase/migrations/20260829194500_esign_foundation.sql', 'utf8');
  const migration = readFileSync('supabase/migrations/20260912233000_esign_final_signed_pdf.sql', 'utf8');
  const fn = (name) => { const start = foundation.indexOf(`create or replace function public.${name}(`); return foundation.slice(start, foundation.indexOf('\n$$;', start) + 4); };
  const table = (name) => { const start = foundation.indexOf(`create table public.${name} (`); return foundation.slice(start, foundation.indexOf('\n);', start) + 3); };
  await client.query(`reset role;
    alter table public.properties add unique(id,org_id);
    alter table public.esign_requests add unique(id,org_id);
    alter table public.webhook_consumers add unique(id,org_id);
    alter table public.esign_requests add column provider_event_at timestamptz;
    alter table public.esign_request_signers add column if not exists status text;
    alter table public.esign_request_signers add column if not exists signed_at timestamptz;
    create schema storage;
    create table storage.objects(bucket_id text, name text, metadata jsonb, unique(bucket_id,name));`);
  await client.query(fn('esign_safe_event_data_is_valid'));
  await client.query(table('lead_files'));
  await client.query(table('esign_webhook_receipts'));
  await client.query(fn('claim_verified_esign_webhook_receipt'));
  await client.query(fn('link_esign_signed_artifact'));
  const original = (await client.query("select pg_get_functiondef('public.link_esign_signed_artifact(uuid,uuid,uuid,uuid,uuid,text,text,text,bigint,text,jsonb)'::regprocedure) as d")).rows[0].d;
  await client.query('begin');
  await client.query(migration.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  await client.query('rollback');
  assert.equal((await client.query("select pg_get_functiondef('public.link_esign_signed_artifact(uuid,uuid,uuid,uuid,uuid,text,text,text,bigint,text,jsonb)'::regprocedure) as d")).rows[0].d, original);
  assert.equal((await client.query("select to_regclass('public.esign_signed_artifact_archives') as t")).rows[0].t, null);
  await client.query(migration);
  await client.query(migration);
  await client.query("select set_config('request.jwt.claim.role','service_role',false)");
  await client.query("update public.webhook_consumers set enabled=true,revoked_at=null where id=$1", [ids.consumer]);
  const template = (await client.query('select id,name from public.esign_templates where org_id=$1 limit 1',[ids.org])).rows[0];
  const time = new Date('2026-09-12T23:00:00Z');
  const sellerSignedAt = new Date('2026-09-12T22:30:00Z');
  const buyerSignedAt = new Date('2026-09-12T22:45:00Z');
  const hash = (s) => createHash('sha256').update(s).digest('hex');
  const request = async () => {
    const id=randomUUID();
    await client.query(`insert into public.esign_requests(id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,status,delivery_state,send_intent_id,payload_hash,sign_request_id) values($1,$2,$3,$4,'[]','{}','signed','sent',$5,$6,$7)`,[id,ids.org,ids.property,template.id,randomUUID(),hash(id),id]);
    await client.query("insert into public.esign_request_signers(org_id,request_id,role_name,signer_order,signer_name,signer_email,status,signed_at) values($1,$2,'Seller',0,'Seller','seller@example.com','signed',$3),($1,$2,'Buyer',1,'Buyer','buyer@example.com','signed',$4)",[ids.org,id,sellerSignedAt,buyerSignedAt]);
    return {id,old:`${ids.org}/${ids.property}/esign/${id}/signed.pdf`,final:`${ids.org}/${ids.property}/esign/${id}/signed-final.pdf`};
  };
  const claim = async (r, event='signature_request_all_signed', lease=randomUUID(),channel='account') => {
    const fingerprint=hash(r.id+event+channel);
    return (await client.query('select * from public.claim_verified_esign_webhook_receipt($1,$2,$3,$4,$5,$6,$7,null,$8,$9,now(),$10)',[ids.org,ids.consumer,hash('event'),fingerprint,hash('payload'),event,r.id,JSON.stringify({event_type:event,event_time:String(time.getTime()/1000),sign_request_id:r.id,related_signature_id:null,reported_for_app_id:null}),time,lease])).rows[0];
  };
  const link = async(r,c, overrides={},connection=client) => (await connection.query('select * from public.link_esign_signed_artifact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[overrides.org??ids.org,r.id,c.receipt_id,overrides.lease??c.lease_id,randomUUID(),'lead-files',overrides.path??r.final,'application/pdf',200,'esign_signed_pdf_ready',JSON.stringify({template_title:template.name})])).rows[0];
  const finish = async(c,status='processed') => client.query("update public.esign_webhook_receipts set processing_status=$2,processed_at=now(),processing_lease_id=null where id=$1",[c.receipt_id,status]);
  const object = async(path,size=200)=>client.query("insert into storage.objects values('lead-files',$1,$2)",[path,JSON.stringify({size,mimetype:'application/pdf'})]);
  for (const oldMetadata of [true,false]) {
    const r=await request(); const file=randomUUID();
    await object(r.old,100);
    await client.query('update public.esign_requests set signed_pdf_path=$2 where id=$1',[r.id,r.old]);
    if(oldMetadata) await client.query("insert into public.lead_files(id,org_id,property_id,source_request_id,file_name,size_bytes,storage_path) values($1,$2,$3,$4,$5,100,$6)",[file,ids.org,ids.property,r.id,`signed-contract-${r.id.slice(0,8)}.pdf`,r.old]);
    let c=await claim(r); await finish(c); c=await claim(r);
    assert.equal(c.outcome,'claimed');
    await client.query('update public.esign_requests set completed_at=$2 where id=$1',[r.id,new Date('2026-09-12T22:00:00Z')]);
    assert.equal((await claim(r)).outcome,'in_progress');
    await assert.rejects(link(r,c),/storage object not found/);
    assert.equal((await client.query('select signed_pdf_path from public.esign_requests where id=$1',[r.id])).rows[0].signed_pdf_path,r.old);
    await object(r.final);
    await assert.rejects(link(r,c,{lease:randomUUID()}),/receipt lease not found/);
    await assert.rejects(link(r,c,{org:ids.otherOrg}),/request not found/);
    await assert.rejects(link(r,c,{path:r.old}),/metadata is invalid/);
    const linked=await link(r,c); assert.equal(linked.outcome,'applied');
    if(oldMetadata) assert.equal(linked.lead_file_id,file);
    assert.equal((await link(r,c)).outcome,'already_linked');
    assert.equal((await client.query('select completed_at from public.esign_requests where id=$1',[r.id])).rows[0].completed_at.toISOString(),buyerSignedAt.toISOString());
    assert.equal((await client.query('select count(*)::int n from public.esign_signed_artifact_archives where request_id=$1',[r.id])).rows[0].n,1);
    assert.equal((await client.query('select size_bytes,storage_path from public.lead_files where source_request_id=$1',[r.id])).rows[0].storage_path,r.final);
    assert.equal((await client.query('select metadata from storage.objects where name=$1',[r.old])).rows[0].metadata.size,100);
    await finish(c); assert.equal((await claim(r)).outcome,'already_processed');
  }
  const fresh=await request(); const c=await claim(fresh); await object(fresh.final);
  assert.equal((await link(fresh,c)).outcome,'applied');
  assert.equal((await client.query('select count(*)::int n from public.esign_signed_artifact_archives where request_id=$1',[fresh.id])).rows[0].n,0);
  const incomplete=await request(); const download=await claim(incomplete,'signature_request_downloadable');
  await object(incomplete.final);
  await assert.rejects(link(incomplete,download),/all-signed webhook receipt lease/);
  await client.query("update public.esign_requests set status='awaiting' where id=$1",[incomplete.id]);
  await assert.rejects(client.query('select * from public.apply_esign_webhook_status_decision($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ids.org,incomplete.id,download.receipt_id,download.lease_id,'awaiting','signed',time,'esign_signed',JSON.stringify({template_title:template.name})]),/matching webhook receipt lease not found/);
  await finish(download); assert.equal((await claim(incomplete,'signature_request_downloadable')).outcome,'already_processed');
  await assert.rejects(client.query('select * from public.reconcile_esign_completed_signed_artifact($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ids.org,fresh.id,randomUUID(),'lead-files',fresh.old,'application/pdf',200,'esign_signed_pdf_ready','{}']),/requires verified all-signed/);
  for (const state of ['ignored', 'processed']) {
    const r=await request(); let receipt=await claim(r); await finish(receipt,state);
    await client.query('update public.esign_requests set signed_pdf_path=$2 where id=$1',[r.id,'wrong/request/signed.pdf']);
    assert.equal((await claim(r)).outcome,'already_processed');
    await client.query("update public.esign_requests set signed_pdf_path=null,status='declined' where id=$1",[r.id]);
    assert.equal((await claim(r)).outcome,'already_processed');
    await client.query("update public.esign_requests set status='signed' where id=$1",[r.id]);
    assert.equal((await claim(r)).outcome,'claimed');
  }
  // A late activity-event conflict must roll back the archive and canonical pointer together.
  const rollback=await request(); await object(rollback.old,100); await object(rollback.final);
  await client.query('update public.esign_requests set signed_pdf_path=$2 where id=$1',[rollback.id,rollback.old]);
  const rollbackReceipt=await claim(rollback);
  await client.query("insert into public.lead_events(org_id,property_id,actor_type,event_type,payload,source_type,source_id) values($1,$2,'system','esign_signed_pdf_ready','{}','esign_signed_pdf_request',$3)",[ids.org,ids.property,rollback.id]);
  await assert.rejects(link(rollback,rollbackReceipt),/conflicting signed PDF activity event/);
  assert.equal((await client.query('select signed_pdf_path from public.esign_requests where id=$1',[rollback.id])).rows[0].signed_pdf_path,rollback.old);
  assert.equal((await client.query('select count(*)::int n from public.esign_signed_artifact_archives where request_id=$1',[rollback.id])).rows[0].n,0);
  assert.equal((await client.query('select count(*)::int n from public.lead_files where source_request_id=$1',[rollback.id])).rows[0].n,0);
  await client.query("delete from public.lead_events where source_type='esign_signed_pdf_request' and source_id=$1",[rollback.id]);
  assert.equal((await link(rollback,rollbackReceipt)).outcome,'applied');
  const unfinished=await request(); const unfinishedReceipt=await claim(unfinished); await object(unfinished.final);
  await client.query("update public.esign_request_signers set status='awaiting' where request_id=$1 and role_name='Buyer'",[unfinished.id]);
  await assert.rejects(link(unfinished,unfinishedReceipt),/completed signer set required/);
  await client.query("update public.esign_request_signers set status='signed',signed_at=null where request_id=$1 and role_name='Buyer'",[unfinished.id]);
  await assert.rejects(link(unfinished,unfinishedReceipt),/completed signer set required/);
  await client.query('delete from public.esign_request_signers where request_id=$1',[unfinished.id]);
  await assert.rejects(link(unfinished,unfinishedReceipt),/completed signer set required/);
  // Account and app callbacks can both observe the legacy pointer before either links.
  const race=await request(); await object(race.old,100); await object(race.final);
  await client.query('update public.esign_requests set signed_pdf_path=$2 where id=$1',[race.id,race.old]);
  const a=await claim(race), b=await claim(race,'signature_request_all_signed',randomUUID(),'app');
  const concurrent=new pg.Client({...client.connectionParameters});
  await concurrent.connect();
  try {
    await concurrent.query("select set_config('request.jwt.claim.role','service_role',false)");
    const outcomes=await Promise.all([link(race,a),link(race,b,{},concurrent)]);
    assert.deepEqual(outcomes.map(x=>x.outcome).sort(),['already_linked','applied']);
    assert.equal((await client.query('select count(*)::int n from public.esign_signed_artifact_archives where request_id=$1',[race.id])).rows[0].n,1);
  } finally { await concurrent.end(); }
  console.log('Final PDF SQL: rollback/reapply, lease/org/event guards, partial and missing metadata preservation, immutable object, retry convergence and final duplicate passed');
}
