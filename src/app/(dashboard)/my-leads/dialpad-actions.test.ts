import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  myLeadsViewer: vi.fn(),
  getUser: vi.fn(),
  getMyLeadsFlag: vi.fn(),
  schemaReady: vi.fn(),
  startDialpadApiCall: vi.fn(),
  createDialpadDialer: vi.fn(),
  ensureDialpadBinding: vi.fn(),
  getDialpadCallStatus: vi.fn(),
  cancelDialpadCall: vi.fn(),
  db: { marker: 'db' },
  dialer: { marker: 'dialer' },
}));

vi.mock('@/lib/my-leads/queries', () => ({ myLeadsViewer: mocks.myLeadsViewer }));
vi.mock('@/lib/my-leads/flags', () => ({ getMyLeadsFlag: mocks.getMyLeadsFlag }));
vi.mock('@/lib/my-leads/schema-ready', () => ({ schemaReady: mocks.schemaReady }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('@/lib/dialpad-cti/api-dial', () => ({
  startDialpadApiCall: mocks.startDialpadApiCall,
  createDialpadDialer: mocks.createDialpadDialer,
}));
vi.mock('@/lib/dialpad-cti/dispatch', () => ({
  createSupabaseDialpadDispatchDb: () => mocks.db,
  ensureDialpadBinding: mocks.ensureDialpadBinding,
  getDialpadCallStatus: mocks.getDialpadCallStatus,
  cancelDialpadCall: mocks.cancelDialpadCall,
}));

import {
  cancelDialpadCallAction,
  dialLeadAction,
  ensureDialpadBindingAction,
  getDialpadCallStatusAction,
} from './dialpad-actions';

const viewer = () => ({ userId: 'rep-1', orgId: 'org-1', isOwner: false, client: { auth: { getUser: mocks.getUser } } });
const actor = { orgId: 'org-1', userId: 'rep-1' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.myLeadsViewer.mockResolvedValue(viewer());
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'rep-1', email: 'rep@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } });
  mocks.getMyLeadsFlag.mockResolvedValue(true);
  mocks.schemaReady.mockResolvedValue(true);
  mocks.createDialpadDialer.mockReturnValue(mocks.dialer);
});

describe('dialLeadAction', () => {
  const input = { propertyId: 'p', contactId: 'c', idempotencyKey: 'k' };

  it('calls the dial flow with the session actor and ignores any org or rep in the input', async () => {
    mocks.startDialpadApiCall.mockResolvedValue({ ok: true, intentId: 'i', state: 'awaiting_provider', uncertain: false, phoneSlot: 1 });
    await dialLeadAction({ ...input, orgId: 'evil-org', repUserId: 'evil-rep', userId: 'evil-user' } as never);
    expect(mocks.getMyLeadsFlag).toHaveBeenCalledWith('org-1', 'click_to_dial');
    expect(mocks.schemaReady).toHaveBeenCalledWith('api_dial');
    expect(mocks.startDialpadApiCall).toHaveBeenCalledTimes(1);
    expect(mocks.startDialpadApiCall).toHaveBeenCalledWith(
      mocks.db, mocks.dialer, actor,
      { propertyId: 'p', contactId: 'c', phoneSlot: null, idempotencyKey: 'k' },
      { env: process.env },
    );
  });
  it('passes an explicit phone slot through', async () => {
    mocks.startDialpadApiCall.mockResolvedValue({ ok: true });
    await dialLeadAction({ ...input, phoneSlot: 2 });
    expect(mocks.startDialpadApiCall.mock.calls[0]![3]).toEqual({ propertyId: 'p', contactId: 'c', phoneSlot: 2, idempotencyKey: 'k' });
  });
  it('returns the dial outcome unchanged', async () => {
    const outcomes = [
      { ok: true, intentId: 'i', state: 'awaiting_provider', uncertain: true, phoneSlot: 1 },
      { ok: false, code: 'rate_limited', message: 'm', retryAfterSeconds: 30, freshAttemptKey: true },
      { ok: false, code: 'denied', message: 'm', denial: 'phone_dnc' },
    ];
    for (const outcome of outcomes) {
      mocks.startDialpadApiCall.mockResolvedValueOnce(outcome);
      expect(await dialLeadAction(input)).toBe(outcome);
    }
  });
  it('never exposes the dial payload, token or key', async () => {
    mocks.startDialpadApiCall.mockResolvedValue({ ok: true, intentId: 'i', state: 'awaiting_provider', uncertain: false, phoneSlot: 1 });
    const result = JSON.stringify(await dialLeadAction(input));
    expect(result).not.toContain('sandra.dialpad.v1');
    expect(result).not.toContain('dial"');
    expect(result).not.toContain('apiKey');
  });
  it.each([
    ['the click_to_dial flag is off', () => mocks.getMyLeadsFlag.mockResolvedValue(false)],
    ['the api_dial schema is not ready', () => mocks.schemaReady.mockResolvedValue(false)],
    ['the user is unauthenticated', () => mocks.myLeadsViewer.mockRejectedValue(new Error('UNAUTHENTICATED'))],
    ['the session user differs from the viewer', () => mocks.getUser.mockResolvedValue({ data: { user: { id: 'someone-else' } } })],
  ])('returns not_configured and never dials when %s', async (_label, arrange) => {
    arrange();
    expect(await dialLeadAction(input)).toMatchObject({ ok: false, code: 'not_configured' });
    expect(mocks.startDialpadApiCall).not.toHaveBeenCalled();
    expect(mocks.createDialpadDialer).not.toHaveBeenCalled();
  });
  it('does not check the flag or schema for an unauthenticated caller', async () => {
    mocks.myLeadsViewer.mockRejectedValue(new Error('UNAUTHENTICATED'));
    await dialLeadAction(input);
    expect(mocks.getMyLeadsFlag).not.toHaveBeenCalled();
  });
});

describe('ensureDialpadBindingAction', () => {
  it('passes the session email and confirmation, never a browser-supplied one', async () => {
    mocks.ensureDialpadBinding.mockResolvedValue({ ok: true });
    await ensureDialpadBindingAction();
    expect(mocks.ensureDialpadBinding).toHaveBeenCalledWith(mocks.db, actor, { email: 'rep@example.com', emailConfirmed: true }, expect.objectContaining({ env: expect.anything() }));
  });
  it('reports an unconfirmed email as unconfirmed', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'rep-1', email: 'rep@example.com', email_confirmed_at: null } } });
    mocks.ensureDialpadBinding.mockResolvedValue({ ok: false });
    await ensureDialpadBindingAction();
    expect(mocks.ensureDialpadBinding.mock.calls[0]![2]).toEqual({ email: 'rep@example.com', emailConfirmed: false });
  });
  it('is refused without a session', async () => {
    mocks.myLeadsViewer.mockRejectedValue(new Error('UNAUTHENTICATED'));
    expect(await ensureDialpadBindingAction()).toMatchObject({ ok: false, code: 'not_configured' });
    expect(mocks.ensureDialpadBinding).not.toHaveBeenCalled();
  });
});

