'use server';

import { getAcquisitionRoster, myLeadsViewer } from '@/lib/my-leads/queries';
import { createDialpadVoiceAdminClient } from './database';
import type { DialpadConfigurationDatabase } from './configuration-database';
import { DialpadVoiceClient } from './client';
import { verifyDialpadInventory } from './verified-inventory';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const providerId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
type Caller = { identity_type: string; provider_identity_id: string; number_e164: string };
type Input = { memberId: string; providerUserId: string };
type SaveInput = Input & { connectionVersion: number; expectedBindingRevision: number; requestId: string; selectedCallers: Caller[] };
const failure = (error: string) => ({ ok: false as const, error });

async function verifiedContext(input: Input) {
  if (!input || !uuid(input.memberId) || !providerId(input.providerUserId)) throw Error('invalid_input');
  const { viewer, roster } = await getAcquisitionRoster();
  if (!viewer.isOwner || !roster.isOwner || !roster.settings.enabled
    || !roster.members.some(member => member.id === input.memberId && member.active && member.acquisitionsEnabled)) throw Error('forbidden');
  const db = createDialpadVoiceAdminClient<DialpadConfigurationDatabase>();
  const connection = await db.from('dialpad_org_connections')
    .select('id,org_id,provider_company_id,enabled,config_version,verified_at,credential_reference').eq('org_id', viewer.orgId).maybeSingle();
  const c = connection.data;
  if (connection.error || !c || c.org_id !== viewer.orgId || !c.enabled || !c.verified_at
    || !uuid(c.id) || !providerId(c.provider_company_id) || !Number.isSafeInteger(c.config_version) || c.config_version < 1) throw Error('connection_unavailable');
  // A configurable connection must never be usable to exfiltrate arbitrary
  // server environment secrets through a Dialpad request.
  if (!/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(c.credential_reference)) throw Error('connection_unavailable');
  const key = process.env[c.credential_reference.slice(4)];
  if (!key) throw Error('connection_unavailable');
  const member = await db.auth.admin.getUserById(input.memberId);
  if (member.error || member.data.user?.id !== input.memberId || !member.data.user.email) throw Error('member_unavailable');
  const result = await verifyDialpadInventory(new DialpadVoiceClient(key), {
    orgId: viewer.orgId, providerCompanyId: c.provider_company_id,
    providerUserId: input.providerUserId, memberEmail: member.data.user.email,
  });
  const callers: Caller[] = result.inventory.callers.map(caller => ({
    identity_type: caller.identity.type, provider_identity_id: caller.identity.id, number_e164: caller.number,
  }));
  return { db, viewer, connection: c, result, callers };
}

/** Owner-only discovery. Browser-supplied provider identity is verified against
 * the selected CRM member's server-read email and the organization's company. */
export async function loadDialpadMemberCallerOptions(input: Input) {
  try {
    const context = await verifiedContext(input);
    const binding = await context.db.from('dialpad_member_bindings').select('revision')
      .eq('org_id', context.viewer.orgId).eq('member_user_id', input.memberId).is('revoked_at', null).maybeSingle();
    if (binding.error) return failure('configuration_unavailable');
    return { ok: true as const, connectionVersion: context.connection.config_version,
      bindingRevision: binding.data?.revision ?? 0, callers: context.callers };
  } catch { return failure('configuration_unavailable'); }
}

/** All persisted inventory is freshly fetched server-side. Input only selects
 * exact identities; the transactional RPC rechecks eligibility and revisions. */
export async function saveDialpadMemberCallerAssignment(input: SaveInput) {
  if (!input || !uuid(input.memberId) || !providerId(input.providerUserId) || !uuid(input.requestId) || !Number.isSafeInteger(input.connectionVersion) || input.connectionVersion < 1
    || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 0
    || !Array.isArray(input.selectedCallers) || input.selectedCallers.length < 1 || input.selectedCallers.length > 100) return failure('invalid_input');
  try {
    const viewer = await myLeadsViewer();
    if (!viewer.isOwner) return failure('configuration_save_unconfirmed');
    const replayDb = createDialpadVoiceAdminClient<DialpadConfigurationDatabase>();
    const replay = await replayDb.rpc('fn_replay_dialpad_member_configuration', {
      p_org_id: viewer.orgId, p_owner_user_id: viewer.userId, p_member_user_id: input.memberId,
      p_provider_user_id: input.providerUserId, p_expected_connection_version: input.connectionVersion,
      p_expected_binding_revision: input.expectedBindingRevision, p_selected_callers: input.selectedCallers,
      p_request_id: input.requestId,
    });
    if (replay.error) return failure('configuration_save_unconfirmed');
    if (replay.data !== null) return savedResult(replay.data);
    const context = await verifiedContext(input);
    if (context.connection.config_version !== input.connectionVersion) return failure('stale_configuration');
    const selected: Caller[] = [];
    for (const requested of input.selectedCallers) {
      if (!requested || typeof requested !== 'object' || Object.keys(requested).length !== 3) return failure('invalid_selection');
      const match = context.callers.find(caller => caller.identity_type === requested.identity_type
        && caller.provider_identity_id === requested.provider_identity_id && caller.number_e164 === requested.number_e164);
      if (!match) return failure('invalid_selection');
      if (!selected.includes(match)) selected.push(match);
    }
    const saved = await context.db.rpc('fn_configure_dialpad_member', {
      p_org_id: context.viewer.orgId, p_owner_user_id: context.viewer.userId, p_member_user_id: input.memberId,
      p_connection_id: context.connection.id, p_expected_connection_version: input.connectionVersion,
      p_provider_company_id: context.connection.provider_company_id, p_provider_user_id: input.providerUserId,
      p_verified_at: context.result.provenance.verifiedAt, p_callers: context.callers, p_selected_callers: selected,
      p_expected_binding_revision: input.expectedBindingRevision, p_request_id: input.requestId,
    });
    if (saved.error) return failure('configuration_save_unconfirmed');
    return savedResult(saved.data);
  } catch { return failure('configuration_save_unconfirmed'); }
}

function savedResult(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('bindingId' in data) || !uuid(data.bindingId)
    || !('bindingRevision' in data) || typeof data.bindingRevision !== 'number' || !Number.isSafeInteger(data.bindingRevision) || data.bindingRevision < 1) return failure('configuration_save_unconfirmed');
  return { ok: true as const, bindingId: data.bindingId, bindingRevision: data.bindingRevision };
}
