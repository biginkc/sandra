import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  targets: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  recent: vi.fn(),
}));

vi.mock('../dialpad-actions', () => ({
  verifyDialpadBindingAction: mocks.verify,
  listDialpadCallTargetsAction: mocks.targets,
  startDialpadCallAction: mocks.start,
  getDialpadCallStatusAction: mocks.status,
  cancelDialpadCallAction: mocks.cancel,
  listRecentDialpadCallsAction: mocks.recent,
}));

import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
import { DialpadPanel, type DialpadCallRequest } from './dialpad-panel';

const TOKEN = `sandra.dialpad.v1.${'c'.repeat(48)}`;
const INTENT = '66666666-6666-4666-8666-666666666666';
const verifiedBootstrap: DialpadPanelBootstrap = {
  connectionId: 'c1', allowedOrigins: ['https://dialpad.com'], binding: { status: 'verified', dialpadUserId: '5551234' }, grants: [],
};
const recordingBootstrap: DialpadPanelBootstrap = { ...verifiedBootstrap, recording: { ingestEndpoint: 'wss://recording.example.test/dialpad-browser-ingest' } };
const unboundBootstrap: DialpadPanelBootstrap = { ...verifiedBootstrap, binding: { status: 'none' } };
const request: DialpadCallRequest = { nonce: 1, propertyId: 'property-1', contactId: 'contact-1', label: 'Fixture Homeowner' };

const status = (state: string, extra: Record<string, unknown> = {}) => ({
  ok: true, status: { intentId: INTENT, state, connected: state === 'connected' || state === 'ended', propertyId: 'property-1', expiresAt: '2026-09-29T10:10:00Z', dispatchAuthorizedAt: '2026-09-29T10:00:01Z', callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null, ...extra },
});

function iframeOf(container: HTMLElement): HTMLIFrameElement {
  return container.querySelector('iframe')!;
}

function fromDialpad(iframe: HTMLIFrameElement, data: unknown, overrides: { origin?: string; source?: Window | null } = {}) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data,
      origin: overrides.origin ?? 'https://dialpad.com',
      source: overrides.source === undefined ? iframe.contentWindow : overrides.source,
    }));
  });
}

const authMessage = (userId: unknown, authenticated = true) => ({ api: 'opencti_dialpad', version: '1.0', method: 'user_authentication', payload: { user_authenticated: authenticated, user_id: userId } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.recent.mockResolvedValue({ ok: true, calls: [] });
  mocks.targets.mockResolvedValue({ ok: true, contactId: 'contact-1', phones: [{ slot: 1, masked: '••• ••• 0196' }, { slot: 2, masked: '••• ••• 0142' }], grants: [] });
  mocks.status.mockResolvedValue(status('awaiting_provider'));
  mocks.cancel.mockResolvedValue({ ok: true });
});

async function readyPanel(props: Partial<React.ComponentProps<typeof DialpadPanel>> = {}) {
  const onLogOutcome = vi.fn();
  const view = render(<DialpadPanel bootstrap={verifiedBootstrap} callRequest={null} onLogOutcome={onLogOutcome} pollMs={15} {...props} />);
  const iframe = iframeOf(view.container);
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
  return { view, iframe, post, onLogOutcome };
}

