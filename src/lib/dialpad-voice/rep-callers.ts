'use server';

import { getAcquisitionRoster } from '@/lib/my-leads/queries';
import { createDialpadVoiceAdminClient } from './database';
import type { DialpadConfigurationDatabase } from './configuration-database';
import { DialpadVoiceClient } from './client';
import { verifyDialpadInventory } from './verified-inventory';
import { resolveDialpadAssignment, type DialpadCallerIdentity } from './assignments';

type CallerOption = Readonly<{
  provider: 'dialpad'; grantId: string; grantRevision: number; bindingRevision: number;
  connectionVersion: number;
  phoneE164: string; identity: DialpadCallerIdentity;
}>;

/** Rep dropdown data, never owner discovery data. There is deliberately no
 * member/org argument: even an owner can load only their own calling grants.
 * Presence in this list does not prove desktop readiness; start must reverify.
 */
export async function loadMyDialpadCallerOptions(): Promise<
  { ok: true; options: CallerOption[] } | { ok: false; error: 'dialpad_numbers_unavailable' }
> {
  try {
    const { viewer, roster } = await getAcquisitionRoster();
    const member = roster.members.find(m => m.id === viewer.userId);
    if (!roster.settings.enabled || !member?.active || !member.acquisitionsEnabled) return { ok: true, options: [] };
    const db = createDialpadVoiceAdminClient<DialpadConfigurationDatabase>();
    const read = await db.from('dialpad_org_connections')
      .select('id,org_id,provider_company_id,enabled,config_version,verified_at,credential_reference').eq('org_id', viewer.orgId).maybeSingle();
    if (read.error) throw Error();
    const connection = read.data;
    if (!connection || !connection.enabled || !connection.verified_at) return { ok: true, options: [] };
    if (connection.org_id !== viewer.orgId || !/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(connection.credential_reference)) throw Error();
    const credential = process.env[connection.credential_reference.slice(4)];
    if (!credential) throw Error();
    const bindingRead = await db.from('dialpad_member_bindings')
      .select('id,org_id,member_user_id,provider_user_id,revision,connection_id,connection_version,revoked_at')
      .eq('org_id', viewer.orgId).eq('member_user_id', viewer.userId)
      .eq('connection_id', connection.id).eq('connection_version', connection.config_version).is('revoked_at', null).maybeSingle();
    if (bindingRead.error) throw Error();
    const binding = bindingRead.data;
    if (!binding) return { ok: true, options: [] };
    if (binding.org_id !== viewer.orgId || binding.member_user_id !== viewer.userId || binding.connection_id !== connection.id
      || binding.connection_version !== connection.config_version || binding.revoked_at !== null) throw Error();
    const grantRead = await db.from('dialpad_number_grants')
      .select('id,org_id,binding_id,revision,identity_type,provider_identity_id,number_e164,revoked_at')
      .eq('org_id', viewer.orgId).eq('binding_id', binding.id).is('revoked_at', null);
    if (grantRead.error || !grantRead.data) throw Error();
    if (grantRead.data.length === 0) return { ok: true, options: [] };
    const user = await db.auth.admin.getUserById(viewer.userId);
    if (user.error || user.data.user?.id !== viewer.userId || !user.data.user.email) throw Error();
    const verified = await verifyDialpadInventory(new DialpadVoiceClient(credential), {
      orgId: viewer.orgId, providerCompanyId: connection.provider_company_id,
      providerUserId: binding.provider_user_id, memberEmail: user.data.user.email,
    });
    const options: CallerOption[] = [];
    for (const grant of grantRead.data) {
      if (grant.binding_id !== binding.id || grant.org_id !== viewer.orgId || grant.revoked_at !== null) throw Error();
      const resolved = resolveDialpadAssignment({
        viewer: { orgId: viewer.orgId, memberId: viewer.userId },
        membership: { orgId: viewer.orgId, memberId: member.id, active: member.active, acquisitionsEnabled: member.acquisitionsEnabled },
        binding: { orgId: binding.org_id, memberId: binding.member_user_id, providerUserId: binding.provider_user_id,
          version: binding.revision, active: true, adminValidated: true },
        grants: [{ id: grant.id, version: grant.revision, bindingVersion: binding.revision,
          orgId: grant.org_id, memberId: binding.member_user_id, providerUserId: binding.provider_user_id,
          number: grant.number_e164, identity: { type: grant.identity_type as DialpadCallerIdentity['type'], id: grant.provider_identity_id }, active: true }],
        inventory: verified.inventory, selection: { grantId: grant.id, version: grant.revision },
      });
      // A provider-revoked identity is omitted; no substitution by another
      // context sharing the same E.164 number is allowed.
      if (resolved.ok) options.push(Object.freeze({ provider: 'dialpad', grantId: grant.id, grantRevision: grant.revision,
        bindingRevision: binding.revision, connectionVersion: connection.config_version,
        phoneE164: resolved.snapshot.callerId, identity: resolved.snapshot.identity }));
    }
    return { ok: true, options };
  } catch { return { ok: false, error: 'dialpad_numbers_unavailable' }; }
}
