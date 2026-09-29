import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
  D04: ['supabase/migrations/20260929000000_inbox_control_foundation.sql', 'CREATE FUNCTION public.inbox_guard_inbound_revision()'],
  D05: ['supabase/migrations/20260929000000_inbox_control_foundation.sql', 'CREATE TABLE public.inbox_inbound_heads'],
};

test('every executable contract has one anchored application or schema source', () => {
  for (const [id, [file, snippet]] of Object.entries(sources)) {
    const source = file.startsWith('supabase/migrations/20260929')
      ? execFileSync('git', ['show', `e767bec7:${file}`], { encoding: 'utf8' })
      : readFileSync(file, 'utf8');
    assert.equal(source.split(snippet).length - 1, 1, `${id} source drift: ${file}`);
  }
});
