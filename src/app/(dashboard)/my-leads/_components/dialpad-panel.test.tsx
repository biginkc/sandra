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
  createProof: vi.fn(),
  createMediaOwner: vi.fn(),
  releaseMediaOwner: vi.fn(),
  prepareCapture: vi.fn(),
  createSession: vi.fn(),
  openCapture: vi.fn(),
  closeCapture: vi.fn(),
  recordingStatus: vi.fn(),
  mintRecording: vi.fn(),
  captures: [] as { active: { state: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }; prepared: { startLocal: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> } }[],
  lastSessionOptions: null as Record<string, unknown> | null,
}));

vi.mock('../dialpad-actions', () => ({
  verifyDialpadBindingAction: mocks.verify,
  listDialpadCallTargetsAction: mocks.targets,
  startDialpadCallAction: mocks.start,
  getDialpadCallStatusAction: mocks.status,
  cancelDialpadCallAction: mocks.cancel,
  listRecentDialpadCallsAction: mocks.recent,
}));

vi.mock('@/lib/dialpad-recording/browser-capture', () => ({
  createSandraCaptureHandleProof: mocks.createProof,
  createDialpadCaptureSourceSession: mocks.createMediaOwner,
  prepareDialpadBrowserCapture: mocks.prepareCapture,
}));

vi.mock('@/lib/dialpad-recording/browser-session', () => ({
  createDialpadBrowserSession: mocks.createSession,
}));

