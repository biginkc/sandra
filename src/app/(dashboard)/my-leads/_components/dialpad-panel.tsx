'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { DialpadCallStatus } from '@/lib/dialpad-cti/contracts';
import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
import {
  createSandraCaptureHandleProof,
  prepareDialpadBrowserCapture,
  type ActiveDialpadCapture,
  type PreparedDialpadCapture,
} from '@/lib/dialpad-recording/browser-capture';
import { createDialpadBrowserSession, type DialpadBrowserSession } from '@/lib/dialpad-recording/browser-session';
import {
  buildEnableCurrentTabMessage,
  buildInitiateCallMessage,
  DIALPAD_CTI_IFRAME_ALLOW,
  DIALPAD_CTI_IFRAME_SANDBOX,
  DIALPAD_CTI_IFRAME_SRC,
  isDialpadTargetOriginConfigured,
  parseDialpadIncomingMessage,
  postToDialpad,
} from '@/lib/dialpad-cti/protocol';

import {
  cancelDialpadCallAction,
  getDialpadCallStatusAction,
  listDialpadCallTargetsAction,
  listRecentDialpadCallsAction,
  startDialpadCallAction,
  verifyDialpadBindingAction,
} from '../dialpad-actions';
import {
  closeDialpadRecordingCaptureAction,
  getDialpadRecordingBrowserStatusAction,
  mintDialpadRecordingNextEpochAction,
  openDialpadRecordingCaptureAction,
} from '../dialpad-recording-actions';

export interface DialpadCallRequest {
  nonce: number;
  propertyId: string;
  contactId: string | null;
  label: string;
}

type Props = {
  bootstrap: DialpadPanelBootstrap;
  callRequest: DialpadCallRequest | null;
  onLogOutcome: (propertyId: string, callActivityId: string) => void;
  onCallRequestHandled?: (nonce: number) => void;
  pollMs?: number;
};

type Targets = {
  contactId: string;
  phones: { slot: 1 | 2 | 3; masked: string }[];
  grants: DialpadPanelBootstrap['grants'];
};

type Chooser = {
  request: DialpadCallRequest;
  idempotencyKey: string;
  targets: Targets | null;
  error: string | null;
  slot: 1 | 2 | 3 | null;
  grantId: string;
  busy: boolean;
  notice: string | null;
};

type RecordingPanelState = {
  intentId: string;
  prepared: PreparedDialpadCapture | null;
  active: ActiveDialpadCapture | null;
  captureId: string | null;
  session: DialpadBrowserSession | null;
  busy: boolean;
  message: string | null;
  measuredSamples: number | null;
  measurementStatus: 'provisional' | 'partial' | 'finalized' | null;
};

const ACTIVE_STATES: ReadonlySet<string> = new Set(['prepared', 'awaiting_provider', 'dialing', 'connected']);

const STATE_LABEL: Record<DialpadCallStatus['state'], string> = {
  prepared: 'Preparing',
  awaiting_provider: 'Calling. Waiting for Dialpad to confirm.',
  dialing: 'Dialing. Not answered yet.',
  connected: 'Connected. Confirmed by Dialpad.',
  ended: 'Call ended.',
  cancelled: 'Cancelled. Nothing was dialed.',
  expired: 'No confirmation from Dialpad. Check the dialer before calling again.',
};

