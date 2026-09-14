import { expect, it, vi } from 'vitest';
import { resolveHistoricalDialpadConnection } from './historical-connection';
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const scope = { orgId: id(1), intentId: id(2) };
function fixture() {
  const store = {
    readIntent: vi.fn().mockResolvedValue({ org_id: id(1), id: id(2), actor_user_id: id(3), dialpad_user_id: '201' }),
    readConfiguration: vi.fn().mockResolvedValue({ org_id: id(1), intent_id: id(2), connection_id: id(4), connection_version: 2 }),
    readRevision: vi.fn().mockResolvedValue({ org_id: id(1), connection_id: id(4), config_version: 2, provider_company_id: '301', credential_reference: 'env:DIALPAD_OLD', enabled: false }),
  };
  const credentials = { resolve: vi.fn().mockResolvedValue('fixture-key'), getCompany: vi.fn().mockResolvedValue({ id: '301' }) };
  return { store, credentials };
}
it('uses the exact frozen revision even when disabled, without current member or grant lookup', async () => {
  const { store, credentials } = fixture();
  const result = await resolveHistoricalDialpadConnection(store, credentials, scope);
  expect(result).toMatchObject({ connectionVersion: 2, providerCompanyId: '301', providerUserId: '201', actorUserId: id(3) });
  expect(store.readRevision).toHaveBeenCalledWith(id(1), id(4), 2);
  expect(credentials.resolve).toHaveBeenCalledWith('env:DIALPAD_OLD');
  expect(credentials.getCompany).toHaveBeenCalledWith('fixture-key');
});
it.each(['readIntent', 'readConfiguration', 'readRevision'] as const)('rejects cross-org substitution in %s without requesting credentials', async method => {
  const { store, credentials } = fixture();
  const original = await store[method]();
  store[method].mockResolvedValue({ ...original, org_id: id(9) });
  await expect(resolveHistoricalDialpadConnection(store, credentials, scope)).rejects.toMatchObject({ code: 'history_unavailable' });
  expect(credentials.resolve).not.toHaveBeenCalled();
});
it('rejects a rotated credential for a different company', async () => {
  const { store, credentials } = fixture(); credentials.getCompany.mockResolvedValue({ id: '999' });
  await expect(resolveHistoricalDialpadConnection(store, credentials, scope)).rejects.toMatchObject({ code: 'company_mismatch' });
});
it('never falls back when historical credentials are missing and sanitizes provider failures', async () => {
  const { store, credentials } = fixture(); credentials.resolve.mockResolvedValue(undefined);
  await expect(resolveHistoricalDialpadConnection(store, credentials, scope)).rejects.toMatchObject({ code: 'credential_unavailable' });
  expect(credentials.resolve).toHaveBeenCalledTimes(1); expect(credentials.getCompany).not.toHaveBeenCalled();
  credentials.resolve.mockRejectedValue(new Error('sensitive fixture details'));
  await expect(resolveHistoricalDialpadConnection(store, credentials, scope)).rejects.toThrow('Historical Dialpad connection unavailable');
});
it('rejects a substituted historical version', async () => {
  const { store, credentials } = fixture(); const revision = await store.readRevision();
  store.readRevision.mockResolvedValue({ ...revision, config_version: 3 });
  await expect(resolveHistoricalDialpadConnection(store, credentials, scope)).rejects.toMatchObject({ code: 'history_unavailable' });
});
