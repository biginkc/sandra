import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  myLeadsViewer: vi.fn(),
  getUser: vi.fn(),
  verifyDialpadBinding: vi.fn(),
  startDialpadCall: vi.fn(),
  listDialpadCallTargets: vi.fn(),
  getDialpadCallStatus: vi.fn(),
  cancelDialpadCall: vi.fn(),
  listRecentDialpadCalls: vi.fn(),
  db: { marker: 'db' },
}));

vi.mock('@/lib/my-leads/queries', () => ({ myLeadsViewer: mocks.myLeadsViewer }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/dialpad-cti/dispatch', () => ({
  createSupabaseDialpadDispatchDb: () => mocks.db,
  verifyDialpadBinding: mocks.verifyDialpadBinding,
  startDialpadCall: mocks.startDialpadCall,
  listDialpadCallTargets: mocks.listDialpadCallTargets,
  getDialpadCallStatus: mocks.getDialpadCallStatus,
  cancelDialpadCall: mocks.cancelDialpadCall,
  listRecentDialpadCalls: mocks.listRecentDialpadCalls,
}));

import {
  cancelDialpadCallAction,
  getDialpadCallStatusAction,
  listDialpadCallTargetsAction,
  listRecentDialpadCallsAction,
  startDialpadCallAction,
  verifyDialpadBindingAction,
} from './dialpad-actions';

const viewer = () => ({ userId: 'rep-1', orgId: 'org-1', isOwner: false, client: { auth: { getUser: mocks.getUser } } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.myLeadsViewer.mockResolvedValue(viewer());
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'rep-1', email: 'rep@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } });
});

describe('Dialpad server actions', () => {
  it('derive org and rep from the session and ignore any org or rep supplied by the browser', async () => {
    mocks.startDialpadCall.mockResolvedValue({ ok: true });
    await startDialpadCallAction({ orgId: 'evil-org', repUserId: 'evil-rep', propertyId: 'p', contactId: 'c', phoneSlot: 1, grantId: null, idempotencyKey: 'k' } as never);
    expect(mocks.startDialpadCall).toHaveBeenCalledWith(mocks.db, { orgId: 'org-1', userId: 'rep-1' }, { propertyId: 'p', contactId: 'c', phoneSlot: 1, grantId: null, idempotencyKey: 'k' });
    await listDialpadCallTargetsAction({ propertyId: 'p', contactId: 'c' });
    expect(mocks.listDialpadCallTargets).toHaveBeenCalledWith(mocks.db, { orgId: 'org-1', userId: 'rep-1' }, { propertyId: 'p', contactId: 'c' });
    await getDialpadCallStatusAction('i');
    await cancelDialpadCallAction('i');
    await listRecentDialpadCallsAction();
    expect(mocks.getDialpadCallStatus).toHaveBeenCalledWith(mocks.db, { orgId: 'org-1', userId: 'rep-1' }, 'i');
    expect(mocks.cancelDialpadCall).toHaveBeenCalledWith(mocks.db, { orgId: 'org-1', userId: 'rep-1' }, 'i');
    expect(mocks.listRecentDialpadCalls).toHaveBeenCalledWith(mocks.db, { orgId: 'org-1', userId: 'rep-1' });
  });
  it('passes the authenticated, confirmed email to binding verification, not a browser-supplied one', async () => {
    mocks.verifyDialpadBinding.mockResolvedValue({ ok: true });
    await verifyDialpadBindingAction(5551234);
    expect(mocks.verifyDialpadBinding).toHaveBeenCalledWith(mocks.db, { orgId: 'org-1', userId: 'rep-1' }, { email: 'rep@example.com', emailConfirmed: true }, 5551234, expect.objectContaining({ env: expect.anything() }));
  });
  it('reports an unconfirmed email as unconfirmed', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'rep-1', email: 'rep@example.com', email_confirmed_at: null } } });
    mocks.verifyDialpadBinding.mockResolvedValue({ ok: false });
    await verifyDialpadBindingAction(5551234);
    expect(mocks.verifyDialpadBinding.mock.calls[0]![2]).toEqual({ email: 'rep@example.com', emailConfirmed: false });
  });
  it.each([
    ['no session', () => mocks.myLeadsViewer.mockRejectedValue(new Error('UNAUTHENTICATED'))],
    ['a session user that differs from the viewer', () => mocks.getUser.mockResolvedValue({ data: { user: { id: 'someone-else' } } })],
    ['no auth user', () => mocks.getUser.mockResolvedValue({ data: { user: null } })],
  ])('refuses every action with %s', async (_label, arrange) => {
    arrange();
    const results = await Promise.all([
      verifyDialpadBindingAction(1), listDialpadCallTargetsAction({ propertyId: 'p', contactId: 'c' }),
      startDialpadCallAction({ propertyId: 'p', contactId: 'c', phoneSlot: 1, grantId: null, idempotencyKey: 'k' }),
      getDialpadCallStatusAction('i'), cancelDialpadCallAction('i'), listRecentDialpadCallsAction(),
    ]);
    for (const result of results) expect(result).toMatchObject({ ok: false });
    expect(mocks.startDialpadCall).not.toHaveBeenCalled();
    expect(mocks.verifyDialpadBinding).not.toHaveBeenCalled();
  });
});
