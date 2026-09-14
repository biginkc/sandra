/** Pure authorization adapter. All membership, binding and inventory arguments
 * must be loaded server-side; browser input is limited to grant ID/version. */
export type AcquisitionsMembership = Readonly<{
  orgId: string; memberId: string; active: boolean; acquisitionsEnabled: boolean;
}>;
export type DialpadMemberBinding = Readonly<{
  orgId: string; memberId: string; providerUserId: string;
  version: number; active: boolean; adminValidated: boolean;
}>;
export type DialpadCallerIdentity = Readonly<{
  type: 'user' | 'office' | 'department' | 'callcenter'; id: string;
}>;
export type DialpadNumberGrant = Readonly<{
  id: string; version: number; bindingVersion: number;
  orgId: string; memberId: string; providerUserId: string;
  number: string; identity: DialpadCallerIdentity; active: boolean;
}>;
/** Caller-ID inventory must be the provider-authorized list for this exact user,
 * not a company-wide phone-number catalog. Group identities must be resolved
 * server-side against provider group authorization; caller-ID phone_numbers
 * alone does not establish a number’s group association. */
export type DialpadCallerInventory = Readonly<{
  orgId: string; providerUserId: string;
  callers: readonly Readonly<{ number: string; identity: DialpadCallerIdentity; active: boolean }>[];
}>;
export type DialpadDispatchIdentity = Readonly<{
  orgId: string; memberId: string; providerUserId: string;
  bindingVersion: number; grantId: string; grantVersion: number;
  callerId: string; identity: DialpadCallerIdentity;
  ctiIdentity: Readonly<{ type: 'Office' | 'OfficeGroup' | 'CallCenter'; id: string }> | null;
}>;
export type AssignmentFailure = 'membership_denied' | 'binding_denied' | 'grant_denied' | 'stale_selection' | 'caller_unavailable';
export type AssignmentResult = { ok: true; snapshot: DialpadDispatchIdentity } | { ok: false; code: AssignmentFailure };
const providerId = (value: string) => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const version = (value: number) => Number.isSafeInteger(value) && value > 0;
const sameIdentity = (a: DialpadCallerIdentity, b: DialpadCallerIdentity) => a.type === b.type && a.id === b.id;
const ctiTypes = { user: null, office: 'Office', department: 'OfficeGroup', callcenter: 'CallCenter' } as const;

export function resolveDialpadAssignment(input: {
  viewer: Readonly<{ orgId: string; memberId: string }>;
  membership: AcquisitionsMembership;
  binding: DialpadMemberBinding;
  grants: readonly DialpadNumberGrant[];
  inventory: DialpadCallerInventory;
  selection: Readonly<{ grantId: string; version: number }>;
}): AssignmentResult {
  const { viewer, membership, binding, inventory, selection } = input;
  if (!viewer.orgId || !viewer.memberId || membership.orgId !== viewer.orgId || membership.memberId !== viewer.memberId || !membership.active || !membership.acquisitionsEnabled) return { ok: false, code: 'membership_denied' };
  if (binding.orgId !== viewer.orgId || binding.memberId !== viewer.memberId || !binding.active || !binding.adminValidated || !version(binding.version) || !providerId(binding.providerUserId)) return { ok: false, code: 'binding_denied' };
  const matches = input.grants.filter(grant => grant.id === selection.grantId);
  if (matches.length !== 1) return { ok: false, code: 'grant_denied' };
  const grant = matches[0];
  if (!grant.active || !grant.id || grant.orgId !== viewer.orgId || grant.memberId !== viewer.memberId || grant.providerUserId !== binding.providerUserId) return { ok: false, code: 'grant_denied' };
  if (!version(grant.version) || !version(selection.version) || grant.version !== selection.version || grant.bindingVersion !== binding.version) return { ok: false, code: 'stale_selection' };
  if (!/^\+[1-9]\d{1,14}$/.test(grant.number) || !providerId(grant.identity.id) || !Object.hasOwn(ctiTypes, grant.identity.type) || (grant.identity.type === 'user' && grant.identity.id !== binding.providerUserId)) return { ok: false, code: 'grant_denied' };
  if (inventory.orgId !== viewer.orgId || inventory.providerUserId !== binding.providerUserId || !inventory.callers.some(caller => caller.active && caller.number === grant.number && sameIdentity(caller.identity, grant.identity))) return { ok: false, code: 'caller_unavailable' };
  return { ok: true, snapshot: Object.freeze({
    orgId: viewer.orgId, memberId: viewer.memberId, providerUserId: binding.providerUserId,
    bindingVersion: binding.version, grantId: grant.id, grantVersion: grant.version,
    callerId: grant.number, identity: Object.freeze({ ...grant.identity }),
    ctiIdentity: grant.identity.type === 'user' ? null : Object.freeze({ type: ctiTypes[grant.identity.type], id: grant.identity.id }),
  }) };
}
