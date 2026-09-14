import { describe, expect, it, vi } from 'vitest';
import { verifyDialpadInventory, DialpadInventoryVerificationError } from './verified-inventory';
const scope = { orgId: 'test-org', providerCompanyId: '101', providerUserId: '9007199254740993', memberEmail: 'rep@example.test' };
const user = () => ({ id: scope.providerUserId, company_id: scope.providerCompanyId, state: 'active', emails: ['REP@example.test'], phone_numbers: ['+12025550101'] });
const persona = () => ({ id: '201', type: 'office', caller_id: '+12025550102', name: 'Office', image_url: '', phone_numbers: ['+12025550102'] });
const provider = () => ({ getUser: vi.fn(async (): Promise<unknown> => user()), listUserPersonas: vi.fn(async (): Promise<unknown> => ({ items: [persona()] })) });
const clock = () => new Date('2026-09-13T12:00:00Z');
describe('verified Dialpad inventory', () => {
  it('verifies casefold email and retains office persona absent from flat caller list with frozen provenance', async () => {
    const api = provider(), result = await verifyDialpadInventory(api, scope, clock);
    expect(result.inventory.callers[0].number).toBe('+12025550102');
    expect(result.provenance).toEqual({ providerCompanyId: '101', providerUserId: scope.providerUserId, verifiedAt: '2026-09-13T12:00:00.000Z' });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.provenance)).toBe(true);
    expect(Object.keys(result)).toEqual(['inventory', 'provenance']);
    expect(api.getUser).toHaveBeenCalledWith(scope.providerUserId); expect(api.listUserPersonas).toHaveBeenCalledWith(scope.providerUserId);
  });
  it.each([
    [{ id: '99' }, 'user_mismatch'], [{ id: 9007199254740992 }, 'user_mismatch'],
    [{ company_id: '99' }, 'company_mismatch'], [{ company_id: 101 }, 'company_mismatch'],
    [{ state: 'inactive' }, 'inactive_user'], [{ state: 'ACTIVE' }, 'inactive_user'],
    [{ emails: ['another@example.test'] }, 'email_mismatch'], [{ emails: [' rep@example.test'] }, 'email_mismatch'],
    [{ emails: ['rep@example.test', null] }, 'email_mismatch'],
  ])('rejects unverified user without fetching personas: %j', async (patch, code) => {
    const api = provider(); api.getUser.mockResolvedValue({ ...user(), ...patch });
    await expect(verifyDialpadInventory(api, scope, clock)).rejects.toMatchObject({ code });
    expect(api.listUserPersonas).not.toHaveBeenCalled();
  });
  it.each([undefined, null, ''])('accepts exhausted cursor %j and empty inventory', async cursor => {
    const api = provider(); api.listUserPersonas.mockResolvedValue({ items: [], cursor });
    expect((await verifyDialpadInventory(api, scope, clock)).inventory.callers).toEqual([]);
  });
  it.each(['next-page', 0, false, {}])('rejects incomplete/invalid cursor %j', async cursor => {
    const api = provider(); api.listUserPersonas.mockResolvedValue({ items: [persona()], cursor });
    await expect(verifyDialpadInventory(api, scope, clock)).rejects.toMatchObject({ code: 'incomplete_inventory' });
  });
  it.each([null, [], { items: null }, { items: [{ ...persona(), type: 'unknown' }] }])('rejects malformed inventory %j', async payload => {
    const api = provider(); api.listUserPersonas.mockResolvedValue(payload);
    await expect(verifyDialpadInventory(api, scope, clock)).rejects.toMatchObject({ code: 'invalid_inventory' });
  });
  it('sanitizes transport failures without retaining their payload or cause', async () => {
    for (const method of ['getUser', 'listUserPersonas'] as const) {
      const api = provider(); api[method].mockRejectedValue(new Error('Sensitive provider payload'));
      try { await verifyDialpadInventory(api, scope, clock); throw new Error('Expected failure'); }
      catch (error) { expect(error).toBeInstanceOf(DialpadInventoryVerificationError); expect(error).toMatchObject({ code: 'provider_unavailable', message: 'Dialpad inventory verification failed' }); expect((error as Error).cause).toBeUndefined(); }
    }
  });
  it('rejects invalid trusted scope before provider access and invalid clock', async () => {
    const api = provider();
    await expect(verifyDialpadInventory(api, { ...scope, providerCompanyId: '1e3' }, clock)).rejects.toMatchObject({ code: 'invalid_scope' });
    expect(api.getUser).not.toHaveBeenCalled();
    await expect(verifyDialpadInventory(api, scope, () => new Date(NaN))).rejects.toMatchObject({ code: 'invalid_clock' });
  });
});
