"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DIALPAD_ACTIVE_CALL_STATES, type DialpadCallStatus } from "@/lib/dialpad-cti/contracts";
import { getDialpadCallStatusAction } from "../dialpad-actions";

export type DialFlight =
  /** `nonce` remounts the status (and restarts polling) when the same intent is shown again after a re-click. */
  | { kind: "in_flight"; intentId: string; propertyId: string; label: string; uncertain: boolean; nonce?: number }
  | { kind: "rate_limited"; propertyId: string; label: string; retryAfterSeconds: number; attempt: number }
  | { kind: "error"; propertyId: string; label: string; message: string; releaseKeyOnDismiss?: boolean }
  /** The server refused a new key: an earlier call to this lead may have rung. Redialing needs an explicit confirm. */
  | { kind: "unresolved"; propertyId: string; label: string; message: string; priorIntentId: string };

type Props = {
  flight: DialFlight | null;
  /** A refused second dial ("Finish your current call…"); shown alongside the live flight, never replacing it. */
  notice?: string | null;
  pollMs?: number;
  onRetry: (propertyId: string) => void;
  onDismiss: () => void;
  onConfirmRedial?: (propertyId: string, priorIntentId: string) => void;
  onLogOutcome?: (propertyId: string, callActivityId: string) => void;
  onEnded?: (status: DialpadCallStatus) => void;
  /** Fires once when the call reaches a final state: ended, cancelled or expired. `failed` is only a marker (a late event can still arrive), so it never fires. */
  onFinished?: (intentId: string, status: DialpadCallStatus) => void;
};

// Same list the panel and the server use: `failed` keeps polling because a late event can still project.
const POLLING_STATES: ReadonlySet<DialpadCallStatus["state"]> = new Set(DIALPAD_ACTIVE_CALL_STATES);

const FINAL_STATES: ReadonlySet<DialpadCallStatus["state"]> = new Set(["ended", "cancelled", "expired"]);

const STATE_LABEL: Record<DialpadCallStatus["state"], string> = {
  prepared: "Preparing",
  awaiting_provider: "Calling. Waiting for Dialpad to confirm.",
  dialing: "Dialing. Not answered yet.",
  connected: "Connected. Confirmed by Dialpad.",
  ended: "Call ended.",
  cancelled: "Cancelled. Nothing was dialed.",
  expired: "No confirmation from Dialpad. Check the dialer before calling again.",
  failed: "Dialpad has not confirmed this call. It may have rung. Check Dialpad before calling again.",
};

function durationText(seconds: number | null): string {
  if (seconds === null) return "";
  return ` (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`;
}

export function statusText(status: DialpadCallStatus): string {
  if (status.state !== "ended") return STATE_LABEL[status.state];
  return `${STATE_LABEL.ended}${status.connected ? "" : " Not answered."}${durationText(status.durationSeconds)}`;
}

const ROOT = "rounded-md border border-border bg-muted/40 px-3 py-2 text-sm flex flex-wrap items-center gap-2";

export function DialStatus(props: Props) {
  return (
    <>
      {props.notice ? <div data-testid="dial-notice" role="status" className={ROOT}>{props.notice}</div> : null}
      <DialFlightStatus {...props} />
    </>
  );
}

function DialFlightStatus(props: Props) {
  const { flight } = props;
  if (!flight) return null;
  if (flight.kind === "in_flight") return <InFlight key={`${flight.intentId}:${flight.nonce ?? 0}`} {...props} flight={flight} />;
  if (flight.kind === "rate_limited") return <RateLimited key={`${flight.propertyId}:${flight.attempt}`} {...props} flight={flight} />;
  return (
    <div data-testid="dial-status" role="status" className={ROOT}>
      <span>{flight.label}: {flight.message}</span>
      {flight.kind === "unresolved" ? (
        <Button type="button" size="sm" onClick={() => props.onConfirmRedial?.(flight.propertyId, flight.priorIntentId)}>Call again anyway</Button>
      ) : null}
      <Button type="button" variant="outline" size="sm" onClick={props.onDismiss}>Dismiss</Button>
    </div>
  );
}

function InFlight({ flight, pollMs = 3000, onDismiss, onLogOutcome, onEnded, onFinished }: Props & { flight: Extract<DialFlight, { kind: "in_flight" }> }) {
  const [status, setStatus] = useState<DialpadCallStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const endedRef = useRef(onEnded);
  useEffect(() => {
    endedRef.current = onEnded;
  }, [onEnded]);
  const finishedRef = useRef(onFinished);
  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    let alive = true;
    let finishedFired = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let endedFired = false;
    const run = async () => {
      let next: DialpadCallStatus | null = null;
      try {
        const res = await getDialpadCallStatusAction(flight.intentId);
        if (!alive) return;
        if (!res.ok) {
          setMessage(res.message);
          return;
        }
        next = res.status;
      } catch (err) {
        if (!alive) return;
        setMessage(err instanceof Error ? err.message : "Could not check the call.");
        return;
      }
      setStatus(next);
      setMessage(null);
      if (next.state === "ended" && !endedFired) {
        endedFired = true;
        endedRef.current?.(next);
      }
      if (FINAL_STATES.has(next.state) && !finishedFired) {
        finishedFired = true;
        finishedRef.current?.(flight.intentId, next);
      }
      if (POLLING_STATES.has(next.state)) timer = setTimeout(() => void run(), pollMs);
    };
    void run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [flight.intentId, pollMs]);

  const text = message ?? (status ? statusText(status) : flight.uncertain ? "Sandra sent the call but Dialpad has not confirmed it yet." : "Preparing");
  const canLog = status?.state === "ended" && status.callActivityId && onLogOutcome;
  return (
    <div data-testid="dial-status" role="status" className={ROOT}>
      <span>{flight.label}: {text}</span>
      {canLog ? (
        <Button type="button" size="sm" onClick={() => onLogOutcome(flight.propertyId, status.callActivityId as string)}>Log outcome</Button>
      ) : null}
      {status && POLLING_STATES.has(status.state) && status.state !== "failed" && !message ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onDismiss}>Dismiss</Button>
      )}
    </div>
  );
}

function RateLimited({ flight, onRetry, onDismiss }: Props & { flight: Extract<DialFlight, { kind: "rate_limited" }> }) {
  const giveUp = flight.attempt >= 2;
  const [remaining, setRemaining] = useState(flight.retryAfterSeconds);
  const [retrying, setRetrying] = useState(false);
  const retryRef = useRef(onRetry);
  useEffect(() => {
    retryRef.current = onRetry;
  }, [onRetry]);
  const firedRef = useRef(false);

  useEffect(() => {
    if (giveUp) return;
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(id);
  }, [giveUp]);

  useEffect(() => {
    if (giveUp || remaining > 0 || firedRef.current) return;
    firedRef.current = true;
    setRetrying(true);
    retryRef.current(flight.propertyId);
  }, [giveUp, remaining, flight.propertyId]);

  return (
    <div data-testid="dial-status" role="status" className={ROOT}>
      <span>
        {flight.label}: {giveUp
          ? "Dialpad is still rate limiting calls. Try again in a minute."
          : retrying
            ? "Retrying…"
            : `Dialpad is rate limiting calls. Retrying in ${remaining}s…`}
      </span>
      {/* Dismiss always works: while counting down it also cancels the automatic retry. */}
      {retrying && !giveUp ? null : <Button type="button" variant="outline" size="sm" onClick={onDismiss}>Dismiss</Button>}
    </div>
  );
}
