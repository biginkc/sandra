import type { DialpadCallerIdentity, DialpadCallerInventory } from './assignments';

/** Sanitized failure: provider payloads can contain personal information. */
export class InvalidDialpadPersonas extends Error {
  constructor() { super('Invalid Dialpad caller inventory'); this.name = 'InvalidDialpadPersonas'; }
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const number = (value: unknown): value is string => typeof value === 'string' && /^\+[1-9]\d{1,14}$/.test(value);
const types = new Set(['user', 'office', 'department', 'callcenter']);

/** The transport supplies the documented persona ARRAY, not its response envelope.
 * Identity scope must come from the authenticated server connection and user.
 * Persona phone_numbers are authoritative here: flat caller-ID lists may omit
 * authorized group numbers. caller_id is validated but never used as a fallback.
 * Any malformed entry rejects the entire inventory rather than partially granting.
 */
export function normalizeDialpadPersonas(
  personas: unknown,
  scope: Readonly<{ orgId: string; providerUserId: string }>,
): DialpadCallerInventory {
  if (typeof scope.orgId !== 'string' || !scope.orgId.trim() || !identifier(scope.providerUserId) || !Array.isArray(personas)) throw new InvalidDialpadPersonas();
  const callers: { number: string; identity: DialpadCallerIdentity; active: boolean }[] = [];
  const seen = new Set<string>();
  for (const entry of personas) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new InvalidDialpadPersonas();
    const persona = entry as Record<string, unknown>;
    if (!identifier(persona.id) || typeof persona.type !== 'string' || !types.has(persona.type)
      || !number(persona.caller_id) || typeof persona.name !== 'string' || typeof persona.image_url !== 'string'
      || !Array.isArray(persona.phone_numbers) || !persona.phone_numbers.every(number)
      || (persona.type === 'user' && persona.id !== scope.providerUserId)) throw new InvalidDialpadPersonas();
    const identity: DialpadCallerIdentity = Object.freeze({ type: persona.type as DialpadCallerIdentity['type'], id: persona.id });
    for (const phone of persona.phone_numbers) {
      const key = JSON.stringify([identity.type, identity.id, phone]);
      if (seen.has(key)) continue;
      seen.add(key);
      callers.push(Object.freeze({ number: phone, identity, active: true }));
    }
  }
  return Object.freeze({ orgId: scope.orgId, providerUserId: scope.providerUserId, callers: Object.freeze(callers) });
}