function duration(seconds: number | null): string {
  if (seconds === null) return '';
  const minutes = Math.floor(seconds / 60);
  return ` ${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function DialpadPanel({ bootstrap, callRequest, onLogOutcome, onCallRequestHandled, pollMs = 3000 }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const originOk = isDialpadTargetOriginConfigured(bootstrap.allowedOrigins);
  const [iframeUser, setIframeUser] = useState<string | null>(null);
  const [binding, setBinding] = useState(bootstrap.binding);
  const [verify, setVerify] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [calls, setCalls] = useState<DialpadCallStatus[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState<RecordingPanelState | null>(null);
  const recordingRef = useRef<RecordingPanelState | null>(null);
  const attemptedUser = useRef<string | null>(null);
  const enabledTab = useRef(false);
  const startFired = useRef<string | null>(null);
  // Live view of who the Dialpad iframe is signed in as. authGeneration bumps on every change (sign-out, switch, sign-in),
  // so an authorization obtained under one sign-in can never be posted under another.
  const iframeUserRef = useRef<string | null>(null);
  const authGeneration = useRef(0);
  const bindingRef = useRef(bootstrap.binding);
  const mountedRef = useRef(false);
  const recordingGenerationRef = useRef(0);
  const recordingStartRef = useRef<string | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const callsRef = useRef(calls);
  useEffect(() => { callsRef.current = calls; }, [calls]);
  const [labelledRequest, setLabelledRequest] = useState<DialpadCallRequest | null>(null);
  if (callRequest !== labelledRequest) {
    setLabelledRequest(callRequest ?? null);
    if (callRequest) {
      setLabels((current) => ({ ...current, [callRequest.propertyId]: callRequest.label }));
      setChooser({
        request: callRequest,
        idempotencyKey: crypto.randomUUID(),
        targets: null,
        error: callRequest.contactId ? null : 'This lead has no contact to call.',
        slot: null,
        grantId: '',
        busy: false,
        notice: null,
      });
    }
  }

  useEffect(() => { bindingRef.current = binding; }, [binding]);

  const canDial = binding.status === 'verified' && iframeUser !== null && iframeUser === binding.dialpadUserId;

  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => () => {
    const current = recordingRef.current;
    void (current?.session ? current.session.dispose() : current?.active ? current.active.dispose() : current?.prepared?.dispose());
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const parsed = parseDialpadIncomingMessage(event, {
        iframeWindow: iframeRef.current?.contentWindow ?? null,
        allowedOrigins: bootstrap.allowedOrigins,
      });
      if (parsed.kind === 'user_authentication') {
        const next = parsed.authenticated ? parsed.userId : null;
        if (next !== iframeUserRef.current) {
          iframeUserRef.current = next;
          authGeneration.current += 1;
          recordingGenerationRef.current += 1;
          const current = recordingRef.current;
          if (current) void (current.session ? current.session.dispose() : current.active ? current.active.dispose() : current.prepared?.dispose());
          recordingRef.current = null;
          setRecording(null);
        }
        setIframeUser(next);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bootstrap.allowedOrigins]);

  const runVerify = useCallback(async (claimed: string) => {
    setVerify({ busy: true, message: null });
    try {
      const result = await verifyDialpadBindingAction(claimed);
      if (result.ok && 'dialpadUserId' in result) {
        setBinding({ status: 'verified', dialpadUserId: result.dialpadUserId });
        setVerify({ busy: false, message: null });
      } else {
        setVerify({ busy: false, message: result.ok ? 'Could not verify your Dialpad account.' : result.message });
      }
    } catch {
      setVerify({ busy: false, message: 'Could not verify your Dialpad account. Try again.' });
    }
  }, []);

  useEffect(() => {
    if (!originOk || !iframeUser || binding.status === 'verified' || attemptedUser.current === iframeUser) return;
    attemptedUser.current = iframeUser;
    void runVerify(iframeUser);
  }, [originOk, iframeUser, binding.status, runVerify]);

  useEffect(() => {
    if (!canDial) {
      enabledTab.current = false;
      return;
    }
    if (enabledTab.current) return;
    enabledTab.current = true;
    postToDialpad(iframeRef.current?.contentWindow, buildEnableCurrentTabMessage());
  }, [canDial]);

  useEffect(() => {
    let cancelled = false;
    void listRecentDialpadCallsAction().then((result) => {
      if (!cancelled && result.ok && 'calls' in result) setCalls(result.calls);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const active = callsRef.current.filter((call) => ACTIVE_STATES.has(call.state));
      for (const call of active) {
        void getDialpadCallStatusAction(call.intentId).then((result) => {
          if (!result.ok || !('status' in result)) return;
          const status = result.status;
          setCalls((current) => current.map((entry) => (entry.intentId === status.intentId ? status : entry)));
        }).catch(() => undefined);
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [pollMs]);

  useEffect(() => {
    if (!callRequest) return;
    const request = callRequest;
    let cancelled = false;
    if (!request.contactId) {
      onCallRequestHandled?.(request.nonce);
      return;
    }
    void listDialpadCallTargetsAction({ propertyId: request.propertyId, contactId: request.contactId }).then((result) => {
      if (cancelled) return;
      setChooser((current) => {
        if (current?.request !== request) return current;
        if (!result.ok || !('phones' in result)) return { ...current, error: result.ok ? 'Could not load phone numbers.' : result.message };
        const targets: Targets = { contactId: result.contactId, phones: result.phones, grants: result.grants };
        return {
          ...current,
          targets,
          slot: targets.phones[0]?.slot ?? null,
          grantId: targets.grants[0]?.id ?? '',
          error: targets.phones.length === 0 ? 'This contact has no phone number.' : null,
        };
      });
    }).catch(() => {
      if (!cancelled) setChooser((current) => (current?.request === request ? { ...current, error: 'Could not load phone numbers.' } : current));
    }).finally(() => onCallRequestHandled?.(request.nonce));
    return () => { cancelled = true; };
  }, [callRequest, onCallRequestHandled]);

  const startCall = async () => {
    const current = chooser;
    if (!current || !current.targets || current.slot === null || current.busy || !canDial) return;
    const generation = authGeneration.current;
    const stillDialable = () => {
      const bound = bindingRef.current;
      return mountedRef.current && authGeneration.current === generation && iframeUserRef.current !== null
        && bound.status === 'verified' && bound.dialpadUserId === iframeUserRef.current;
    };
    // One click, one key: a second click or a retry after a lost response re-sends the same key and can never dial again.
    if (startFired.current === current.idempotencyKey && !current.error) return;
    startFired.current = current.idempotencyKey;
    setChooser({ ...current, busy: true, error: null, notice: null });
    const pendingRecordingId = `pending:${current.idempotencyKey}`;
    if (bootstrap.recording) {
      const armed = await armRecording(pendingRecordingId, 'Capture ready. Waiting for Dialpad to confirm the call.');
      if (!armed || !mountedRef.current || !stillDialable()) {
        startFired.current = null;
        setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey ? { ...latest, busy: false, error: 'Recording permission is required before starting this call. Try again.' } : latest));
        return;
      }
    }
    let result: Awaited<ReturnType<typeof startDialpadCallAction>>;
    try {
      result = await startDialpadCallAction({
        propertyId: current.request.propertyId,
        contactId: current.targets.contactId,
        phoneSlot: current.slot,
        grantId: current.grantId || null,
        idempotencyKey: current.idempotencyKey,
      });
    } catch {
      const armed = recordingRef.current;
      if (armed?.intentId === pendingRecordingId && !armed.session) {
        await armed.active?.dispose();
        await armed.prepared?.dispose();
        if (mountedRef.current) setRecording(null);
      }
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, error: 'Sandra could not confirm the request. Do not dial from the panel. Try again to check.' }
        : latest));
      return;
    }
    if (!result.ok) {
      const armed = recordingRef.current;
      if (armed?.intentId === pendingRecordingId && !armed.session) {
        await armed.active?.dispose();
        await armed.prepared?.dispose();
        if (mountedRef.current) setRecording(null);
      }
      startFired.current = null;
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey ? { ...latest, busy: false, error: result.message } : latest));
      return;
    }
    if (!('dispatched' in result) || !result.dispatched) {
      const armed = recordingRef.current;
      if (armed?.intentId === pendingRecordingId && !armed.session) {
        await armed.active?.dispose();
        await armed.prepared?.dispose();
        if (mountedRef.current) setRecording(null);
      }
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, notice: 'This call was already sent to Dialpad. Check the dialer; start a new call if it did not ring.' }
        : latest));
      return;
    }
    if (!stillDialable()) {
      // The iframe user changed, signed out, or the panel went away while Sandra authorized: never post this authorization.
      void cancelDialpadCallAction(result.intentId).catch(() => undefined);
      if (mountedRef.current) {
        const armed = recordingRef.current;
        if (armed?.intentId === pendingRecordingId && !armed.session) {
          await armed.active?.dispose();
          await armed.prepared?.dispose();
          setRecording(null);
        }
        setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
          ? { ...latest, busy: false, idempotencyKey: crypto.randomUUID(), error: 'Your Dialpad sign-in changed while the call was starting. Nothing was dialed. Start the call again.' }
          : latest));
      }
      return;
    }
    let posted = false;
    try {
      posted = postToDialpad(iframeRef.current?.contentWindow, buildInitiateCallMessage(result.dial));
    } catch {
      posted = false;
    }
    if (!posted) {
      void cancelDialpadCallAction(result.intentId).catch(() => undefined);
      const armed = recordingRef.current;
      if (armed?.intentId === pendingRecordingId && !armed.session) {
        await armed.active?.dispose();
        await armed.prepared?.dispose();
        if (mountedRef.current) setRecording(null);
      }
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, error: 'The Dialpad dialer is not ready. Nothing was dialed. Start the call again.' }
        : latest));
      return;
    }
    const now = new Date().toISOString();
    const started: DialpadCallStatus = {
        intentId: result.intentId, state: 'awaiting_provider', connected: false, propertyId: current.request.propertyId, expiresAt: result.expiresAt, dispatchAuthorizedAt: now,
        callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null,
    };
    setCalls((existing) => [started, ...existing.filter((entry) => entry.intentId !== started.intentId)].slice(0, 5));
    setRecording((latest) => latest?.intentId === pendingRecordingId ? { ...latest, intentId: result.intentId, message: 'Capture ready. Waiting for Dialpad to confirm the call.' } : latest);
    setChooser(null);
  };

  const armRecording = async (intentId: string, message = 'Capture ready. Waiting for Dialpad to confirm the call.') => {
    const current = recordingRef.current;
    if (!bootstrap.recording || current?.busy) return false;
    if (current?.intentId === intentId && current.active && !current.session) return true;
    const generation = ++recordingGenerationRef.current;
    if (current?.session) await current.session.dispose();
    else if (current?.active) await current.active.dispose();
    else await current?.prepared?.dispose();
    if (!mountedRef.current || generation !== recordingGenerationRef.current) return false;
    setRecording({ intentId, prepared: null, active: null, captureId: null, session: null, busy: true, message: null, measuredSamples: null, measurementStatus: null });
    try {
      const mediaDevices = navigator.mediaDevices as MediaDevices & { setCaptureHandleConfig?: (config: { handle: string; exposeOrigin: boolean; permittedOrigins: readonly string[] }) => void };
      const proof = createSandraCaptureHandleProof({ origin: window.location.origin, setCaptureHandleConfig: mediaDevices.setCaptureHandleConfig?.bind(mediaDevices) });
      const prepared = await prepareDialpadBrowserCapture({ proof });
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await prepared.dispose(); return false; }
      if (!prepared.startLocal) throw new Error('This browser cannot start local capture before the call.');
      const active = await prepared.startLocal(1);
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await active.dispose(); await prepared.dispose(); return false; }
      setRecording({ intentId, prepared, active, captureId: null, session: null, busy: false, message, measuredSamples: null, measurementStatus: null });
      return true;
    } catch (error) {
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return false;
      setRecording({ intentId, prepared: null, active: null, captureId: null, session: null, busy: false, message: error instanceof Error ? error.message : 'Browser capture could not be prepared.', measuredSamples: null, measurementStatus: null });
      return false;
    }
  };

  const prepareRecording = async (call: DialpadCallStatus) => {
    await armRecording(call.intentId);
  };

  const startRecording = async (call: DialpadCallStatus) => {
    const current = recordingRef.current;
    if (!current?.active || current.intentId !== call.intentId || current.busy || !bootstrap.recording) return;
    if (recordingStartRef.current === call.intentId) return;
    recordingStartRef.current = call.intentId;
    const generation = ++recordingGenerationRef.current;
    const ownedPrepared = current.prepared;
    const ownedActive = current.active;
    let ownedSession: DialpadBrowserSession | null = null;
    let ownedCaptureId: string | null = null;
    const abandon = async () => {
      if (ownedSession) await ownedSession.dispose().catch(() => undefined);
      if (!ownedSession) await ownedActive.dispose().catch(() => undefined);
      await ownedPrepared?.dispose().catch(() => undefined);
    };
    setRecording({ ...current, busy: true, message: null });
    try {
      const opened = await openDialpadRecordingCaptureAction(call.intentId);
      if (!opened.ok || !('capture' in opened)) throw new Error(opened.message);
      const captureId = opened.capture.captureId;
      ownedCaptureId = captureId;
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      const status = await getDialpadRecordingBrowserStatusAction(captureId);
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      if (!status.ok || !('status' in status)) throw new Error(status.message);
      const grant = await mintDialpadRecordingNextEpochAction({ captureId, expectedConsumedEpoch: status.status.latestConsumedEpoch });
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      if (!grant.ok || !('token' in grant)) throw new Error(grant.message);
      const session = createDialpadBrowserSession({
        endpoint: grant.ingestEndpoint,
        token: grant.token,
        epoch: grant.epoch,
        capture: ownedActive,
        onSnapshot: (snapshot) => setRecording((latest) => latest?.intentId === call.intentId ? { ...latest, measuredSamples: snapshot.totalSamples, measurementStatus: snapshot.measurementStatus } : latest),
        onFailure: (failure) => setRecording((latest) => latest?.intentId === call.intentId ? { ...latest, prepared: null, active: null, session: null, busy: false, message: failure.message } : latest),
      });
      ownedSession = session;
      await session.start();
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      setRecording((latest) => latest?.intentId === call.intentId ? { ...latest, prepared: null, active: null, captureId, session, busy: false, message: 'Recording is active.' } : latest);
    } catch (error) {
      await abandon();
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
      setRecording((latest) => latest?.intentId === call.intentId ? { ...latest, prepared: null, active: null, captureId: ownedCaptureId, session: null, busy: false, message: error instanceof Error ? error.message : 'Recording could not start.' } : latest);
    } finally {
      if (recordingStartRef.current === call.intentId) recordingStartRef.current = null;
    }
  };

  const stopRecording = async (call: DialpadCallStatus) => {
    const current = recordingRef.current;
    if (!current?.session || !current.captureId || current.intentId !== call.intentId || current.busy) return;
    setRecording({ ...current, busy: true, message: null });
    const generation = ++recordingGenerationRef.current;
    try {
      await current.session.stop();
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
      const closed = await closeDialpadRecordingCaptureAction(current.captureId);
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
      const status = await getDialpadRecordingBrowserStatusAction(current.captureId);
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
      const message = !closed.ok ? closed.message : !status.ok || !('status' in status) ? status.message : `Recording ${status.status.captureStatus}.`;
      setRecording({ ...current, prepared: null, active: null, session: null, busy: false, message, measuredSamples: status.ok && 'status' in status ? status.status.totalSamples : current.measuredSamples, measurementStatus: status.ok && 'status' in status ? status.status.measurementStatus : current.measurementStatus });
    } catch (error) {
      if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
      setRecording({ ...current, prepared: null, active: null, busy: false, message: error instanceof Error ? error.message : 'Recording could not finish.' });
    }
  };

  // Permission remains an explicit user gesture, but once the provider has
  // authoritatively connected a prepared capture starts without a second
  // click. A recording error is kept inside this state machine and never
  // mutates provider call state.
  useEffect(() => {
    const current = recordingRef.current;
    const connected = calls.find((call) => call.intentId === current?.intentId && call.state === 'connected');
    if (connected && current?.active && !current.session && !current.busy) void startRecording(connected);
  // startRecording is an event-style callback whose ownership is guarded by
  // recordingGenerationRef; rerunning for its render identity would restart
  // an in-flight capture.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls, recording?.active, recording?.session, recording?.busy]);

  useEffect(() => {
    const current = recordingRef.current;
    const terminal = calls.find((call) => call.intentId === current?.intentId && !ACTIVE_STATES.has(call.state));
    if (!terminal || !current || current.busy) return;
    if (current.session) void stopRecording(terminal);
    else if (current.active) {
      void current.active.dispose().then(() => {
        if (mountedRef.current) setRecording((latest) => latest?.intentId === current.intentId ? null : latest);
      });
    }
  }, [calls, recording?.active, recording?.session, recording?.busy]);

  useEffect(() => {
    const current = recordingRef.current;
    if (!current?.captureId || current.session) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const deadlineMs = 60_000;
    const schedule = () => {
      if (cancelled) return;
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, message: 'Recording status did not settle before the deadline. Refresh to check it.' } : latest);
        return;
      }
      timer = setTimeout(() => { void poll(); }, Math.min(Math.max(500, pollMs), remaining));
    };
    const poll = async () => {
      if (cancelled) return;
      try {
        const result = await getDialpadRecordingBrowserStatusAction(current.captureId!);
        if (cancelled) return;
        if (!result.ok || !('status' in result)) {
          setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, message: result.ok ? 'Recording status is still pending. Retrying…' : result.message } : latest);
          schedule();
          return;
        }
        const status = result.status;
        setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, measuredSamples: status.totalSamples, measurementStatus: status.measurementStatus, message: `Recording ${status.captureStatus}.` } : latest);
        if (status.captureStatus === 'sealed' || status.captureStatus === 'partial' || status.captureStatus === 'failed') return;
        schedule();
      } catch {
        if (cancelled) return;
        setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, message: 'Recording status is temporarily unavailable. Retrying…' } : latest);
        schedule();
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [recording?.captureId, recording?.session, pollMs]);

  if (!originOk) return null;

  const blocked = binding.status !== 'verified'
    ? (iframeUser ? (verify.busy ? 'Verifying your Dialpad account…' : verify.message ?? 'Your Dialpad account is not verified yet.') : 'Sign in to Dialpad in the panel below to connect your account.')
    : !iframeUser
      ? 'Sign in to Dialpad in the panel below to place calls.'
      : iframeUser !== binding.dialpadUserId
        ? 'The Dialpad panel is signed in as a different user than the one connected to your Sandra account. Sign out of Dialpad and sign in with your own account.'
        : null;

  return (
    <section aria-label="Dialpad" className="mb-4 rounded-lg border p-4">
      <h2 className="mb-2 font-medium">Dialpad calling</h2>
      {blocked && <p role="status" className="mb-2 text-sm text-muted-foreground">{blocked}
        {binding.status !== 'verified' && iframeUser && !verify.busy && (
          <Button type="button" variant="outline" className="ml-2" onClick={() => { attemptedUser.current = iframeUser; void runVerify(iframeUser); }}>Try again</Button>
        )}
      </p>}
      {canDial && !chooser && calls.length === 0 && <p className="mb-2 text-sm text-muted-foreground">Connected. Choose Start call on a lead.</p>}
      {chooser && (
        <div role="group" aria-label="Start a Dialpad call" className="mb-3 rounded border p-3">
          <p className="mb-2 font-medium">{chooser.request.label}</p>
          {!chooser.targets && !chooser.error && <p role="status">Loading phone numbers…</p>}
          {chooser.error && <p role="alert" className="text-destructive text-sm">{chooser.error}</p>}
          {chooser.notice && <p role="status" className="text-sm">{chooser.notice}</p>}
          {chooser.targets && chooser.targets.phones.length > 0 && (
            <div className="space-y-2">
              <fieldset>
                <legend className="text-sm">Phone number</legend>
                {chooser.targets.phones.map((phone) => (
                  <label key={phone.slot} className="mr-3 inline-flex items-center gap-1">
                    <input type="radio" name="dialpad-phone" checked={chooser.slot === phone.slot} disabled={chooser.busy}
                      onChange={() => setChooser({ ...chooser, slot: phone.slot })} />
                    Phone {phone.slot} {phone.masked}
                  </label>
                ))}
              </fieldset>
              {chooser.targets.grants.length > 0 && (
                <label className="block text-sm">Caller ID
                  <select className="ml-2 rounded border p-1" value={chooser.grantId} disabled={chooser.busy}
                    onChange={(event) => setChooser({ ...chooser, grantId: event.target.value })}>
                    {chooser.targets.grants.map((grant) => (
                      <option key={grant.id} value={grant.id}>{grant.callerNumberE164}{grant.identityType ? ` (${grant.identityType})` : ''}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button type="button" disabled={!canDial || !chooser.targets || chooser.slot === null || chooser.busy} onClick={() => void startCall()}>
              {chooser.busy ? 'Starting…' : 'Call'}
            </Button>
            <Button type="button" variant="ghost" disabled={chooser.busy} onClick={() => setChooser(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {calls.length > 0 && (
        <ul className="mb-3 space-y-2" aria-label="Recent Dialpad calls">
          {calls.map((call) => (
            <li key={call.intentId} className="rounded border p-2 text-sm">
              <span className="font-medium">{labels[call.propertyId] ?? 'Lead call'}</span>{' '}
              <span>{call.state === 'ended' && !call.connected ? 'Call ended. Not answered.' : STATE_LABEL[call.state]}{call.state === 'ended' ? duration(call.durationSeconds) : ''}</span>
              {call.state === 'ended' && call.callActivityId && (
                <Button type="button" variant="outline" className="ml-2" onClick={() => onLogOutcome(call.propertyId, call.callActivityId!)}>Log outcome</Button>
              )}
              {bootstrap.recording && ACTIVE_STATES.has(call.state) && (
                <span className="ml-2 inline-flex items-center gap-2">
                  {(recording?.intentId !== call.intentId || (recording?.intentId === call.intentId && !recording.active && !recording.session)) && <Button type="button" variant="outline" disabled={recording?.busy} onClick={() => void prepareRecording(call)}>{recording?.intentId === call.intentId ? 'Prepare again' : 'Prepare recording'}</Button>}
                  {recording?.intentId === call.intentId && recording.active && !recording.session && <Button type="button" variant="outline" disabled={recording.busy} onClick={() => void startRecording(call)}>{recording.busy ? 'Starting…' : 'Start recording'}</Button>}
                  {recording?.intentId === call.intentId && recording.session && <Button type="button" variant="outline" disabled={recording.busy} onClick={() => void stopRecording(call)}>{recording.busy ? 'Finishing…' : 'End recording'}</Button>}
                </span>
              )}
              {recording?.intentId === call.intentId && recording.message && <span role="status" className="ml-2 text-xs text-muted-foreground">{recording.message}</span>}
              {recording?.intentId === call.intentId && recording.measuredSamples !== null && <span className="ml-2 text-xs text-muted-foreground">{Math.floor(recording.measuredSamples / 16_000)}s measured ({recording.measurementStatus ?? 'provisional'})</span>}
            </li>
          ))}
        </ul>
      )}
      <iframe
        ref={iframeRef}
        title="Dialpad"
        src={DIALPAD_CTI_IFRAME_SRC}
        allow={DIALPAD_CTI_IFRAME_ALLOW}
        sandbox={DIALPAD_CTI_IFRAME_SANDBOX}
        width={400}
        height={520}
        className="rounded border"
      />
    </section>
  );
}
