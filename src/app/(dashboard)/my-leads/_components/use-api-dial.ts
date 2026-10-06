"use client";

import { useEffect, useRef, useState } from "react";

import { useCallLock } from "@/components/calls/call-lock-context";
import { CALL_LOCK_MESSAGE } from "@/lib/calls/call-lock";
import type { DialpadCallStatus } from "@/lib/dialpad-cti/contracts";
import { dialLeadAction } from "../dialpad-actions";
import type { DialFlight } from "./dial-status";

export type DialTarget = { contactId: string | null; label: string; phoneSlot?: 1 | 2 | 3 | null };

export type UseApiDialOptions = {
  /** The server said Dialpad is not configured for this click (a refusal before anything was prepared). The caller falls back to its legacy path. */
  onNotConfigured?: (propertyId: string) => void;
};

/**
 * API dial (P2 2.7), shared by the My Leads page and the call screen. One in-flight dial at a time;
 * one idempotency key PER LEAD lives here so a retry of the same click can never dial twice, and
 * dialing another lead never discards an unresolved lead's key. A key is released only on (1) a
 * server-proven non-dispatch (freshAttemptKey), (2) a poll state of ended or cancelled, or (3) a
 * deliberate Dismiss/confirm after a visible "may have rung" caution. Everything else keeps it
 * (allowlist, never a denylist).
 *
 * `resolveTarget` returns null when the lead is not known to the caller (nothing is dialed).
 */
