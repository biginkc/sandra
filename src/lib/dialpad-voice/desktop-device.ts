import 'server-only';

export class DialpadDesktopDeviceError extends Error {
  constructor(readonly code: 'invalid_selection' | 'provider_unavailable' | 'invalid_inventory' | 'incomplete_inventory' | 'device_unavailable') {
    super('Dialpad desktop device verification failed');
    this.name = 'DialpadDesktopDeviceError';
  }
}

/** Registration is NOT online/readiness evidence. The provider device listing
 * does not expose online state. Call initiation still needs durable uncertainty
 * handling and an observed ring/answer, even after this ownership check passes.
 * Selection must be explicit: never fall back to a web/mobile/other device.
 */
export async function verifySelectedDialpadDesktop(
  provider: { listUserDevices(userId: string, cursor?: string): Promise<unknown> },
  selection: Readonly<{ providerUserId: string; deviceId: string }>,
): Promise<Readonly<{ providerUserId: string; deviceId: string; type: 'native'; readiness: 'unproven' }>> {
  const fail = (code: DialpadDesktopDeviceError['code']): never => { throw new DialpadDesktopDeviceError(code); };
  if (!selection || typeof selection.providerUserId !== 'string' || !/^[1-9]\d*$/.test(selection.providerUserId) || typeof selection.deviceId !== 'string'
    || !selection.deviceId.trim() || selection.deviceId.length > 512 || /[\r\n]/.test(selection.deviceId)) fail('invalid_selection');
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let selected = false;
  for (let page = 0; page < 20; page++) {
    let response: unknown;
    try { response = await provider.listUserDevices(selection.providerUserId, cursor); }
    catch { return fail('provider_unavailable'); }
    if (!response || typeof response !== 'object' || Array.isArray(response)) fail('invalid_inventory');
    const envelope = response as Record<string, unknown>;
    if (!Array.isArray(envelope.items)) fail('invalid_inventory');
    for (const raw of envelope.items as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_inventory');
      const device = raw as Record<string, unknown>;
      if (typeof device.id !== 'string' || !device.id.trim() || typeof device.user_id !== 'string'
        || device.user_id !== selection.providerUserId || typeof device.type !== 'string' || ids.has(device.id)) fail('invalid_inventory');
      ids.add(device.id as string);
      if (device.id === selection.deviceId) {
        if (device.type !== 'native') fail('device_unavailable');
        selected = true;
      }
    }
    if (envelope.cursor === undefined || envelope.cursor === null || envelope.cursor === '') {
      if (!selected) fail('device_unavailable');
      return Object.freeze({ ...selection, type: 'native', readiness: 'unproven' });
    }
    if (typeof envelope.cursor !== 'string' || envelope.cursor.length > 4096 || cursors.has(envelope.cursor)) fail('incomplete_inventory');
    cursor = envelope.cursor as string;
    cursors.add(cursor);
  }
  return fail('incomplete_inventory');
}
