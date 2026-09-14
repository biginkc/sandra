'use server';

import { getAcquisitionRoster } from '@/lib/my-leads/queries';
import { createDialpadVoiceAdminClient } from './database';

/** Historical access uses the original actor, not the current number grant.
 * Only persisted provider processing may advance the state; polling has no
 * provider side effects and cannot retry a call or manufacture connected time.
 */
export async function getMyDialpadCallStatus(input: { intentId: string }) {
  if (!input || typeof input.intentId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.intentId)) {
    return { ok: false, error: 'invalid_input' } as const;
  }
  try {
    const { viewer, roster } = await getAcquisitionRoster();
    if (!roster.members.some(member => member.id === viewer.userId && member.active)) {
      return { ok: false, error: 'forbidden' } as const;
    }
    const db = createDialpadVoiceAdminClient();
    const result = await db.from('dialpad_voice_intents')
      .select('id,org_id,actor_user_id,status,updated_at')
      .eq('id', input.intentId).eq('org_id', viewer.orgId).eq('actor_user_id', viewer.userId).maybeSingle();
    const intent = result.data;
    if (result.error || !intent || intent.id !== input.intentId
      || intent.org_id !== viewer.orgId || intent.actor_user_id !== viewer.userId) {
      return { ok: false, error: 'call_unavailable' } as const;
    }
    return { ok: true, intentId: intent.id, status: intent.status, updatedAt: intent.updated_at } as const;
  } catch {
    return { ok: false, error: 'call_unavailable' } as const;
  }
}
