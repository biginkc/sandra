'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { DialpadCallStatus } from '@/lib/dialpad-cti/contracts';
import type { DialpadRecordingBrowserCrossing, DialpadRecordingBrowserFinalResult } from '@/lib/dialpad-recording/contracts';
import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
import {
  createSandraCaptureHandleProof,
  createDialpadCaptureSourceSession,
  prepareDialpadBrowserCapture,
  type ActiveDialpadCapture,
  type PreparedDialpadCapture,
} from '@/lib/dialpad-recording/browser-capture';
import { createDialpadBrowserSession, type DialpadBrowserSession, type DialpadBrowserSessionDiagnostic } from '@/lib/dialpad-recording/browser-session';
import type { PcmWorkletDiagnostic } from '@/lib/dialpad-recording/pcm-audio-worklet';
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
  targetLookupDeadlineMs?: number;
  pollMs?: number;
  recordingStatusDeadlineMs?: number;
  onRecordingFinalResult?: () => void | Promise<void>;
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
  captureStatus: string | null;
  crossing: DialpadRecordingBrowserCrossing | null;
  liveThresholdCrossing: { epoch: number; sample: number } | null;
  finalResult: DialpadRecordingBrowserFinalResult | null;
  hydrated: boolean;
};

type ArmedRecording = {
  generation: number;
  active: ActiveDialpadCapture | null;
  error?: string;
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

export function DialpadPanel({ bootstrap, callRequest, onLogOutcome, onCallRequestHandled, targetLookupDeadlineMs = 15_000, pollMs = 3000, recordingStatusDeadlineMs = 60_000, onRecordingFinalResult }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const originOk = isDialpadTargetOriginConfigured(bootstrap.allowedOrigins);
  const [iframeUser, setIframeUser] = useState<string | null>(null);
  const [binding, setBinding] = useState(bootstrap.binding);
  const [verify, setVerify] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [calls, setCalls] = useState<DialpadCallStatus[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState<RecordingPanelState | null>(null);
  const [statusRetryNonce, setStatusRetryNonce] = useState(0);
  const recordingRef = useRef<RecordingPanelState | null>(null);
  const mediaOwnerRef = useRef<ReturnType<typeof createDialpadCaptureSourceSession> | null>(null);
  const [sharingAudio, setSharingAudio] = useState(false);
  const releaseAudioSources = () => {
    const owner = mediaOwnerRef.current;
    mediaOwnerRef.current = null;
    owner?.dispose();
    if (mountedRef.current) setSharingAudio(false);
  };
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
  const chooserGenerationRef = useRef(0);
  const chooserRef = useRef<Chooser | null>(null);
  const targetLookupGenerationRef = useRef(0);
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
      chooserGenerationRef.current += 1;
      const nextChooser = {
        request: callRequest,
        idempotencyKey: crypto.randomUUID(),
        targets: null,
        error: callRequest.contactId ? null : 'This lead has no contact to call.',
        slot: null,
        grantId: '',
        busy: false,
        notice: null,
      } satisfies Chooser;
      chooserRef.current = nextChooser;
      setChooser(nextChooser);
    }
  }

  useEffect(() => { bindingRef.current = binding; }, [binding]);

  const canDial = binding.status === 'verified' && iframeUser !== null && iframeUser === binding.dialpadUserId;

  useEffect(() => { chooserRef.current = chooser; }, [chooser]);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => () => {
    releaseAudioSources();
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
          releaseAudioSources();
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
    const hydrationGeneration = recordingGenerationRef.current;
    const mayHydrate = () => !cancelled
      && mountedRef.current
      && recordingGenerationRef.current === hydrationGeneration
      && recordingRef.current === null;
    void listRecentDialpadCallsAction().then(async (result) => {
      if (!mayHydrate() || !result.ok || !('calls' in result)) return;
      setCalls(result.calls);
      const latest = result.calls.find((call) => call.recordingCaptureId !== null);
      if (!latest?.recordingCaptureId) return;
      if (!mayHydrate()) return;
      const status = await getDialpadRecordingBrowserStatusAction(latest.recordingCaptureId);
      if (!mayHydrate() || !status.ok || !('status' in status)) return;
      setRecording({
        intentId: latest.intentId,
        prepared: null,
        active: null,
        captureId: status.status.captureId,
        session: null,
        busy: false,
        message: `Recording ${status.status.captureStatus}.`,
        measuredSamples: status.status.totalSamples,
        measurementStatus: status.status.measurementStatus,
        captureStatus: status.status.captureStatus,
        crossing: status.status.crossing,
        liveThresholdCrossing: null,
        finalResult: status.status.finalResult,
        hydrated: true,
      });
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
    const lookupGeneration = ++targetLookupGenerationRef.current;
    let cancelled = false;
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () => !cancelled && !settled && mountedRef.current
      && targetLookupGenerationRef.current === lookupGeneration
      && chooserRef.current?.request === request;
    const finishRequest = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      if (!isCurrent()) return;
      settled = true;
      onCallRequestHandled?.(request.nonce);
    };
    if (!request.contactId) {
      finishRequest();
      return;
    }
    void listDialpadCallTargetsAction({ propertyId: request.propertyId, contactId: request.contactId }).then((result) => {
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      setChooser((current) => (current?.request === request ? { ...current, error: 'Could not load phone numbers.' } : current));
    }).finally(() => finishRequest());
    deadlineTimer = setTimeout(() => {
      if (!isCurrent()) return;
      settled = true;
      setChooser((current) => current?.request === request ? { ...current, error: 'Could not load phone numbers before the deadline. Try again.' } : current);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      onCallRequestHandled?.(request.nonce);
    }, Math.max(0, targetLookupDeadlineMs));
    return () => {
      cancelled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
  }, [callRequest, onCallRequestHandled, targetLookupDeadlineMs]);

  const abandonPendingRecording = async (intentId: string, generation: number) => {
    const owned = recordingRef.current;
    if (!owned || owned.intentId !== intentId || owned.session || generation !== recordingGenerationRef.current) return;
    const active = owned.active;
    const prepared = owned.prepared;
    await active?.dispose().catch(() => undefined);
    await prepared?.dispose().catch(() => undefined);
    if (!mountedRef.current || generation !== recordingGenerationRef.current) return;
    const latest = recordingRef.current;
    if (latest?.intentId === intentId && latest.active === active && latest.prepared === prepared && !latest.session) {
      recordingRef.current = null;
      setRecording(null);
    }
  };

  const cancelChooser = () => {
    const nonce = chooserRef.current?.request.nonce;
    chooserGenerationRef.current += 1;
    startFired.current = null;
    chooserRef.current = null;
    setChooser(null);
    if (nonce !== undefined) onCallRequestHandled?.(nonce);
  };

  const startCall = async () => {
    const current = chooser;
    if (!current || !current.targets || current.slot === null || current.busy || !canDial) return;
    const generation = authGeneration.current;
    const chooserGeneration = chooserGenerationRef.current;
    const chooserKey = current.idempotencyKey;
    const stillDialable = () => {
      const bound = bindingRef.current;
      return mountedRef.current && authGeneration.current === generation && iframeUserRef.current !== null
        && bound.status === 'verified' && bound.dialpadUserId === iframeUserRef.current;
    };
    const ownsChooser = () => mountedRef.current
      && chooserGenerationRef.current === chooserGeneration
      && chooserRef.current?.idempotencyKey === chooserKey;
    // One click, one key: a second click or a retry after a lost response re-sends the same key and can never dial again.
    if (startFired.current === current.idempotencyKey && !current.error) return;
    startFired.current = current.idempotencyKey;
    setChooser({ ...current, busy: true, error: null, notice: null });
    const pendingRecordingId = `pending:${current.idempotencyKey}`;
    let pendingRecordingGeneration: number | null = null;
    let pendingRecordingActive: ActiveDialpadCapture | null = null;
    if (bootstrap.recording) {
      const armed = await armRecording(pendingRecordingId, 'Capture ready. Waiting for Dialpad to confirm the call.', chooserGeneration);
      pendingRecordingGeneration = armed?.generation ?? null;
      pendingRecordingActive = armed?.active ?? null;
      if (armed === null || !ownsChooser() || !stillDialable()) {
        if (pendingRecordingGeneration !== null) await abandonPendingRecording(pendingRecordingId, pendingRecordingGeneration);
        startFired.current = null;
        if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey ? { ...latest, busy: false, error: 'Recording permission is required before starting this call. Try again.' } : latest));
        return;
      }
      if (!pendingRecordingActive || pendingRecordingActive.state() !== 'recording') {
        await abandonPendingRecording(pendingRecordingId, armed.generation);
        startFired.current = null;
        if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey ? { ...latest, busy: false, error: armed.error ?? 'Recording stopped before the call could start. Prepare recording again.' } : latest));
        return;
      }
    }
    if (!ownsChooser() || !stillDialable()) {
      if (pendingRecordingGeneration !== null) await abandonPendingRecording(pendingRecordingId, pendingRecordingGeneration);
      return;
    }
    const cleanupGeneration = pendingRecordingGeneration ?? recordingGenerationRef.current;
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
      await abandonPendingRecording(pendingRecordingId, cleanupGeneration);
      if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, error: 'Sandra could not confirm the request. Do not dial from the panel. Try again to check.' }
        : latest));
      return;
    }
    if (!result.ok) {
      await abandonPendingRecording(pendingRecordingId, cleanupGeneration);
      startFired.current = null;
      if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey ? { ...latest, busy: false, error: result.message } : latest));
      return;
    }
    if (!('dispatched' in result) || !result.dispatched) {
      await abandonPendingRecording(pendingRecordingId, cleanupGeneration);
      if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, notice: 'This call was already sent to Dialpad. Check the dialer; start a new call if it did not ring.' }
        : latest));
      return;
    }
    if (!ownsChooser() || !stillDialable() || (bootstrap.recording && (!pendingRecordingActive || pendingRecordingActive.state() !== 'recording'))) {
      // The iframe user changed, signed out, or the panel went away while Sandra authorized: never post this authorization.
      void cancelDialpadCallAction(result.intentId).catch(() => undefined);
      await abandonPendingRecording(pendingRecordingId, cleanupGeneration);
      if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, idempotencyKey: crypto.randomUUID(), error: 'Your Dialpad sign-in changed while the call was starting. Nothing was dialed. Start the call again.' }
        : latest));
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
      await abandonPendingRecording(pendingRecordingId, cleanupGeneration);
      if (ownsChooser()) setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, error: 'The Dialpad dialer is not ready. Nothing was dialed. Start the call again.' }
        : latest));
      return;
    }
    const now = new Date().toISOString();
    const started: DialpadCallStatus = {
        intentId: result.intentId, state: 'awaiting_provider', connected: false, propertyId: current.request.propertyId, expiresAt: result.expiresAt, dispatchAuthorizedAt: now,
        callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null, recordingCaptureId: null,
    };
    setCalls((existing) => [started, ...existing.filter((entry) => entry.intentId !== started.intentId)].slice(0, 5));
    setRecording((latest) => latest?.intentId === pendingRecordingId ? { ...latest, intentId: result.intentId, message: 'Capture ready. Waiting for Dialpad to confirm the call.' } : latest);
    chooserRef.current = null;
    setChooser(null);
  };

  const armRecording = async (intentId: string, message = 'Capture ready. Waiting for Dialpad to confirm the call.', ownerChooserGeneration?: number): Promise<ArmedRecording | null> => {
    const current = recordingRef.current;
    if (!bootstrap.recording || current?.busy) return null;
    if (current?.intentId === intentId && current.active?.state() === 'recording' && !current.session) {
      return { generation: recordingGenerationRef.current, active: current.active };
    }
    const generation = ++recordingGenerationRef.current;
    if (current?.session) await current.session.dispose();
    else if (current?.active) await current.active.dispose();
    else await current?.prepared?.dispose();
    if (!mountedRef.current || generation !== recordingGenerationRef.current || (ownerChooserGeneration !== undefined && ownerChooserGeneration !== chooserGenerationRef.current)) return null;
    const preparing: RecordingPanelState = { intentId, prepared: null, active: null, captureId: null, session: null, busy: true, message: null, measuredSamples: null, measurementStatus: null, captureStatus: null, crossing: null, liveThresholdCrossing: null, finalResult: null, hydrated: false };
    recordingRef.current = preparing;
    setRecording(preparing);
    const clearOwnedPreparation = () => {
      if (!mountedRef.current || recordingRef.current !== preparing) return;
      recordingRef.current = null;
      setRecording(null);
    };
    try {
      const mediaDevices = navigator.mediaDevices as (MediaDevices & { setCaptureHandleConfig?: (config: { handle: string; exposeOrigin: boolean; permittedOrigins: readonly string[] }) => void }) | undefined;
      let owner = mediaOwnerRef.current;
      if (!owner) {
        const proof = createSandraCaptureHandleProof({ origin: window.location.origin, setCaptureHandleConfig: mediaDevices?.setCaptureHandleConfig?.bind(mediaDevices) });
        owner = createDialpadCaptureSourceSession({ proof, onStopped: () => {
          if (mediaOwnerRef.current !== owner) return;
          mediaOwnerRef.current = null;
          if (mountedRef.current) setSharingAudio(false);
        } });
        mediaOwnerRef.current = owner;
      }
      const sources = await owner.acquire();
      if (!mountedRef.current || mediaOwnerRef.current !== owner || generation !== recordingGenerationRef.current) { sources.invalidate(); sources.release(); return null; }
      setSharingAudio(true);
      const speechDiagnosticsEnabled = process.env.NEXT_PUBLIC_DIALPAD_PCM_DIAGNOSTICS === 'true';
      const prepared = await prepareDialpadBrowserCapture({ proof: owner.proof, sources,
        ...(speechDiagnosticsEnabled ? { onPcmDiagnostic: (summary: PcmWorkletDiagnostic) => {
          console.info('dialpad_browser_pcm_diagnostic', JSON.stringify({ captureId: recordingRef.current?.captureId ?? null, ...summary }));
        } } : {}),
      });
      if (!mountedRef.current || generation !== recordingGenerationRef.current || (ownerChooserGeneration !== undefined && ownerChooserGeneration !== chooserGenerationRef.current)) { await prepared.dispose(); clearOwnedPreparation(); return null; }
      if (!prepared.startLocal) throw new Error('This browser cannot start local capture before the call.');
      const active = await prepared.startLocal(1);
      if (!mountedRef.current || generation !== recordingGenerationRef.current || (ownerChooserGeneration !== undefined && ownerChooserGeneration !== chooserGenerationRef.current)) { await active.dispose(); await prepared.dispose(); clearOwnedPreparation(); return null; }
      const ready: RecordingPanelState = { intentId, prepared, active, captureId: null, session: null, busy: false, message, measuredSamples: null, measurementStatus: null, captureStatus: null, crossing: null, liveThresholdCrossing: null, finalResult: null, hydrated: false };
      recordingRef.current = ready;
      setRecording(ready);
      return { generation, active };
    } catch (error) {
      if (!mountedRef.current || generation !== recordingGenerationRef.current || (ownerChooserGeneration !== undefined && ownerChooserGeneration !== chooserGenerationRef.current)) { clearOwnedPreparation(); return null; }
      const failedPreparation: RecordingPanelState = { intentId, prepared: null, active: null, captureId: null, session: null, busy: false, message: error instanceof Error ? error.message : 'Browser capture could not be prepared.', measuredSamples: null, measurementStatus: null, captureStatus: null, crossing: null, liveThresholdCrossing: null, finalResult: null, hydrated: false };
      recordingRef.current = failedPreparation;
      setRecording(failedPreparation);
      return { generation, active: null, error: error instanceof Error ? error.message : 'Browser capture could not be prepared.' };
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
    const isOwned = () => mountedRef.current
      && generation === recordingGenerationRef.current
      && recordingRef.current?.intentId === call.intentId
      && (recordingRef.current.active === ownedActive || recordingRef.current.session === ownedSession);
    const abandon = async () => {
      if (ownedSession) await ownedSession.dispose().catch(() => undefined);
      if (!ownedSession) await ownedActive.dispose().catch(() => undefined);
      await ownedPrepared?.dispose().catch(() => undefined);
    };
    setRecording({ ...current, busy: true, message: null });
    try {
      if (ownedActive.state() !== 'recording') throw new Error('Recording capture stopped before Dialpad authorization. Prepare recording again.');
      const opened = await openDialpadRecordingCaptureAction(call.intentId);
      if (!opened.ok || !('capture' in opened)) throw new Error(opened.message);
      const captureId = opened.capture.captureId;
      ownedCaptureId = captureId;
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      const status = await getDialpadRecordingBrowserStatusAction(captureId);
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      if (!status.ok || !('status' in status)) throw new Error(status.message);
      if (ownedActive.state() !== 'recording') throw new Error('Recording capture stopped before authorization. Prepare recording again.');
      const grant = await mintDialpadRecordingNextEpochAction({ captureId, expectedConsumedEpoch: status.status.latestConsumedEpoch });
      if (!mountedRef.current || generation !== recordingGenerationRef.current) { await abandon(); return; }
      if (!grant.ok || !('token' in grant)) throw new Error(grant.message);
      if (ownedActive.state() !== 'recording') throw new Error('Recording capture stopped before transport attachment. Prepare recording again.');
      const session = createDialpadBrowserSession({
        endpoint: grant.ingestEndpoint,
        token: grant.token,
        epoch: grant.epoch,
        capture: ownedActive,
        enableTiming: bootstrap.recording?.timingEnabled === true,
        ...(process.env.NEXT_PUBLIC_DIALPAD_PCM_DIAGNOSTICS === 'true' ? { onDiagnostic: (summary: DialpadBrowserSessionDiagnostic) => {
          console.info('dialpad_browser_transport_diagnostic', JSON.stringify({ captureId, ...summary }));
        } } : {}),
        onSnapshot: (snapshot) => setRecording((latest) => isOwned() && latest?.intentId === call.intentId ? {
          ...latest,
          measuredSamples: snapshot.totalSamples,
          measurementStatus: snapshot.measurementStatus,
          liveThresholdCrossing: snapshot.threshold.crossed && snapshot.threshold.crossingEpoch !== null && snapshot.threshold.crossingSample !== null
            ? { epoch: snapshot.threshold.crossingEpoch, sample: snapshot.threshold.crossingSample }
            : null,
        } : latest),
        onStopped: () => {
          if (!isOwned()) return;
          const latest = recordingRef.current;
          if (!latest || latest.intentId !== call.intentId) return;
          const stopped: RecordingPanelState = { ...latest, prepared: null, active: null, captureId, session: null, busy: false, hydrated: true, message: 'Recording finished. Verifying saved audio…' };
          recordingRef.current = stopped;
          setRecording(stopped);
        },
        onFailure: (failure) => setRecording((latest) => isOwned() && latest?.intentId === call.intentId ? { ...latest, prepared: null, active: null, session: null, busy: false, message: failure.message } : latest),
      });
      ownedSession = session;
      await session.start();
      if (!isOwned() || ownedActive.state() !== 'recording') { await abandon(); return; }
      setRecording((latest) => isOwned() && latest?.intentId === call.intentId ? { ...latest, prepared: null, active: null, captureId, session, busy: false, message: 'Recording is active.' } : latest);
    } catch (error) {
      await abandon();
      if (!isOwned()) return;
      setRecording((latest) => isOwned() && latest?.intentId === call.intentId ? { ...latest, prepared: null, active: null, captureId: ownedCaptureId, session: null, busy: false, message: error instanceof Error ? error.message : 'Recording could not start.' } : latest);
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
      setRecording({ ...current, prepared: null, active: null, session: null, busy: false, message, captureStatus: status.ok && 'status' in status ? status.status.captureStatus : current.captureStatus, measuredSamples: status.ok && 'status' in status ? status.status.totalSamples : current.measuredSamples, measurementStatus: status.ok && 'status' in status ? status.status.measurementStatus : current.measurementStatus, crossing: status.ok && 'status' in status ? status.status.crossing : current.crossing, liveThresholdCrossing: status.ok && 'status' in status ? null : current.liveThresholdCrossing, finalResult: status.ok && 'status' in status ? status.status.finalResult : current.finalResult });
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
      const generation = recordingGenerationRef.current;
      const active = current.active;
      void active.dispose().then(() => {
        if (mountedRef.current && generation === recordingGenerationRef.current && recordingRef.current?.intentId === current.intentId && recordingRef.current?.active === active) {
          recordingRef.current = null;
          setRecording(null);
        }
      });
    }
  }, [calls, recording?.active, recording?.session, recording?.busy]);

  useEffect(() => {
    const current = recordingRef.current;
    if (!current?.captureId || current.session) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const monotonicNow = () => typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
    const startedAt = monotonicNow();
    const deadlineMs = recordingStatusDeadlineMs;
    const isCurrent = () => !cancelled && mountedRef.current && recordingRef.current?.captureId === current.captureId;
    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      timer = null;
      deadlineTimer = null;
    };
    const markDeadline = () => {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (mountedRef.current && recordingRef.current?.captureId === current.captureId) {
        setRecording((latest) => {
          if (latest?.captureId !== current.captureId) return latest;
          const terminal = latest.captureStatus === 'sealed' || latest.captureStatus === 'partial' || latest.captureStatus === 'failed';
          return {
            ...latest,
            message: terminal
              ? `Recording ${latest.captureStatus}. Seller-speech verification is ${latest.captureStatus === 'failed' ? 'unavailable' : 'pending'}. Refresh to check it.`
              : 'Recording status did not settle before the deadline. Refresh to check it.',
          };
        });
      }
    };
    const schedule = () => {
      if (!isCurrent()) return;
      const remaining = deadlineMs - (monotonicNow() - startedAt);
      if (remaining <= 0) {
        markDeadline();
        return;
      }
      timer = setTimeout(() => { void poll(); }, Math.min(Math.max(500, pollMs), remaining));
    };
    const poll = async () => {
      if (!isCurrent()) return;
      try {
        const result = await getDialpadRecordingBrowserStatusAction(current.captureId!);
        if (!isCurrent()) return;
        if (!result.ok || !('status' in result)) {
          setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, message: result.ok ? 'Recording status is still pending. Retrying…' : result.message } : latest);
          schedule();
          return;
        }
        const status = result.status;
        setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, captureStatus: status.captureStatus, measuredSamples: status.totalSamples, measurementStatus: status.measurementStatus, crossing: status.crossing, liveThresholdCrossing: null, finalResult: status.finalResult, message: status.finalResult?.status === 'eligible' ? 'Recording verified: eligible seller speech.' : status.finalResult?.status === 'ineligible' && status.finalResult.reasons.includes('below_threshold') ? 'Recording verified: below the five-minute seller-speech threshold.' : status.finalResult?.status === 'ineligible' ? 'Recording verified: evidence is incomplete.' : status.finalResult?.status === 'unknown' ? 'Recording qualification is unavailable until evidence is accepted.' : status.finalResult?.status === 'stale' ? 'Recording qualification is stale. Refresh to check again.' : `Recording ${status.captureStatus}.` } : latest);
        const finalSettled = status.finalResult !== null && status.finalResult.status !== 'stale';
        if ((status.captureStatus === 'sealed' || status.captureStatus === 'partial' || status.captureStatus === 'failed') && finalSettled) {
          cancelled = true;
          stopTimers();
          return;
        }
        schedule();
      } catch {
        if (cancelled) return;
        setRecording((latest) => latest?.captureId === current.captureId ? { ...latest, message: 'Recording status is temporarily unavailable. Retrying…' } : latest);
        schedule();
      }
    };
    deadlineTimer = setTimeout(markDeadline, deadlineMs);
    void poll();
    return () => { cancelled = true; stopTimers(); };
  }, [recording?.captureId, recording?.session, pollMs, recordingStatusDeadlineMs, statusRetryNonce]);

  const lastNotifiedFinalResult = useRef<string | null>(null);
  useEffect(() => {
    const result = recording?.finalResult;
    if (!result) return;
    const key = `${recording.captureId ?? ''}:${result.status}:${result.evaluatedAt}:${result.eligibleSamples ?? ''}`;
    if (lastNotifiedFinalResult.current === key) return;
    lastNotifiedFinalResult.current = key;
    void onRecordingFinalResult?.();
  }, [recording?.captureId, recording?.finalResult, onRecordingFinalResult]);

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
            <Button type="button" variant="ghost" disabled={chooser.busy} onClick={cancelChooser}>Cancel</Button>
          </div>
        </div>
      )}
      {sharingAudio && <div className="mb-3 flex items-center gap-2 text-sm">
        <span>Audio sharing is ready. Calls record automatically; nothing is recorded between calls.</span>
        <Button type="button" variant="outline" onClick={releaseAudioSources}>Stop sharing audio</Button>
      </div>}
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
                  {(recording?.intentId !== call.intentId || (recording?.intentId === call.intentId && !recording.active && !recording.session && !recording.hydrated)) && <Button type="button" variant="outline" disabled={recording?.busy} onClick={() => void prepareRecording(call)}>{recording?.intentId === call.intentId ? 'Prepare again' : 'Prepare recording'}</Button>}
                  {recording?.intentId === call.intentId && recording.active && !recording.session && <span role="status">{recording.busy ? 'Starting recording…' : 'Recording starts automatically when Dialpad confirms the connection.'}</span>}
                  {recording?.intentId === call.intentId && recording.session && <Button type="button" variant="outline" disabled={recording.busy} onClick={() => void stopRecording(call)}>{recording.busy ? 'Finishing…' : 'End recording'}</Button>}
                </span>
              )}
              {recording?.intentId === call.intentId && recording.message && <span role="status" className="ml-2 text-xs text-muted-foreground">{recording.message}</span>}
              {recording?.intentId === call.intentId && recording.measuredSamples !== null && <span className="ml-2 text-xs text-muted-foreground">{Math.floor(recording.measuredSamples / 16_000)}s measured ({recording.measurementStatus ?? 'provisional'})</span>}
              {recording?.intentId === call.intentId && (recording.crossing || recording.liveThresholdCrossing) && (!recording.finalResult || recording.finalResult.status === 'stale') && <span className="ml-2 text-xs text-muted-foreground">Observed seller speech crossed 300s; final qualification is still being verified.</span>}
              {recording?.intentId === call.intentId && recording.finalResult && <span className="ml-2 text-xs text-muted-foreground">{recording.finalResult.status === 'eligible' ? `Verified seller speech: ${Math.floor((recording.finalResult.eligibleSamples ?? 0) / 16_000)}s.` : recording.finalResult.status === 'ineligible' && recording.finalResult.reasons.includes('below_threshold') ? 'Not eligible: seller speech below 5 minutes.' : recording.finalResult.status === 'ineligible' ? 'Not eligible: evidence incomplete.' : recording.finalResult.status === 'stale' ? 'Verification is stale. Refresh to check again.' : recording.finalResult.reasons.includes('policy_not_accepted') ? 'Final qualification unavailable: acceptance evidence pending.' : 'Final qualification unavailable: evidence incomplete.'}</span>}
              {recording?.intentId === call.intentId && recording.captureId && !recording.session && <Button type="button" variant="ghost" className="ml-2" onClick={() => setStatusRetryNonce((value) => value + 1)}>Refresh recording status</Button>}
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
