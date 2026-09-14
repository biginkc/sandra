import 'server-only';
import type { DialpadCallerInventory } from './assignments';
import { normalizeDialpadPersonas } from './personas';

export type InventoryVerificationCode = 'invalid_scope' | 'provider_unavailable' | 'user_mismatch' | 'company_mismatch' | 'inactive_user' | 'email_mismatch' | 'incomplete_inventory' | 'invalid_inventory' | 'invalid_clock';
export class DialpadInventoryVerificationError extends Error {
  constructor(readonly code: InventoryVerificationCode) {
    super('Dialpad inventory verification failed');
    this.name = 'DialpadInventoryVerificationError';
  }
}
export type DialpadInventoryProvider = {
  getUser(userId: string): Promise<unknown>;
  listUserPersonas(userId: string): Promise<unknown>;
};
export type VerifiedDialpadInventory = Readonly<{
  inventory: DialpadCallerInventory;
  provenance: Readonly<{ providerCompanyId: string; providerUserId: string; verifiedAt: string }>;
}>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
function fail(code: InventoryVerificationCode): never { throw new DialpadInventoryVerificationError(code); }

/** Scope must be resolved from authenticated server membership and the verified
 * organization connection, never copied from browser input. This verifies a
 * current provider inventory; it does not itself create a member binding/grant. */
export async function verifyDialpadInventory(
  provider: DialpadInventoryProvider,
  scope: Readonly<{ orgId: string; providerCompanyId: string; providerUserId: string; memberEmail: string }>,
  clock: () => Date = () => new Date(),
): Promise<VerifiedDialpadInventory> {
  if (typeof scope.orgId !== 'string' || !scope.orgId.trim() || !id(scope.providerCompanyId) || !id(scope.providerUserId)
    || typeof scope.memberEmail !== 'string' || !scope.memberEmail.includes('@') || scope.memberEmail.trim() !== scope.memberEmail) fail('invalid_scope');
  let user: unknown;
  try { user = await provider.getUser(scope.providerUserId); } catch { fail('provider_unavailable'); }
  if (!record(user) || user.id !== scope.providerUserId) fail('user_mismatch');
  if (user.company_id !== scope.providerCompanyId) fail('company_mismatch');
  if (user.state !== 'active') fail('inactive_user');
  if (!Array.isArray(user.emails) || !user.emails.every(email => typeof email === 'string')
    || !user.emails.some(email => email.toLowerCase() === scope.memberEmail.toLowerCase())) fail('email_mismatch');
  let response: unknown;
  try { response = await provider.listUserPersonas(scope.providerUserId); } catch { fail('provider_unavailable'); }
  if (!record(response) || !Array.isArray(response.items)) fail('invalid_inventory');
  if (response.cursor !== undefined && response.cursor !== null && response.cursor !== '') fail('incomplete_inventory');
  let inventory: DialpadCallerInventory;
  try { inventory = normalizeDialpadPersonas(response.items, scope); } catch { return fail('invalid_inventory'); }
  let verifiedAt: string;
  try { verifiedAt = clock().toISOString(); } catch { return fail('invalid_clock'); }
  return Object.freeze({ inventory, provenance: Object.freeze({ providerCompanyId: scope.providerCompanyId, providerUserId: scope.providerUserId, verifiedAt }) });
}