describe('DialpadPanel embedding', () => {
  it('embeds the documented Mini Dialer iframe', () => {
    const { container } = render(<DialpadPanel bootstrap={verifiedBootstrap} callRequest={null} onLogOutcome={vi.fn()} />);
    const iframe = iframeOf(container);
    expect(iframe).toHaveAttribute('src', 'https://dialpad.com/apps/open');
    expect(iframe.getAttribute('allow')).toContain('microphone');
    expect(iframe.getAttribute('sandbox')).toBe('allow-popups allow-scripts allow-same-origin allow-forms');
  });
  it('renders nothing when the connection does not allow the fixed Dialpad origin', () => {
    const { container } = render(<DialpadPanel bootstrap={{ ...verifiedBootstrap, allowedOrigins: ['https://example.com'] }} callRequest={null} onLogOutcome={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DialpadPanel trusted binding', () => {
  it('verifies an unbound rep through the server only after a message from the iframe on an allowed origin', async () => {
    mocks.verify.mockResolvedValue({ ok: true, dialpadUserId: '5551234', replayed: false });
    const { iframe } = await readyPanel({ bootstrap: unboundBootstrap });
    expect(screen.getByRole('status')).toHaveTextContent('Sign in to Dialpad');
    fromDialpad(iframe, authMessage(5551234), { origin: 'https://evil.example' });
    fromDialpad(iframe, authMessage(5551234), { source: window });
    fromDialpad(iframe, authMessage(5551234), { source: null });
    expect(mocks.verify).not.toHaveBeenCalled();
    fromDialpad(iframe, authMessage(5551234));
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(1));
    expect(mocks.verify).toHaveBeenCalledWith('5551234');
    await waitFor(() => expect(screen.queryByText(/not verified/)).not.toBeInTheDocument());
  });
  it('shows the server refusal and lets the rep retry', async () => {
    mocks.verify.mockResolvedValueOnce({ ok: false, code: 'identity_mismatch', reason: 'email_mismatch', message: 'That Dialpad account does not match your Sandra sign-in.' });
    mocks.verify.mockResolvedValueOnce({ ok: true, dialpadUserId: '5551234', replayed: false });
    const { iframe } = await readyPanel({ bootstrap: unboundBootstrap });
    fromDialpad(iframe, authMessage(5551234));
    expect(await screen.findByText(/does not match your Sandra sign-in/)).toBeInTheDocument();
    fromDialpad(iframe, authMessage(5551234));
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(2));
  });
  it('blocks calling when the dialer is signed in as someone other than the bound user', async () => {
    mocks.start.mockResolvedValue({ ok: false, code: 'unavailable', message: 'x' });
    const { iframe } = await readyPanel({ callRequest: request });
    fromDialpad(iframe, authMessage(7770001));
    expect(await screen.findByText(/different user/)).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Call' });
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('sends enable_current_tab to the fixed origin once the bound user is signed in', async () => {
    const { iframe, post } = await readyPanel();
    fromDialpad(iframe, authMessage(5551234));
    await waitFor(() => expect(post).toHaveBeenCalledWith({ api: 'opencti_dialpad', version: '1.0', method: 'enable_current_tab' }, 'https://dialpad.com'));
    fromDialpad(iframe, authMessage(5551234));
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('DialpadPanel dialing', () => {
  it('requires an explicit user gesture before preparing recording for a connected call', async () => {
    mocks.recent.mockResolvedValue({ ok: true, calls: [status('connected').status] });
    await readyPanel({ bootstrap: recordingBootstrap });
    expect(await screen.findByRole('button', { name: 'Prepare recording' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start recording' })).not.toBeInTheDocument();
  });

  async function chooseAndCall(props: Partial<React.ComponentProps<typeof DialpadPanel>> = {}) {
    const ctx = await readyPanel({ callRequest: request, ...props });
    fromDialpad(ctx.iframe, authMessage(5551234));
    const call = await screen.findByRole('button', { name: 'Call' });
    await waitFor(() => expect(call).toBeEnabled());
    ctx.post.mockClear();
    return { ...ctx, call };
  }

  it('dials once with the server-released payload and reports only webhook-derived state', async () => {
    mocks.start.mockResolvedValue({ ok: true, dispatched: true, intentId: INTENT, expiresAt: '2026-09-29T10:10:00Z', dial: { phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, outboundCallerId: null } });
    const { post, call, onLogOutcome } = await chooseAndCall();
    await userEvent.click(call);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith({
      api: 'opencti_dialpad', version: '1.0', method: 'initiate_call',
      payload: { phone_number: '+18165440196', enable_current_tab: true, custom_data: TOKEN },
    }, 'https://dialpad.com');
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls[0]![0]).toMatchObject({ propertyId: 'property-1', contactId: 'contact-1', phoneSlot: 1, grantId: null });
    expect(mocks.start.mock.calls[0]![0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Waiting for Dialpad to confirm/)).toBeInTheDocument();
    expect(screen.queryByText(/Connected/)).not.toBeInTheDocument();

    mocks.status.mockResolvedValue(status('dialing'));
    expect(await screen.findByText(/Dialing. Not answered yet/)).toBeInTheDocument();
    expect(screen.queryByText(/Connected/)).not.toBeInTheDocument();
    mocks.status.mockResolvedValue(status('connected'));
    expect(await screen.findByText(/Connected. Confirmed by Dialpad/)).toBeInTheDocument();
    mocks.status.mockResolvedValue(status('ended', { durationSeconds: 64, endedAt: '2026-09-29T10:01:10Z', callActivityId: 'activity-1' }));
    expect(await screen.findByText(/Call ended. 1m 04s/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log outcome' }));
    expect(onLogOutcome).toHaveBeenCalledWith('property-1', 'activity-1');
  });
  it('a double click sends a single start request with one idempotency key', async () => {
    let release!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { call, post } = await chooseAndCall();
    fireEvent.click(call);
    fireEvent.click(call);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    release({ ok: true, dispatched: true, intentId: INTENT, expiresAt: 'x', dial: { phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, outboundCallerId: null } });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });
  it('a retry after a lost response reuses the key and cannot dial when the server says it already released', async () => {
    mocks.start.mockRejectedValueOnce(new Error('network'));
    mocks.start.mockResolvedValueOnce({ ok: true, dispatched: false, intentId: INTENT });
    const { call, post } = await chooseAndCall();
    await userEvent.click(call);
    expect(await screen.findByText(/Do not dial from the panel/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Call' }));
    expect(await screen.findByText(/already sent to Dialpad/)).toBeInTheDocument();
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.start.mock.calls[1]![0].idempotencyKey).toBe(mocks.start.mock.calls[0]![0].idempotencyKey);
    expect(post).not.toHaveBeenCalled();
  });
  it('shows a server denial and never posts to the dialer', async () => {
    mocks.start.mockResolvedValue({ ok: false, code: 'denied', message: 'That phone number is on the Do Not Call list.', denial: 'phone_dnc' });
    const { call, post } = await chooseAndCall();
    await userEvent.click(call);
    expect(await screen.findByRole('alert')).toHaveTextContent('Do Not Call');
    expect(post).not.toHaveBeenCalled();
  });
  it('cancels the released intent when the dialer window cannot be posted to', async () => {
    mocks.start.mockResolvedValue({ ok: true, dispatched: true, intentId: INTENT, expiresAt: 'x', dial: { phoneNumber: '+18165440196', customData: TOKEN, identityType: 'Office', identityId: 9007199254740993, outboundCallerId: null } });
    const { call, post } = await chooseAndCall();
    await userEvent.click(call);
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(post).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was dialed');
  });
  it('sends the selected phone slot and caller id grant', async () => {
    mocks.targets.mockResolvedValue({ ok: true, contactId: 'contact-1', phones: [{ slot: 1, masked: 'a' }, { slot: 2, masked: 'b' }], grants: [{ id: 'g1', callerNumberE164: '+18165550100', identityType: null }, { id: 'g2', callerNumberE164: '+18165550101', identityType: 'Office' }] });
    mocks.start.mockResolvedValue({ ok: false, code: 'unavailable', message: 'nope' });
    const { call } = await chooseAndCall();
    await userEvent.click(screen.getByLabelText(/Phone 2/));
    await userEvent.selectOptions(screen.getByLabelText('Caller ID'), 'g2');
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.start.mock.calls[0]![0]).toMatchObject({ phoneSlot: 2, grantId: 'g2' });
  });
  it('explains a lead with no contact or phone', async () => {
    mocks.targets.mockResolvedValue({ ok: false, code: 'denied', message: 'This lead is not available for calling by you.' });
    await readyPanel({ callRequest: request });
    expect(await screen.findByRole('alert')).toHaveTextContent('not available for calling');
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });
});

describe('DialpadPanel authorization race', () => {
  const released = { ok: true, dispatched: true, intentId: INTENT, expiresAt: 'x', dial: { phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, outboundCallerId: null } };
  async function inFlight() {
    let release!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const ctx = await readyPanel({ callRequest: request });
    fromDialpad(ctx.iframe, authMessage(5551234));
    const call = await screen.findByRole('button', { name: 'Call' });
    await waitFor(() => expect(call).toBeEnabled());
    ctx.post.mockClear();
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    return { ...ctx, release: () => release(released) };
  }
  const initiateCalls = (post: { mock: { calls: unknown[][] } }) => post.mock.calls.filter(([message]) => (message as { method?: string }).method === 'initiate_call');

  it('posts nothing and cancels the unsent authorization when the dialer signs out during the request', async () => {
    const { iframe, post, release } = await inFlight();
    fromDialpad(iframe, authMessage(null, false));
    release();
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(initiateCalls(post)).toHaveLength(0);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was dialed');
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });
  it('posts nothing when the dialer switches to another user during the request', async () => {
    const { iframe, post, release } = await inFlight();
    fromDialpad(iframe, authMessage(7770001));
    release();
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(initiateCalls(post)).toHaveLength(0);
  });
  it('posts nothing when the dialer signs out and back in as the same user during the request', async () => {
    const { iframe, post, release } = await inFlight();
    fromDialpad(iframe, authMessage(null, false));
    fromDialpad(iframe, authMessage(5551234));
    release();
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(initiateCalls(post)).toHaveLength(0);
  });
  it('still dials when the dialer repeats the same authentication during the request', async () => {
    const { iframe, post, release } = await inFlight();
    fromDialpad(iframe, authMessage(5551234));
    release();
    await waitFor(() => expect(initiateCalls(post)).toHaveLength(1));
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('posts nothing and cancels when the panel unmounts during the request', async () => {
    const { view, post, release } = await inFlight();
    view.unmount();
    release();
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(initiateCalls(post)).toHaveLength(0);
  });
  it('requires a fresh user start with a new idempotency key after a blocked authorization', async () => {
    const { iframe, release } = await inFlight();
    const firstKey = mocks.start.mock.calls[0]![0].idempotencyKey;
    fromDialpad(iframe, authMessage(null, false));
    release();
    await screen.findByRole('alert');
    fromDialpad(iframe, authMessage(5551234));
    mocks.start.mockResolvedValue(released);
    const call = screen.getByRole('button', { name: 'Call' });
    await waitFor(() => expect(call).toBeEnabled());
    expect(mocks.start).toHaveBeenCalledTimes(1);
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(mocks.start.mock.calls[1]![0].idempotencyKey).not.toBe(firstKey);
  });
});

describe('DialpadPanel durability', () => {
  it('resumes recent calls after a reload and offers Log outcome for an ended call', async () => {
    mocks.recent.mockResolvedValue({ ok: true, calls: [status('ended', { durationSeconds: 125, callActivityId: 'activity-1' }).status] });
    const { onLogOutcome } = await readyPanel();
    expect(await screen.findByText(/Call ended. 2m 05s/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log outcome' }));
    expect(onLogOutcome).toHaveBeenCalledWith('property-1', 'activity-1');
  });
  it('gives each completed call on the same lead its own Log outcome button with its exact call activity', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    mocks.recent.mockResolvedValue({ ok: true, calls: [
      { ...status('ended', { callActivityId: 'activity-new' }).status, intentId: other },
      status('ended', { callActivityId: 'activity-old' }).status,
    ] });
    const { onLogOutcome } = await readyPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Log outcome' });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    expect(onLogOutcome).toHaveBeenLastCalledWith('property-1', 'activity-old');
    await userEvent.click(buttons[0]!);
    expect(onLogOutcome).toHaveBeenLastCalledWith('property-1', 'activity-new');
  });
  it('does not offer Log outcome for an ended call with no projected call activity', async () => {
    mocks.recent.mockResolvedValue({ ok: true, calls: [status('ended').status] });
    await readyPanel();
    expect(await screen.findByText(/Call ended/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log outcome' })).not.toBeInTheDocument();
  });
  it('says an ended call that never connected was not answered, and a dialing call is not connected', async () => {
    mocks.recent.mockResolvedValue({ ok: true, calls: [status('ended', { connected: false, callActivityId: 'a' }).status] });
    await readyPanel();
    expect(await screen.findByText(/Call ended. Not answered./)).toBeInTheDocument();
  });
  it('keeps polling an in-flight call and stops once it ends', async () => {
    mocks.recent.mockResolvedValue({ ok: true, calls: [status('awaiting_provider').status] });
    mocks.status.mockResolvedValue(status('ended', { durationSeconds: 10 }));
    await readyPanel();
    expect(await screen.findByText(/Call ended/)).toBeInTheDocument();
    const calls = mocks.status.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mocks.status.mock.calls.length).toBe(calls);
  });
});
