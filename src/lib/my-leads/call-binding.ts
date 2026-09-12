import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { callTokenDigest } from './call-evidence';
import type { Json } from '@/lib/supabase/types';

type BindingClient = {
  rpc(name: 'fn_bind_acquisition_call_context', args: {
    p_org_id: string; p_property_id: string; p_actor_user_id: string; p_token_hash: string;
  }): Promise<{ data: Json | null; error: { message?: string } | null }>;
};
export type AcquisitionCallBinding = { tracked: false } | { tracked: true; assignmentEpisodeId: string | null };

/** The caller must first verify the signed start intent and recheck lead eligibility. */
export async function bindAcquisitionCallContext(input: {
  orgId: string; propertyId: string; actorUserId: string; callToken: string;
}): Promise<AcquisitionCallBinding> {
  const { data, error } = await (createAdminClient() as unknown as BindingClient).rpc('fn_bind_acquisition_call_context', {
    p_org_id: input.orgId, p_property_id: input.propertyId, p_actor_user_id: input.actorUserId,
    p_token_hash: callTokenDigest(input.callToken),
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Call context could not be recorded.');
  if (data.tracked === false) return { tracked: false };
  if (data.tracked !== true || data.orgId !== input.orgId || data.propertyId !== input.propertyId || data.actorUserId !== input.actorUserId
    || !(data.assignmentEpisodeId === null || typeof data.assignmentEpisodeId === 'string')) throw new Error('Invalid call context response.');
  return { tracked: true, assignmentEpisodeId: data.assignmentEpisodeId };
}
