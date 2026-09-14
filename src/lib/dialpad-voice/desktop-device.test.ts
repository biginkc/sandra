import { describe, expect, it, vi } from 'vitest';
import { verifySelectedDialpadDesktop } from './desktop-device';

const selection = { providerUserId: '123', deviceId: 'desktop-1' };
const device = { id: selection.deviceId, user_id: '123', type: 'native' };
describe('selected Dialpad desktop ownership', () => {
  it('verifies the exact native registration without claiming online readiness', async () => {
    const listUserDevices = vi.fn().mockResolvedValue({ items: [device] });
    const result = await verifySelectedDialpadDesktop({ listUserDevices }, selection);
    expect(result).toEqual({ ...selection, type: 'native', readiness: 'unproven' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(listUserDevices).toHaveBeenCalledWith('123', undefined);
  });
  it.each(['web', 'iphone', 'ipad', 'harness'])('refuses a selected %s device', async type => {
    await expect(verifySelectedDialpadDesktop({ listUserDevices: async () => ({ items: [{ ...device, type }] }) }, selection)).rejects.toMatchObject({ code: 'device_unavailable' });
  });
  it('never substitutes another native device', async () => {
    await expect(verifySelectedDialpadDesktop({ listUserDevices: async () => ({ items: [{ ...device, id: 'other' }] }) }, selection)).rejects.toMatchObject({ code: 'device_unavailable' });
  });
  it('rejects cross-user inventory', async () => {
    await expect(verifySelectedDialpadDesktop({ listUserDevices: async () => ({ items: [{ ...device, user_id: '456' }] }) }, selection)).rejects.toMatchObject({ code: 'invalid_inventory' });
  });
  it('reads remaining pages before accepting a selected device', async () => {
    const listUserDevices = vi.fn().mockResolvedValueOnce({ items: [device], cursor: 'next' }).mockResolvedValueOnce({ items: [{ ...device, id: 'web', type: 'web' }] });
    await expect(verifySelectedDialpadDesktop({ listUserDevices }, selection)).resolves.toMatchObject({ deviceId: 'desktop-1' });
    expect(listUserDevices).toHaveBeenLastCalledWith('123', 'next');
  });
  it('rejects duplicate device identity across pages', async () => {
    const listUserDevices = vi.fn().mockResolvedValueOnce({ items: [device], cursor: 'next' }).mockResolvedValueOnce({ items: [device] });
    await expect(verifySelectedDialpadDesktop({ listUserDevices }, selection)).rejects.toMatchObject({ code: 'invalid_inventory' });
  });
  it('bounds repeated and endless cursors', async () => {
    for (const endless of [false, true]) {
      let n = 0;
      const listUserDevices = vi.fn(async () => ({ items: [], cursor: endless ? String(++n) : 'same' }));
      await expect(verifySelectedDialpadDesktop({ listUserDevices }, selection)).rejects.toMatchObject({ code: 'incomplete_inventory' });
      expect(listUserDevices.mock.calls.length).toBeLessThanOrEqual(20);
    }
  });
  it('sanitizes provider errors even after finding the device', async () => {
    const listUserDevices = vi.fn().mockResolvedValueOnce({ items: [device], cursor: 'next' }).mockRejectedValueOnce(Error('secret'));
    await expect(verifySelectedDialpadDesktop({ listUserDevices }, selection)).rejects.toMatchObject({ code: 'provider_unavailable', message: 'Dialpad desktop device verification failed' });
  });
});