describe('status and cancel actions', () => {
  it('derive org and rep from the session', async () => {
    await getDialpadCallStatusAction('i');
    await cancelDialpadCallAction('i');
    expect(mocks.getDialpadCallStatus).toHaveBeenCalledWith(mocks.db, actor, 'i');
    expect(mocks.cancelDialpadCall).toHaveBeenCalledWith(mocks.db, actor, 'i');
  });
  it.each([
    ['no session', () => mocks.myLeadsViewer.mockRejectedValue(new Error('UNAUTHENTICATED'))],
    ['a session user that differs from the viewer', () => mocks.getUser.mockResolvedValue({ data: { user: { id: 'someone-else' } } })],
    ['no auth user', () => mocks.getUser.mockResolvedValue({ data: { user: null } })],
  ])('refuse with %s', async (_label, arrange) => {
    arrange();
    const results = await Promise.all([getDialpadCallStatusAction('i'), cancelDialpadCallAction('i'), ensureDialpadBindingAction(), dialLeadAction({ propertyId: 'p', contactId: 'c', idempotencyKey: 'k' })]);
    for (const result of results) expect(result).toMatchObject({ ok: false });
    expect(mocks.getDialpadCallStatus).not.toHaveBeenCalled();
    expect(mocks.cancelDialpadCall).not.toHaveBeenCalled();
    expect(mocks.startDialpadApiCall).not.toHaveBeenCalled();
  });
});
