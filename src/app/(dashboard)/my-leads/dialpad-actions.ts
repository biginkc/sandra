'use server';
import { createAdminClient } from '@/lib/supabase/admin';
import { myLeadsViewer } from '@/lib/my-leads/queries';
import {
  cancelDialpadCall,
  createSupabaseDialpadDispatchDb,
  getDialpadCallStatus,
  listDialpadCallTargets,
  listRecentDialpadCalls,
  startDialpadCall,
  verifyDialpadBinding,
  type DialpadActor,
  type DialpadDispatchDb,
} from '@/lib/dialpad-cti/dispatch';

const SIGN_IN_MESSAGE = 'Sign in with an active organization to use Dialpad.';

// Org and rep are derived here from the authenticated session; no action
// accepts either from the browser.
async function session(): Promise<{ actor: DialpadActor; db: DialpadDispatchDb; email: string | null; emailConfirmed: boolean } | null> {
  try {
    const viewer = await myLeadsViewer();
    const { data } = await viewer.client.auth.getUser();
    if (!data.user || data.user.id !== viewer.userId) return null;
    return {
      actor: { orgId: viewer.orgId, userId: viewer.userId },
      db: createSupabaseDialpadDispatchDb(createAdminClient()),
      email: data.user.email ?? null,
      emailConfirmed: typeof data.user.email_confirmed_at === 'string' && data.user.email_confirmed_at.length > 0,
    };
  } catch {
    return null;
  }
}

const unauthenticated = { ok: false as const, code: 'not_configured' as const, message: SIGN_IN_MESSAGE };

export async function verifyDialpadBindingAction(claimedUserId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return verifyDialpadBinding(s.db, s.actor, { email: s.email, emailConfirmed: s.emailConfirmed }, claimedUserId, { env: process.env });
}

export async function listDialpadCallTargetsAction(input: { propertyId: unknown; contactId: unknown }) {
  const s = await session();
  if (!s) return unauthenticated;
  return listDialpadCallTargets(s.db, s.actor, { propertyId: input?.propertyId, contactId: input?.contactId });
}

export async function startDialpadCallAction(input: { propertyId: unknown; contactId: unknown; phoneSlot: unknown; grantId: unknown; idempotencyKey: unknown }) {
  const s = await session();
  if (!s) return unauthenticated;
  return startDialpadCall(s.db, s.actor, {
    propertyId: input?.propertyId,
    contactId: input?.contactId,
    phoneSlot: input?.phoneSlot,
    grantId: input?.grantId,
    idempotencyKey: input?.idempotencyKey,
  });
}

export async function getDialpadCallStatusAction(intentId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return getDialpadCallStatus(s.db, s.actor, intentId);
}

export async function cancelDialpadCallAction(intentId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return cancelDialpadCall(s.db, s.actor, intentId);
}

export async function listRecentDialpadCallsAction() {
  const s = await session();
  if (!s) return unauthenticated;
  return listRecentDialpadCalls(s.db, s.actor);
}
