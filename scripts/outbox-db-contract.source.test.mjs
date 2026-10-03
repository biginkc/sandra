import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readManifest, relativePath } from './inbox-ci/inbox-migrations.mjs';

const inboxFiles = new Set(readManifest().map(relativePath));
const sources = {
  C00: ['supabase/migrations/054_memberships_and_rls_rewrite.sql', 'create policy messages_org_insert on public.messages for insert to authenticated'],
  C01: ['src/app/(dashboard)/messages/actions.ts', '.limit(QUEUE_PAGE_SIZE + 1)'],
  C02: ['src/app/(dashboard)/messages/queued-cursor.ts', '`scheduled_for.gt."${cursor.scheduledFor}",`'],
  C03: ['src/app/(dashboard)/messages/actions.ts', 'query = query.is("scheduled_for", null).gt("id", filter.id);'],
  C04: ['supabase/migrations/087_outbound_sms_metrics.sql', 'create or replace function public.outbound_sms_metrics('],
  C05: ['src/app/(dashboard)/messages/actions.ts', '.update({ body: trimmed })'],
  C06: ['src/app/(dashboard)/messages/actions.ts', '.select("id, property_id")'],
  C07: ['src/lib/messaging/send.ts', '// Flip queued → pending atomically to prevent a concurrent tick from'],
  C08: ['src/lib/messaging/send.ts', '// Freeze this payload once; retries persist the same accepted provider result.'],
  C08b: ['src/lib/messaging/send.ts', 'scheduled_for: pauseForRetry.paused ? null : retry.retryAt,'],
  C09: ['src/lib/messaging/send.ts', 'export async function releaseQueuedMessage('],
  D01: ['supabase/migrations/054_memberships_and_rls_rewrite.sql', 'create policy messages_org_select on public.messages'],
  D02: ['supabase/migrations/054_memberships_and_rls_rewrite.sql', 'create policy messages_org_update on public.messages'],
  D03: ['supabase/migrations/054_memberships_and_rls_rewrite.sql', 'create policy memberships_self_select on public.memberships'],
  D04: [relativePath(readManifest().find(entry => entry.name === 'inbox_control_foundation')), 'CREATE FUNCTION public.inbox_guard_inbound_revision()'],
  D05: [relativePath(readManifest().find(entry => entry.name === 'inbox_control_foundation')), 'CREATE TABLE public.inbox_inbound_heads'],
};

test('every post-privilege source hash matches the checked-out migration', () => {
  const pins = JSON.parse(readFileSync('scripts/outbox-db-contract/expected/privileges.post.json', 'utf8'));
  assert.equal(Object.keys(pins.source_sha256).length, 3);
  for (const [file, expected] of Object.entries(pins.source_sha256)) {
    assert(inboxFiles.has(file), `unlisted Inbox source: ${file}`);
    assert(existsSync(file), `post-privilege source missing: ${file}`);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), expected, `stale source hash: ${file}`);
  }
});

test('every executable contract has one anchored application or schema source', () => {
  const pins = JSON.parse(readFileSync('scripts/outbox-db-contract/expected/privileges.post.json', 'utf8'));
  for (const [id, [file, snippet]] of Object.entries(sources)) {
    assert(existsSync(file), `${id} reviewed source missing from checkout: ${file}`);
    const source = readFileSync(file, 'utf8');
    if (inboxFiles.has(file)) assert.equal(createHash('sha256').update(source).digest('hex'), pins.source_sha256[file], `${id} migration source changed`);
    assert.equal(source.split(snippet).length - 1, 1, `${id} source drift: ${file}`);
  }
});
