// Browser-only fixture boundary. No synthetic page can dispatch a Dialpad call.
export const getMyActiveDialpadCall = async () => ({ ok: true as const, call: null });
export const getMyDialpadCallStatus = async () => ({ ok: false as const, error: 'fixture_only' });
export const loadMyDialpadCallerOptions = async () => ({ ok: true as const, options: [] });
export const listMyDialpadDesktopDevices = async () => ({ ok: false as const, error: 'fixture_only' });
export const startConfiguredDialpadCall = async () => ({ ok: false as const, error: 'fixture_only' });
export const hangupConfiguredDialpadCall = async () => ({ ok: false as const, error: 'fixture_only' });
