import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Use the actual production RPCs in the existing disposable database harness.
function functionDefinition(path, name) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = source.indexOf('$$;', source.indexOf('as $$', start));
  assert.ok(end > start, `unterminated ${name}`);
  return source.slice(start, end + 3);
}

export async function rehearseWebsiteRemoval(client, ids, templateId, metadata, requestId) {
  await client.query(functionDefinition('supabase/migrations/20260902120100_esign_atomic_disconnect_state.sql', 'esign_require_template_management_capability'));
  await client.query(functionDefinition('supabase/migrations/20260830080000_esign_template_upload_reservations.sql', 'soft_delete_esign_template'));
  const remove = async (confirmed, actor = ids.owner, org = ids.org) => client.query(
    'select * from public.soft_delete_esign_template($1,$2,$3,$4)', [org, templateId, confirmed, actor],
  );
  // Reproduce the real website lifecycle CHECK failure before the repair.
  await assert.rejects(remove(true), error => error.code === '23514' && error.constraint === 'esign_templates_provider_metadata_check');
  const migration = readFileSync('supabase/migrations/20260912220000_esign_website_soft_delete.sql', 'utf8');
  await client.query('begin');
  await client.query(migration.replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  await client.query('rollback');
  await assert.rejects(remove(true), error => error.code === '23514');
  await client.query(migration);
  await client.query(migration);

  // A signed artifact relationship is deliberately restrictive, matching the
  // production rule that local template removal must never remove requests.
  await client.query(`create table if not exists public.removal_artifact_fixture (
    id uuid primary key default gen_random_uuid(),
    source_request_id uuid not null references public.esign_requests(id) on delete restrict,
    storage_path text not null
  )`);
  await client.query('insert into public.removal_artifact_fixture(source_request_id,storage_path) values($1,$2)', [requestId, 'esign/signed/internal-fixture.pdf']);
  const snapshot = async () => (await client.query(`select
    (select jsonb_agg(to_jsonb(r) order by r.id) from public.esign_requests r where r.template_id=$1) requests,
    (select jsonb_agg(to_jsonb(s) order by s.request_id,s.signer_order) from public.esign_request_signers s join public.esign_requests r on r.id=s.request_id where r.template_id=$1) signers,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.removal_artifact_fixture a join public.esign_requests r on r.id=a.source_request_id where r.template_id=$1) artifacts`, [templateId])).rows[0];
  const before = await snapshot();
  const confirmation = (await remove(false)).rows[0];
  assert.equal(confirmation.outcome, 'needs_confirmation');
  assert.ok(Number(confirmation.recent_send_count) > 0);
  await assert.rejects(remove(true, ids.member), /owner/i);
  const removed = (await remove(true)).rows[0];
  assert.equal(removed.outcome, 'deleted');
  const row = (await client.query('select * from public.esign_templates where id=$1', [templateId])).rows[0];
  assert.equal(row.lifecycle_state, 'deleted');
  assert.equal(row.deleted_by, ids.owner);
  assert.ok(row.deleted_at);
  assert.equal(row.sign_template_id, metadata.providerTemplateId);
  assert.deepEqual(row.provider_metadata, metadata);
  assert.deepEqual(await snapshot(), before, 'removal changed requests, signer snapshots or signed artifact links');
  assert.equal((await client.query('select public.esign_template_is_available($1,$2) available', [templateId, ids.org])).rows[0].available, false);
  assert.equal((await remove(true)).rows[0].outcome, 'already_deleted');
  const restored = await client.query('select * from public.register_dropbox_website_esign_template($1,$2,$3,$4,$5,$6,$7::jsonb)', [ids.org,ids.owner,metadata.providerTemplateId,'Restored residential fixture','purchase_agreement','provider-account-1',JSON.stringify(metadata)]);
  assert.equal(restored.rows[0].outcome, 'restored');
  assert.equal(restored.rows[0].template_id, templateId);
  const final = (await client.query('select lifecycle_state,deleted_at,deleted_by from public.esign_templates where id=$1',[templateId])).rows[0];
  assert.deepEqual(final, { lifecycle_state: 'finalized', deleted_at: null, deleted_by: null });
  assert.equal((await client.query('select public.esign_template_is_available($1,$2) available', [templateId, ids.org])).rows[0].available, true);
  assert.deepEqual(await snapshot(), before, 'restoration changed history');
  console.log('Website template removal: reproduced CHECK failure; confirmation, owner guard, retained history/artifact links, idempotence, restore, rollback and reapply passed');
}
