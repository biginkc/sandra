import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  myLeadsViewer: vi.fn(),
  getUser: vi.fn(),
  openDialpadRecordingCapture: vi.fn(),
  closeDialpadRecordingCapture: vi.fn(),
  mintDialpadRecordingGrant: vi.fn(),
  mintDialpadRecordingNextEpoch: vi.fn(),
  getDialpadRecordingBrowserStatus: vi.fn(),
  db: { marker: 'db' },
}));

vi.mock('@/lib/my-leads/queries', () => ({ myLeadsViewer: mocks.myLeadsViewer }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/dialpad-recording/capture', () => ({
  createSupabaseDialpadRecordingDb: () => mocks.db,
  openDialpadRecordingCapture: mocks.openDialpadRecordingCapture,
  closeDialpadRecordingCapture: mocks.closeDialpadRecordingCapture,
  mintDialpadRecordingGrant: mocks.mintDialpadRecordingGrant,
  mintDialpadRecordingNextEpoch: mocks.mintDialpadRecordingNextEpoch,
  getDialpadRecordingBrowserStatus: mocks.getDialpadRecordingBrowserStatus,
}));

import { closeDialpadRecordingCaptureAction, getDialpadRecordingBrowserStatusAction, mintDialpadRecordingGrantAction, mintDialpadRecordingNextEpochAction, openDialpadRecordingCaptureAction } from './dialpad-recording-actions';

const viewer = () => ({ userId: 'rep-1', orgId: 'org-1', isOwner: false, client: { auth: { getUser: mocks.getUser } } });
const actor = { orgId: 'org-1', userId: 'rep-1' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.myLeadsViewer.mockResolvedValue(viewer());
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'rep-1' } } });
});

describe('Dialpad recording server actions', () => {
  it('derive org and rep from the session and ignore any supplied by the browser', async () => {
    await openDialpadRecordingCaptureAction('intent-1');
    await closeDialpadRecordingCaptureAction('capture-1');
    await mintDialpadRecordingGrantAction({ captureId: 'capture-1', epoch: 2, orgId: 'evil-org', repUserId: 'evil-rep' } as never);
    await mintDialpadRecordingNextEpochAction({ captureId: 'capture-1', expectedConsumedEpoch: 0, orgId: 'evil-org', repUserId: 'evil-rep' } as never);
    await getDialpadRecordingBrowserStatusAction('capture-1');
    expect(mocks.openDialpadRecordingCapture).toHaveBeenCalledWith(mocks.db, actor, 'intent-1');
    expect(mocks.closeDialpadRecordingCapture).toHaveBeenCalledWith(mocks.db, actor, 'capture-1');
    expect(mocks.mintDialpadRecordingGrant).not.toHaveBeenCalled();
    expect(mocks.mintDialpadRecordingNextEpoch).toHaveBeenNthCalledWith(1, mocks.db, actor, { captureId: 'capture-1', expectedConsumedEpoch: 1 });
    expect(mocks.mintDialpadRecordingNextEpoch).toHaveBeenCalledWith(mocks.db, actor, { captureId: 'capture-1', expectedConsumedEpoch: 0 });
    expect(mocks.getDialpadRecordingBrowserStatus).toHaveBeenCalledWith(mocks.db, actor, 'capture-1');
  });

  it('returns a denied result and never touches the database when unauthenticated', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    for (const result of [
      await openDialpadRecordingCaptureAction('i'),
      await closeDialpadRecordingCaptureAction('c'),
      await mintDialpadRecordingGrantAction({ captureId: 'c', epoch: 1 }),
      await mintDialpadRecordingNextEpochAction({ captureId: 'c', expectedConsumedEpoch: 0 }),
      await getDialpadRecordingBrowserStatusAction('c'),
    ]) {
      expect(result).toMatchObject({ ok: false, code: 'denied' });
    }
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'someone-else' } } });
    expect(await openDialpadRecordingCaptureAction('i')).toMatchObject({ ok: false, code: 'denied' });
    mocks.myLeadsViewer.mockRejectedValue(new Error('no session'));
    expect(await openDialpadRecordingCaptureAction('i')).toMatchObject({ ok: false, code: 'denied' });
    expect(mocks.openDialpadRecordingCapture).not.toHaveBeenCalled();
    expect(mocks.mintDialpadRecordingGrant).not.toHaveBeenCalled();
  });

  it('exposes only session-owned operations', async () => {
    const mod = await import('./dialpad-recording-actions');
    expect(Object.keys(mod).sort()).toEqual(['closeDialpadRecordingCaptureAction', 'getDialpadRecordingBrowserStatusAction', 'mintDialpadRecordingGrantAction', 'mintDialpadRecordingNextEpochAction', 'openDialpadRecordingCaptureAction']);
  });
});
