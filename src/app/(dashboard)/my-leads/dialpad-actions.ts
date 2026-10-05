'use server';
import { createDialpadDialer, startDialpadApiCall, type DialpadApiDialOutcome } from '@/lib/dialpad-cti/api-dial';
import {
  cancelDialpadCall,
  createSupabaseDialpadDispatchDb,
  ensureDialpadBinding,
  getDialpadCallStatus,
  type DialpadActor,
  type DialpadDispatchDb,
} from '@/lib/dialpad-cti/dispatch';
import { getMyLeadsFlag } from '@/lib/my-leads/flags';
import { myLeadsViewer } from '@/lib/my-leads/queries';
import { schemaReady } from '@/lib/my-leads/schema-ready';
import { createAdminClient } from '@/lib/supabase/admin';

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

export type DialLeadInput = { propertyId: unknown; contactId: unknown; phoneSlot?: unknown; idempotencyKey: unknown; confirmRedialOf?: unknown };

/**
 * Click-to-dial through the Dialpad API (2.7). Kill switch and readiness: the `click_to_dial`
 * flag (a missing row or table reads OFF) and `schemaReady('api_dial')` must both hold, otherwise
 * `not_configured` sends the client down the Sandra-softphone branch. Only the outcome crosses to
 * the browser; the dial payload and the key never do.
 */
export async function dialLeadAction(input: DialLeadInput): Promise<DialpadApiDialOutcome> {
  const s = await session();
  if (!s) return unauthenticated;
  const [enabled, ready] = await Promise.all([getMyLeadsFlag(s.actor.orgId, 'click_to_dial'), schemaReady('api_dial')]);
  if (!enabled || !ready) return { ok: false, code: 'not_configured', message: 'Dialpad click-to-dial is not enabled for this organization.' };
  const outcome = await startDialpadApiCall(s.db, createDialpadDialer(process.env), s.actor, {
    propertyId: input.propertyId,
    contactId: input.contactId,
    phoneSlot: input.phoneSlot ?? null,
    idempotencyKey: input.idempotencyKey,
    confirmRedialOf: input.confirmRedialOf,
  }, { env: process.env });
  return outcome;
}

/** Binding without the iframe: verifies the rep against the Dialpad directory by their confirmed email. */
export async function ensureDialpadBindingAction() {
  const s = await session();
  if (!s) return unauthenticated;
  return ensureDialpadBinding(s.db, s.actor, { email: s.email, emailConfirmed: s.emailConfirmed }, { env: process.env });
}

export async function getDialpadCallStatusAction(intentId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return getDialpadCallStatus(s.db, s.actor, intentId);
}

export async function cancelDialpadCallAction(intentId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  // An intent whose dial was already released may have rung; cancelling it would make `cancelled` a false
  // proof of non-dispatch for the client key rules. Only unreleased intents can be cancelled here.
  const status = await getDialpadCallStatus(s.db, s.actor, intentId);
  if (!status.ok) return status;
  if (status.status.dispatchAuthorizedAt) {
    return { ok: false as const, code: 'denied' as const, message: 'This call was already sent to Dialpad and cannot be cancelled here.' };
  }
  return cancelDialpadCall(s.db, s.actor, intentId);
}