export function useApiDial(resolveTarget: (propertyId: string) => DialTarget | null, options: UseApiDialOptions = {}) {
  const lock = useCallLock();
  // This hook instance owns the lock only through its own token; another instance can neither take nor free it.
  const [token] = useState(() => Symbol("dialpad"));
  // The lead this instance holds the lock for. Same-token re-acquire is only for that same flight; any other lead is refused.
  const heldFor = useRef<string | null>(null);
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  const freeLock = () => {
    heldFor.current = null;
    lock.release(token);
  };
  const [dialFlight, setDialFlight] = useState<DialFlight | null>(null);
  const dialKeys = useRef(new Map<string, { key: string; intentId?: string; uncertain?: boolean }>());
  const dialNonce = useRef(0);
  const releaseDialKeyForProperty = (propertyId: string) => {
    dialKeys.current.delete(propertyId);
  };
  const releaseDialKeyForIntent = (intentId: string) => {
    for (const [propertyId, entry] of dialKeys.current) {
      if (entry.intentId === intentId) dialKeys.current.delete(propertyId);
    }
  };
  // A flight stays on screen after its call ends (for Log outcome); it only blocks new dials and the
  // auto-prompt while the call itself is still live.
  const [dialFinished, setDialFinished] = useState<string | null>(null);
  const dialActive = dialFlight?.kind === "in_flight" && dialFinished !== dialFlight.intentId;
  const dialActiveRef = useRef(false);
  useEffect(() => {
    dialActiveRef.current = dialActive;
  });
  const dialBusy = useRef(false);
  // True from the click until the server answers (the window before a flight exists), so other dialers can be held off.
  const [dialPending, setDialPending] = useState(false);
  const resolveRef = useRef(resolveTarget);
  useEffect(() => {
    resolveRef.current = resolveTarget;
  });
  const notConfiguredRef = useRef(options.onNotConfigured);
  useEffect(() => {
    notConfiguredRef.current = options.onNotConfigured;
  });

  useEffect(() => () => lock.release(token), [lock, token]);

  const startApiDial = async (propertyId: string, attempt: number, confirmRedialOf?: string) => {
    const target = resolveRef.current(propertyId);
    if (!target) return;
    const { label } = target;
    // Holding the lock in ANY state (live, pending, uncertain, rate-limit countdown) for another lead: refuse, and never release.
    if (heldFor.current !== null && heldFor.current !== propertyId) {
      setLockNotice(CALL_LOCK_MESSAGE);
      return;
    }
    if (!target.contactId) {
      setDialFlight({ kind: "error", propertyId, label, message: "This lead has no contact to call." });
      return;
    }
    if (dialBusy.current || dialActiveRef.current) return;
    // The lowest dial level: every path (click, rate-limit auto-retry, Retry, "Call again anyway") passes here.
    if (!lock.acquire("dialpad", token)) {
      setDialFlight({ kind: "error", propertyId, label, message: CALL_LOCK_MESSAGE });
      return;
    }
    setLockNotice(null);
    heldFor.current = propertyId;
    // Held through a live call and through a rate-limit countdown; released on every other outcome.
    let keepLock = false;
    dialBusy.current = true;
    setDialPending(true);
    // This lead's key is kept while its call is in flight, uncertain, failed, expired or the request
    // threw, so a repeat of the same click cannot dial twice. A new key is minted only when this lead has none.
    let entry = dialKeys.current.get(propertyId);
    if (!entry) {
      entry = { key: crypto.randomUUID() };
      dialKeys.current.set(propertyId, entry);
    }
    try {
      const outcome = await dialLeadAction({
        propertyId,
        contactId: target.contactId,
        ...(target.phoneSlot ? { phoneSlot: target.phoneSlot } : {}),
        idempotencyKey: entry.key,
        ...(confirmRedialOf ? { confirmRedialOf } : {}),
      });
      if (outcome.ok) {
        keepLock = true;
        entry.intentId = outcome.intentId;
        setDialFinished(null);
        dialNonce.current += 1;
        setDialFlight({
          kind: "in_flight",
          intentId: outcome.intentId,
          propertyId,
          label,
          uncertain: outcome.state === "awaiting_provider" && outcome.uncertain,
          nonce: dialNonce.current,
        });
        return;
      }
      if (outcome.freshAttemptKey) releaseDialKeyForProperty(propertyId);
      // An earlier attempt that threw may have rung: never fall back to another dialer for it.
      if (outcome.code === "not_configured" && notConfiguredRef.current && !entry.uncertain && !entry.intentId) {
        // The fallback dialer must be able to take the lock.
        freeLock();
        // Refused before anything was prepared: the key was never used.
        if (!entry.intentId) releaseDialKeyForProperty(propertyId);
        notConfiguredRef.current(propertyId);
        return;
      }
      if (outcome.code === "prior_call_unresolved" && outcome.priorIntentId) {
        // The server refused before preparing anything, so a key minted just now was never used.
        if (!entry.intentId) releaseDialKeyForProperty(propertyId);
        setDialFlight({ kind: "unresolved", propertyId, label, message: outcome.message, priorIntentId: outcome.priorIntentId });
        return;
      }
      if (outcome.code === "rate_limited") {
        // Held only while a countdown will retry; after the second attempt the flight just gives up.
        keepLock = attempt < 2;
        setDialFlight({
          kind: "rate_limited",
          propertyId,
          label,
          retryAfterSeconds: outcome.retryAfterSeconds ?? 60,
          attempt,
        });
        return;
      }
      // A replay of an expired key: the call may have rung. Dismiss is the deliberate release after this caution.
      setDialFlight({ kind: "error", propertyId, label, message: outcome.message, releaseKeyOnDismiss: outcome.code === "expired" });
    } catch {
      // The request may have reached the server and dialed; the key stays so a retry cannot double-dial.
      entry.uncertain = true;
      // May have rung: keep the lock until the rep Dismisses the "could not confirm" caution.
      keepLock = true;
      setDialFlight({ kind: "error", propertyId, label, message: "Sandra could not confirm the call. Check Dialpad before trying again." });
    } finally {
      dialBusy.current = false;
      setDialPending(false);
      if (!keepLock) freeLock();
    }
  };

  /** The handlers `DialStatus` needs for the key lifecycle; spread them next to the caller's onEnded/onLogOutcome. */
  const statusHandlers = {
    onRetry: (propertyId: string) => {
      // Only after a proven non-dispatch rejection (the key was cleared by the server's freshAttemptKey).
      const attempt = dialFlight?.kind === "rate_limited" ? dialFlight.attempt + 1 : 1;
      void startApiDial(propertyId, attempt);
    },
    onConfirmRedial: (propertyId: string, priorIntentId: string) => {
      // The rep read the "may have rung" caution and chose to call again: new key, named prior intent.
      releaseDialKeyForProperty(propertyId);
      void startApiDial(propertyId, 1, priorIntentId);
    },
    onDismiss: () => {
      // A deliberate Dismiss after a visible "may have rung" caution releases that lead's key. A
      // finished flight is ended/cancelled (key already gone) or expired; `failed` is not finished,
      // so dismissing it (or any call still live) keeps the key.
      if (dialFlight?.kind === "in_flight" && dialFinished === dialFlight.intentId) {
        releaseDialKeyForProperty(dialFlight.propertyId);
      } else if (dialFlight?.kind === "error" && dialFlight.releaseKeyOnDismiss) {
        releaseDialKeyForProperty(dialFlight.propertyId);
      }
      setDialFlight(null);
      setLockNotice(null);
      // Dismiss ends a live status, a failed one, and cancels a rate-limit countdown.
      freeLock();
    },
    onFinished: (intentId: string, finalStatus: DialpadCallStatus) => {
      freeLock();
      // Allowlist: only a call that definitively ended or was cancelled releases its key. expired,
      // failed or anything unexpected keeps it (the call may have rung).
      if (finalStatus.state === "ended" || finalStatus.state === "cancelled") releaseDialKeyForIntent(intentId);
      setDialFinished(intentId);
    },
  };

  return { dialFlight, dialActive, dialPending, lockNotice, startApiDial, statusHandlers };
}
