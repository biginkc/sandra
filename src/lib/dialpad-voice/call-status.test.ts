import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ roster: vi.fn(), admin: vi.fn(), read: vi.fn(), eq: vi.fn() }));
vi.mock('@/lib/my-leads/queries', () => ({ getAcquisitionRoster: m.roster }));
vi.mock('./database', () => ({ createDialpadVoiceAdminClient: m.admin }));
import { getMyActiveDialpadCall, getMyDialpadCallStatus } from './call-status';
const id = '11111111-1111-4111-8111-111111111111';
const row = () => ({ id, org_id: 'org', actor_user_id: 'rep', status: 'initiation_unconfirmed', updated_at: '2026-09-14T03:00:00Z' });
beforeEach(() => {
  vi.resetAllMocks();
  m.roster.mockResolvedValue({ viewer: { orgId: 'org', userId: 'rep', isOwner: true }, roster: {
    settings: { enabled: false }, members: [{ id: 'rep', active: true, acquisitionsEnabled: false }],
  } });
  const query = { select: vi.fn().mockReturnThis(), eq: m.eq, in: vi.fn().mockReturnThis(), maybeSingle: m.read };
  m.eq.mockReturnValue(query);m.admin.mockReturnValue({ from: vi.fn().mockReturnValue(query) });
  m.read.mockResolvedValue({ data: row(), error: null });
});
it('reads original active actor after acquisitions is disabled, without caller identity or inferred duration', async () => {
  expect(await getMyDialpadCallStatus({ intentId: id })).toEqual({ ok: true, intentId: id, status: 'initiation_unconfirmed', updatedAt: '2026-09-14T03:00:00Z' });
  expect(m.eq).toHaveBeenCalledWith('org_id', 'org');
  expect(m.eq).toHaveBeenCalledWith('actor_user_id', 'rep');
});
it.each([{ org_id: 'other' }, { actor_user_id: 'other' }, { id: 'other' }])('rejects mismatched scope despite owner role: %j', async patch => {
  m.read.mockResolvedValue({ data: { ...row(), ...patch }, error: null });
  expect(await getMyDialpadCallStatus({ intentId: id })).toEqual({ ok: false, error: 'call_unavailable' });
});
it('rejects inactive actor before privileged read', async () => {
  m.roster.mockResolvedValue({ viewer: { orgId: 'org', userId: 'rep' }, roster: { members: [{ id: 'rep', active: false }] } });
  expect(await getMyDialpadCallStatus({ intentId: id })).toEqual({ ok: false, error: 'forbidden' });
  expect(m.admin).not.toHaveBeenCalled();
});
it('sanitizes database outage', async () => {
  m.read.mockRejectedValue(new Error('private detail'));
  expect(await getMyDialpadCallStatus({ intentId: id })).toEqual({ ok: false, error: 'call_unavailable' });
});
it('rejects malformed input before authentication or reads', async () => {
  expect(await getMyDialpadCallStatus({ intentId: 'bad' })).toEqual({ ok: false, error: 'invalid_input' });
  expect(m.roster).not.toHaveBeenCalled();
});
it('recovers an uncertain active reservation without requiring a provider call ID', async () => {
  m.read.mockResolvedValue({ data: { ...row(), property_id: 'lead' }, error: null });
  expect(await getMyActiveDialpadCall()).toEqual({ ok: true, call: {
    intentId: id, propertyId: 'lead', status: 'initiation_unconfirmed', updatedAt: row().updated_at,
  } });
  expect(m.eq).toHaveBeenCalledWith('actor_user_id', 'rep');
});
it('returns a clear empty state when no active reservation exists', async () => {
  m.read.mockResolvedValue({ data: null, error: null });
  expect(await getMyActiveDialpadCall()).toEqual({ ok: true, call: null });
});
it.each([{ actor_user_id: 'other' }, { org_id: 'other' }, { status: 'completed' }])('rejects mismatched recovery row %j', async patch => {
  m.read.mockResolvedValue({ data: { ...row(), ...patch }, error: null });
  expect(await getMyActiveDialpadCall()).toEqual({ ok: false, error: 'call_unavailable' });
});
it('does not treat a failed or ambiguous recovery query as no active call', async () => {
  m.read.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
  expect(await getMyActiveDialpadCall()).toEqual({ ok: false, error: 'call_unavailable' });
});