vi.mock('../dialpad-recording-actions', () => ({
  openDialpadRecordingCaptureAction: mocks.openCapture,
  closeDialpadRecordingCaptureAction: mocks.closeCapture,
  getDialpadRecordingBrowserStatusAction: mocks.recordingStatus,
  mintDialpadRecordingNextEpochAction: mocks.mintRecording,
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
const released = { ok: true, dispatched: true, intentId: INTENT, expiresAt: 'x', dial: { phoneNumber: '+18165440196', customData: TOKEN, identityType: null, identityId: null, outboundCallerId: null } };

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
  mocks.captures.length = 0;
  mocks.lastSessionOptions = null;
  mocks.createProof.mockReturnValue({ handle: 'handle', origin: 'https://sandra.example' });
  mocks.createMediaOwner.mockImplementation(({ proof }) => ({ proof, acquire: async () => ({ invalidate: vi.fn(), release: vi.fn() }), dispose: mocks.releaseMediaOwner }));
  mocks.recent.mockResolvedValue({ ok: true, calls: [] });
  mocks.targets.mockResolvedValue({ ok: true, contactId: 'contact-1', phones: [{ slot: 1, masked: '••• ••• 0196' }, { slot: 2, masked: '••• ••• 0142' }], grants: [] });
  mocks.status.mockResolvedValue(status('awaiting_provider'));
  mocks.cancel.mockResolvedValue({ ok: true });
  mocks.openCapture.mockResolvedValue({ ok: true, capture: { captureId: 'capture-1' } });
  mocks.recordingStatus.mockResolvedValue({ ok: true, status: { latestConsumedEpoch: 0, captureStatus: 'open', totalSamples: 0, measurementStatus: 'provisional' } });
  mocks.mintRecording.mockResolvedValue({ ok: true, token: 'recording-token', epoch: 1, ingestEndpoint: 'wss://recording.example.test/dialpad-browser-ingest', controlVersion: 2 });
  mocks.closeCapture.mockResolvedValue({ ok: true });
  mocks.prepareCapture.mockImplementation(async () => {
    const active = { state: vi.fn(() => 'recording'), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const prepared = { startLocal: vi.fn(async () => active), dispose: vi.fn(async () => undefined) };
    mocks.captures.push({ active, prepared });
    return { proof: { handle: 'handle', origin: 'https://sandra.example' }, start: vi.fn(), startLocal: prepared.startLocal, dispose: prepared.dispose };
  });
  mocks.createSession.mockImplementation((options: Record<string, unknown>) => {
    mocks.lastSessionOptions = options;
    return { state: vi.fn(() => 'recording'), start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
  });
});

async function readyPanel(props: Partial<React.ComponentProps<typeof DialpadPanel>> = {}) {
  const onLogOutcome = vi.fn();
  const view = render(<DialpadPanel bootstrap={verifiedBootstrap} callRequest={null} onLogOutcome={onLogOutcome} pollMs={15} {...props} />);
  const iframe = iframeOf(view.container);
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
  return { view, iframe, post, onLogOutcome };
}

async function chooseAndCall(props: Partial<React.ComponentProps<typeof DialpadPanel>> = {}) {
  const ctx = await readyPanel({ callRequest: request, ...props });
  fromDialpad(ctx.iframe, authMessage(5551234));
  const call = await screen.findByRole('button', { name: 'Call' });
  await waitFor(() => expect(call).toBeEnabled());
  ctx.post.mockClear();
  return { ...ctx, call };
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

describe('DialpadPanel recording capture', () => {
  it('releases shared audio without claiming that the provider call ended', async () => {
    mocks.start.mockResolvedValue(released);
    const { call, view } = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/nothing is recorded between calls/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop sharing audio' }));
    expect(mocks.releaseMediaOwner).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(screen.getByText('Calling. Waiting for Dialpad to confirm.')).toBeInTheDocument();
    view.unmount();
  });

  it('requires capture permission before dispatch and keeps the chooser retryable after denial', async () => {
    mocks.prepareCapture.mockRejectedValueOnce(new Error('Microphone permission was denied.'));
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(call);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone permission was denied');
    mocks.start.mockResolvedValue(released);
    await userEvent.click(screen.getByRole('button', { name: 'Call' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  });

  it('starts local capture exactly once before dispatching the provider call', async () => {
    mocks.start.mockResolvedValue(released);
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.prepareCapture).toHaveBeenCalledTimes(1);
    expect(mocks.captures[0]?.prepared.startLocal).toHaveBeenCalledTimes(1);
    expect(mocks.captures[0]!.prepared.startLocal.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
  });

  it('attaches the explicitly armed capture after the provider reports connected', async () => {
    mocks.start.mockResolvedValue(released);
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 15 });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Start recording' })).not.toBeInTheDocument();
    expect(screen.getByText('Recording starts automatically when Dialpad confirms the connection.')).toBeInTheDocument();
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(mocks.lastSessionOptions?.capture).toBe(mocks.captures[0]?.active);
    expect(mocks.lastSessionOptions?.enableTiming).toBe(false);
    expect(mocks.captures[0]?.prepared.startLocal).toHaveBeenCalledTimes(1);
  });

  it('reconciles server-driven recording completion without declaring the call ended', async () => {
    mocks.start.mockResolvedValue(released);
    mocks.status.mockResolvedValue(status('connected'));
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 15 });
    await userEvent.click(call);
    await screen.findByRole('button', { name: 'End recording' });
    mocks.status.mockResolvedValue({ ok: false, code: 'unavailable', message: 'Temporarily unavailable' });
    mocks.recordingStatus.mockResolvedValue({ ok: true, status: { captureStatus: 'sealed', totalSamples: 0, measurementStatus: 'final', finalResult: { status: 'ineligible', reasons: ['below_threshold'] } } });
    act(() => { (mocks.lastSessionOptions?.onStopped as (() => void) | undefined)?.(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'End recording' })).not.toBeInTheDocument());
    expect(await screen.findByText('Recording verified: below the five-minute seller-speech threshold.')).toBeInTheDocument();
    expect(screen.getByText('Connected. Confirmed by Dialpad.')).toBeInTheDocument();
    expect(mocks.closeCapture).not.toHaveBeenCalled();
  });

  it('passes timing only when the server rollout explicitly enables it', async () => {
    mocks.start.mockResolvedValue(released);
    const { call } = await chooseAndCall({
      bootstrap: { ...recordingBootstrap, recording: { ...recordingBootstrap.recording!, timingEnabled: true } },
      pollMs: 15,
    });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(mocks.lastSessionOptions?.enableTiming).toBe(true);
  });

  it('does not post an authorized call when local capture becomes interrupted before dispatch', async () => {
    mocks.start.mockImplementation(async () => {
      mocks.captures[0]?.active.state.mockReturnValue('interrupted');
      return released;
    });
    const { call, post } = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(post.mock.calls.filter(([message]) => (message as { method?: string }).method === 'initiate_call')).toHaveLength(0);
  });

  it('ignores a permission result after the chooser is replaced by another lead', async () => {
    let releasePrepare!: (value: unknown) => void;
    mocks.prepareCapture.mockReturnValue(new Promise((resolve) => { releasePrepare = resolve; }));
    const ctx = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(ctx.call);
    await waitFor(() => expect(mocks.prepareCapture).toHaveBeenCalledTimes(1));
    const nextRequest = { ...request, nonce: 2, propertyId: 'property-2', label: 'Next homeowner' };
    ctx.view.rerender(<DialpadPanel bootstrap={recordingBootstrap} callRequest={nextRequest} onLogOutcome={ctx.onLogOutcome} pollMs={15} />);
    releasePrepare({ proof: { handle: 'handle', origin: 'https://sandra.example' }, start: vi.fn(), startLocal: vi.fn(), dispose: vi.fn(async () => undefined) });
    await waitFor(() => expect(screen.getByText('Next homeowner')).toBeInTheDocument());
    expect(mocks.start).not.toHaveBeenCalled();
    expect(ctx.post.mock.calls.filter(([message]) => (message as { method?: string }).method === 'initiate_call')).toHaveLength(0);

    const active = { state: vi.fn(() => 'recording'), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const prepared = { startLocal: vi.fn(async () => active), dispose: vi.fn(async () => undefined) };
    mocks.prepareCapture.mockResolvedValueOnce({ proof: { handle: 'handle', origin: 'https://sandra.example' }, start: vi.fn(), startLocal: prepared.startLocal, dispose: prepared.dispose });
    mocks.start.mockResolvedValue(released);
    await userEvent.click(screen.getByRole('button', { name: 'Call' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  });

  it('clears an owned preparation when the chooser is replaced during local capture start', async () => {
    let releaseStartLocal!: (value: unknown) => void;
    const oldActive = { state: vi.fn(() => 'recording'), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const oldPrepared = { startLocal: vi.fn(() => new Promise((resolve) => { releaseStartLocal = resolve; })), dispose: vi.fn(async () => undefined) };
    mocks.prepareCapture.mockResolvedValueOnce({ proof: { handle: 'handle', origin: 'https://sandra.example' }, start: vi.fn(), startLocal: oldPrepared.startLocal, dispose: oldPrepared.dispose });
    const ctx = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(ctx.call);
    await waitFor(() => expect(oldPrepared.startLocal).toHaveBeenCalledTimes(1));

    const nextRequest = { ...request, nonce: 4, propertyId: 'property-4', label: 'Start replacement homeowner' };
    ctx.view.rerender(<DialpadPanel bootstrap={recordingBootstrap} callRequest={nextRequest} onLogOutcome={ctx.onLogOutcome} pollMs={15} />);
    releaseStartLocal(oldActive);
    await waitFor(() => expect(screen.getByText('Start replacement homeowner')).toBeInTheDocument());

    const active = { state: vi.fn(() => 'recording'), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    const prepared = { startLocal: vi.fn(async () => active), dispose: vi.fn(async () => undefined) };
    mocks.prepareCapture.mockResolvedValueOnce({ proof: { handle: 'handle', origin: 'https://sandra.example' }, start: vi.fn(), startLocal: prepared.startLocal, dispose: prepared.dispose });
    mocks.start.mockResolvedValue(released);
    await userEvent.click(screen.getByRole('button', { name: 'Call' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  });

  it('cancels an old authorization when the chooser is replaced while dispatch is pending', async () => {
    let releaseStart!: (value: unknown) => void;
    mocks.start.mockReturnValue(new Promise((resolve) => { releaseStart = resolve; }));
    const ctx = await chooseAndCall({ bootstrap: recordingBootstrap });
    await userEvent.click(ctx.call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    const nextRequest = { ...request, nonce: 3, propertyId: 'property-3', label: 'Replacement homeowner' };
    ctx.view.rerender(<DialpadPanel bootstrap={recordingBootstrap} callRequest={nextRequest} onLogOutcome={ctx.onLogOutcome} pollMs={15} />);
    releaseStart(released);
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(INTENT));
    expect(ctx.post.mock.calls.filter(([message]) => (message as { method?: string }).method === 'initiate_call')).toHaveLength(0);
    expect(screen.getByText('Replacement homeowner')).toBeInTheDocument();
  });

  it('requires a fresh Prepare gesture after session failure and does not remint automatically', async () => {
    mocks.start.mockResolvedValue(released);
    mocks.createSession.mockImplementationOnce((options: Record<string, unknown>) => {
      mocks.lastSessionOptions = options;
      return { state: vi.fn(() => 'failed'), start: vi.fn(async () => { throw new Error('transport failed'); }), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    });
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 15 });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(mocks.mintRecording).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare again' })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mocks.mintRecording).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Prepare again' }));
    await waitFor(() => expect(mocks.mintRecording).toHaveBeenCalledTimes(2));
  });

  it('does not rearm capture after an explicit End recording while the provider remains connected', async () => {
    mocks.start.mockResolvedValue(released);
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 15 });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'End recording' })).toBeInTheDocument());
    mocks.status.mockResolvedValue(status('ended'));
    await waitFor(() => expect(mocks.closeCapture).toHaveBeenCalledWith('capture-1'));
    const sessions = mocks.createSession.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(mocks.createSession).toHaveBeenCalledTimes(sessions);
  });

  it('stops a hung recording status request at the real deadline and ignores its late result', async () => {
    mocks.start.mockResolvedValue(released);
    mocks.createSession.mockImplementationOnce((options: Record<string, unknown>) => {
      mocks.lastSessionOptions = options;
      return { state: vi.fn(() => 'failed'), start: vi.fn(async () => { throw new Error('transport failed'); }), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) };
    });
    mocks.recordingStatus.mockResolvedValueOnce({ ok: true, status: { latestConsumedEpoch: 0, captureStatus: 'open', totalSamples: 0, measurementStatus: 'provisional' } });
    mocks.recordingStatus.mockImplementation(() => new Promise(() => undefined));
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 5, recordingStatusDeadlineMs: 20 });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(mocks.createSession).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/status did not settle before the deadline/)).toBeInTheDocument();
    expect(mocks.recordingStatus).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed reload hydration replace an owned active capture', async () => {
    let resolveRecent!: (value: unknown) => void;
    mocks.recent.mockReturnValue(new Promise((resolve) => { resolveRecent = resolve; }));
    mocks.start.mockResolvedValue(released);
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 5 });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'End recording' })).toBeInTheDocument());
    resolveRecent({ ok: true, calls: [status('ended', { recordingCaptureId: 'stale-capture' }).status] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByRole('button', { name: 'End recording' })).toBeInTheDocument();
    expect(mocks.recordingStatus).not.toHaveBeenCalledWith('stale-capture');
  });

  it('does not start the finalization deadline while a long provider session is live', async () => {
    mocks.start.mockResolvedValue(released);
    mocks.recordingStatus
      .mockResolvedValueOnce({ ok: true, status: { latestConsumedEpoch: 0, captureStatus: 'open', totalSamples: 0, measurementStatus: 'provisional' } })
      .mockResolvedValueOnce({ ok: true, status: { latestConsumedEpoch: 1, captureStatus: 'partial', totalSamples: 4_800_001, measurementStatus: 'partial', finalResult: null } })
      .mockResolvedValue({ ok: true, status: { latestConsumedEpoch: 1, captureStatus: 'sealed', totalSamples: 4_800_001, measurementStatus: 'finalized', finalResult: { status: 'eligible', observedSamples: 4_800_001, eligibleSamples: 4_800_001, reasons: ['eligible'], evaluatedAt: '2026-09-29T15:00:00.000Z' } } });
    const { call } = await chooseAndCall({ bootstrap: recordingBootstrap, pollMs: 5, recordingStatusDeadlineMs: 20 });
    await userEvent.click(call);
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    mocks.status.mockResolvedValue(status('connected'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'End recording' })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(screen.queryByText(/status did not settle before the deadline/)).not.toBeInTheDocument();
    mocks.status.mockResolvedValue(status('ended'));
    await waitFor(() => expect(mocks.closeCapture).toHaveBeenCalledWith('capture-1'));
    expect(await screen.findByText(/Verified seller speech: 300s/)).toBeInTheDocument();
  });
});

describe('DialpadPanel authorization race', () => {
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
  it('hydrates a durable recording result after reload and notifies the KPI refresh owner once', async () => {
    const onRecordingFinalResult = vi.fn();
    mocks.recent.mockResolvedValue({ ok: true, calls: [status('ended', { recordingCaptureId: 'capture-9' }).status] });
    mocks.recordingStatus.mockResolvedValue({ ok: true, status: {
      captureId: 'capture-9', captureStatus: 'sealed', totalSamples: 4_800_001, measurementStatus: 'finalized',
      crossing: null, finalResult: { status: 'eligible', observedSamples: 4_800_001, eligibleSamples: 4_800_001, reasons: ['eligible'], evaluatedAt: '2026-09-29T15:00:00.000Z' },
    } });
    await readyPanel({ onRecordingFinalResult });
    expect(await screen.findByText(/Verified seller speech: 300s/)).toBeInTheDocument();
    expect(mocks.recordingStatus).toHaveBeenCalledWith('capture-9');
    await waitFor(() => expect(onRecordingFinalResult).toHaveBeenCalledTimes(1));
  });

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
