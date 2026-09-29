'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { DialpadCallStatus } from '@/lib/dialpad-cti/contracts';
import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
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

export interface DialpadCallRequest {
  nonce: number;
  propertyId: string;
  contactId: string | null;
  label: string;
}

type Props = {
  bootstrap: DialpadPanelBootstrap;
  callRequest: DialpadCallRequest | null;
  onLogOutcome: (propertyId: string) => void;
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

const ACTIVE_STATES: ReadonlySet<string> = new Set(['prepared', 'awaiting_provider', 'in_progress']);

const STATE_LABEL: Record<DialpadCallStatus['state'], string> = {
  prepared: 'Preparing',
  awaiting_provider: 'Calling. Waiting for Dialpad to confirm.',
  in_progress: 'In call. Confirmed by Dialpad.',
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
  const attemptedUser = useRef<string | null>(null);
  const enabledTab = useRef(false);
  const startFired = useRef<string | null>(null);
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

  const canDial = binding.status === 'verified' && iframeUser !== null && iframeUser === binding.dialpadUserId;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const parsed = parseDialpadIncomingMessage(event, {
        iframeWindow: iframeRef.current?.contentWindow ?? null,
        allowedOrigins: bootstrap.allowedOrigins,
      });
      if (parsed.kind === 'user_authentication') setIframeUser(parsed.authenticated ? parsed.userId : null);
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
    // One click, one key: a second click or a retry after a lost response re-sends the same key and can never dial again.
    if (startFired.current === current.idempotencyKey && !current.error) return;
    startFired.current = current.idempotencyKey;
    setChooser({ ...current, busy: true, error: null, notice: null });
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
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, error: 'Sandra could not confirm the request. Do not dial from the panel. Try again to check.' }
        : latest));
      return;
    }
    if (!result.ok) {
      startFired.current = null;
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey ? { ...latest, busy: false, error: result.message } : latest));
      return;
    }
    if (!('dispatched' in result) || !result.dispatched) {
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, notice: 'This call was already sent to Dialpad. Check the dialer; start a new call if it did not ring.' }
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
      setChooser((latest) => (latest?.idempotencyKey === current.idempotencyKey
        ? { ...latest, busy: false, error: 'The Dialpad dialer is not ready. Nothing was dialed. Start the call again.' }
        : latest));
      return;
    }
    const now = new Date().toISOString();
    const started: DialpadCallStatus = {
        intentId: result.intentId, state: 'awaiting_provider', propertyId: current.request.propertyId, expiresAt: result.expiresAt, dispatchAuthorizedAt: now,
        callActivityId: null, attemptId: null, startedAt: null, endedAt: null, durationSeconds: null, talkDurationSeconds: null,
    };
    setCalls((existing) => [started, ...existing.filter((entry) => entry.intentId !== started.intentId)].slice(0, 5));
    setChooser(null);
  };

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
              <span>{STATE_LABEL[call.state]}{call.state === 'ended' ? duration(call.durationSeconds) : ''}</span>
              {call.state === 'ended' && (
                <Button type="button" variant="outline" className="ml-2" onClick={() => onLogOutcome(call.propertyId)}>Log outcome</Button>
              )}
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
