'use server';
import { createAdminClient } from '@/lib/supabase/admin';
import { myLeadsViewer } from '@/lib/my-leads/queries';
import {
  closeDialpadRecordingCapture,
  createSupabaseDialpadRecordingDb,
  mintDialpadRecordingGrant,
  mintDialpadRecordingNextEpoch,
  getDialpadRecordingBrowserStatus,
  openDialpadRecordingCapture,
  type DialpadRecordingActor,
  type DialpadRecordingDb,
} from '@/lib/dialpad-recording/capture';

const SIGN_IN_MESSAGE = 'Sign in with an active organization to record calls.';

// Org and rep are derived here from the authenticated session; no action
// accepts either from the browser. Worker-side operations (consume, chunk,
// claim, register) are deliberately not exposed as actions.
async function session(): Promise<{ actor: DialpadRecordingActor; db: DialpadRecordingDb } | null> {
  try {
    const viewer = await myLeadsViewer();
    const { data } = await viewer.client.auth.getUser();
    if (!data.user || data.user.id !== viewer.userId) return null;
    return {
      actor: { orgId: viewer.orgId, userId: viewer.userId },
      db: createSupabaseDialpadRecordingDb(createAdminClient()),
    };
  } catch {
    return null;
  }
}

const unauthenticated = { ok: false as const, code: 'denied' as const, message: SIGN_IN_MESSAGE };

export async function openDialpadRecordingCaptureAction(intentId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return openDialpadRecordingCapture(s.db, s.actor, intentId);
}

export async function closeDialpadRecordingCaptureAction(captureId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return closeDialpadRecordingCapture(s.db, s.actor, captureId);
}

export async function mintDialpadRecordingGrantAction(input: { captureId: unknown; epoch: unknown }) {
  const s = await session();
  if (!s) return unauthenticated;
  return mintDialpadRecordingGrant(s.db, s.actor, { captureId: input?.captureId, epoch: input?.epoch });
}

export async function mintDialpadRecordingNextEpochAction(input: { captureId: unknown; expectedConsumedEpoch: unknown }) {
  const s = await session();
  if (!s) return unauthenticated;
  return mintDialpadRecordingNextEpoch(s.db, s.actor, { captureId: input?.captureId, expectedConsumedEpoch: input?.expectedConsumedEpoch });
}

export async function getDialpadRecordingBrowserStatusAction(captureId: unknown) {
  const s = await session();
  if (!s) return unauthenticated;
  return getDialpadRecordingBrowserStatus(s.db, s.actor, captureId);
}
