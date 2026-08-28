"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { coachReducer, initialCoachState } from "./event-reducer";
import { parseCoachEvent } from "./event-validation";
import { CLOSR_SCRIPT } from "./script-block";
import type { CoachPhaseId, CoachState } from "./types";

/** Rolling liveness window: if no coach event arrives within this long of
 * the last one (or of subscribing, for the very first event), the coach is
 * degraded. Re-armed on every event, not just checked once at mount. */
const LIVENESS_WINDOW_MS = 15_000;
/** Broadcast event name the coach service publishes on `coach:{call_id}`. */
const COACH_BROADCAST_EVENT = "coach_event";
/** Resubscribe backoff after CHANNEL_ERROR/TIMED_OUT/CLOSED. */
const RESUBSCRIBE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * Subscribes to the coach service's Supabase Realtime Broadcast channel for
 * one call (`coach:{callId}`, private — see the ingest side's
 * realtime.messages RLS policy), validates every inbound payload at the
 * trust boundary (parseCoachEvent — a malformed event is dropped and
 * counted, never cast through blind), and reduces valid CoachEvents into
 * CoachState. Tracks a rolling degraded (no-live-data) signal that re-arms
 * after every event and reacts immediately to subscription status changes
 * (CHANNEL_ERROR/TIMED_OUT/CLOSED), resubscribing with backoff — and
 * cancels any pending resubscribe the moment the channel recovers on its
 * own, so a stale backoff timer can't tear down a connection that already
 * came back. `reconnectGap` flags that some events may have been missed
 * while disconnected (there's no server-side state-snapshot API to
 * request a rebuild from, so this is an honest "we can't be sure" signal,
 * not a silent one) — set whenever a SUBSCRIBED was preceded by any
 * failed attempt, including the very first join (a first-try
 * CHANNEL_ERROR followed by a successful retry still means events could
 * have been emitted and lost before the retry landed — that's not a
 * "clean first connection"). It only ever clears when the caller
 * explicitly calls `dismissReconnectGap` — a fresh event proves the feed
 * is current again, not that the gap never happened. Liveness/degraded
 * are only refreshed by a fully VALIDATED event — malformed or
 * unknown-type traffic proves bytes are arriving, not that the contract
 * is intact, so it can't make a broken feed look healthy.
 * `scriptOutOfSync` is the producer's declared scriptVersion whenever it
 * differs from this app's loaded script (CLOSR_SCRIPT.version) — reset to
 * null the moment a later event reports a matching version. Every valid
 * event carries scriptVersion (required by the wire contract), so this is
 * checked on every dispatch, not conditionally.
 */
export function useCoachChannel(
  callId: string | null,
  startingPhaseId: CoachPhaseId = "introduction",
  livenessActive = true,
) {
  const [state, dispatch] = useReducer(coachReducer, startingPhaseId, initialCoachState);
  const [degraded, setDegraded] = useState(false);
  const [reconnectGap, setReconnectGap] = useState(false);
  const [malformedEventCount, setMalformedEventCount] = useState(0);
  const [scriptOutOfSync, setScriptOutOfSync] = useState<string | null>(null);
  const livenessActiveRef = useRef(livenessActive);
  const livenessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLivenessTimer = useCallback(() => {
    if (livenessTimerRef.current !== null) {
      clearTimeout(livenessTimerRef.current);
      livenessTimerRef.current = null;
    }
  }, []);

  const armLiveness = useCallback(() => {
    clearLivenessTimer();
    if (!callId || !livenessActiveRef.current) return;
    livenessTimerRef.current = setTimeout(() => {
      if (livenessActiveRef.current) setDegraded(true);
    }, LIVENESS_WINDOW_MS);
  }, [callId, clearLivenessTimer]);

  // A new call (different callId, including a transition to/from null)
  // must start from a clean coach state — this hook lives at the
  // SoftphoneProvider level and outlives any single call, so without this
  // a second call would silently inherit the first call's transcript,
  // phase, gates, objection cards, and entered deal values. Adjusted
  // during render (React's documented pattern for resetting state when a
  // prop changes — already used the same way in use-coach-session.ts)
  // rather than in an effect, so this can't render one stale frame first.
  const [trackedCallId, setTrackedCallId] = useState(callId);
  if (callId !== trackedCallId) {
    setTrackedCallId(callId);
    dispatch({ type: "reset", startingPhaseId });
    setDegraded(false);
    setReconnectGap(false);
    setMalformedEventCount(0);
    setScriptOutOfSync(null);
  }

  const [trackedLivenessActive, setTrackedLivenessActive] = useState(livenessActive);
  if (livenessActive !== trackedLivenessActive) {
    setTrackedLivenessActive(livenessActive);
    setDegraded(false);
  }
  // Subscribe as soon as the server has created the call identity, but do
  // not treat ordinary connecting/ringing time as missing coach data. Once
  // the call becomes live, start a fresh full liveness window without
  // tearing down or recreating the already-authorized channel.
  useEffect(() => {
    livenessActiveRef.current = livenessActive;
    clearLivenessTimer();
    if (livenessActive) armLiveness();
    return clearLivenessTimer;
  }, [armLiveness, clearLivenessTimer, livenessActive]);

  useEffect(() => {
    if (!callId) return;
    let mounted = true;
    let generation = 0;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const supabase = createClient();

    const clearResubscribeTimer = () => {
      if (resubscribeTimer !== null) {
        clearTimeout(resubscribeTimer);
        resubscribeTimer = null;
      }
    };

    const teardownChannel = async () => {
      if (channel) {
        const toRemove = channel;
        channel = null;
        // Awaited so a caller that recreates the channel right after never
        // races the old one's removal — removeChannel() unsubscribes and
        // closes the topic server-side, and creating a new channel on the
        // same topic before that completes has produced duplicate/ghost
        // subscriptions in practice. Fire-and-forget (the previous
        // behavior) only happened to work in tests because the mock
        // resolved synchronously; a real Supabase client does not.
        await supabase.removeChannel(toRemove);
      }
    };

    const scheduleResubscribe = () => {
      if (!mounted) return;
      clearResubscribeTimer(); // never let two resubscribe attempts stack
      const delay = RESUBSCRIBE_BACKOFF_MS[Math.min(attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)];
      attempt += 1;
      resubscribeTimer = setTimeout(() => {
        resubscribeTimer = null;
        void (async () => {
          // Invalidate the OLD channel's callbacks BEFORE deliberately
          // removing it. removeChannel() unsubscribes, which can trigger
          // that SAME channel's own CLOSED status callback (synchronously
          // or on a microtask) — without bumping generation first, that
          // callback still sees myGeneration === generation (unchanged)
          // and treats the deliberate teardown as a fresh failure,
          // scheduling a SECOND resubscribe that can tear down the
          // replacement channel while it's mid-join.
          generation += 1;
          await teardownChannel();
          await start();
        })();
      }, delay);
    };

    const start = async () => {
      const myGeneration = ++generation;
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted || myGeneration !== generation) return;

      channel = supabase
        .channel(`coach:${callId}`, { config: { private: true } })
        .on("broadcast", { event: COACH_BROADCAST_EVENT }, (message) => {
          if (!mounted || myGeneration !== generation) return;
          const result = parseCoachEvent(message.payload);
          if (!result.ok) {
            if (result.reason === "malformed") {
              setMalformedEventCount((value) => value + 1);
              console.warn("[coach] dropped malformed event", result.rawType, message.payload);
            }
            // Only a VALIDATED event counts as liveness proof — armLiveness
            // /setDegraded(false) run below, never here. Malformed traffic
            // (or a genuinely unknown forward-compat type) proves bytes are
            // arriving, not that the contract is intact; a run of garbage
            // must surface as degraded, not keep resetting the 15s window
            // and reporting a healthy feed.
            return;
          }
          armLiveness();
          setDegraded(false);
          // reconnectGap is NOT cleared here. It represents events that
          // were unrecoverably missed while disconnected — a fresh event
          // proves the feed is current again, not that nothing was lost
          // in between. Only dismissReconnectGap (an explicit rep
          // acknowledgment) clears it.
          setScriptOutOfSync(result.event.scriptVersion === CLOSR_SCRIPT.version ? null : result.event.scriptVersion);
          dispatch(result.event);
        })
        .subscribe((status) => {
          if (!mounted || myGeneration !== generation) return;
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            // The channel can recover on its own before a queued backoff
            // timer fires — cancel it so it doesn't tear down the
            // connection that just came back.
            clearResubscribeTimer();
            // A gap exists whenever this SUBSCRIBED was preceded by at
            // least one failed attempt (attempt > 0, captured before the
            // reset below) — whether that's a genuine reconnect after a
            // prior successful subscribe, OR the very first join
            // succeeding only after an initial failure (e.g. the coach
            // service's coach_call_index write, fired via after() in
            // jitter-server.ts, hadn't landed yet when the browser first
            // tried to subscribe). Either way the producer may have
            // emitted events before this join actually took, and those
            // are gone — a "first successful connection" framing would
            // hide that from the rep instead of surfacing it.
            const hadFailedAttempt = attempt > 0;
            attempt = 0;
            // A successful join is fresh transport-health evidence. Give it
            // the same full liveness grace window as the initial join so the
            // UI never claims both "Reconnected" and "reconnecting" while
            // waiting for the next speaker turn.
            setDegraded(false);
            armLiveness();
            if (hadFailedAttempt) setReconnectGap(true);
            return;
          }
          if (
            status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
            status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
            status === REALTIME_SUBSCRIBE_STATES.CLOSED
          ) {
            if (livenessActiveRef.current) setDegraded(true);
            scheduleResubscribe();
          }
        });
    };

    armLiveness();
    void start();
    return () => {
      mounted = false;
      clearLivenessTimer();
      clearResubscribeTimer();
      // Unmounting (or callId changing, since this effect's cleanup runs
      // on every dependency change too) doesn't need to await the removal
      // before doing anything else — nothing here recreates the channel
      // synchronously the way scheduleResubscribe's continuation does.
      void teardownChannel();
    };
  }, [armLiveness, callId, clearLivenessTimer]);

  return {
    state,
    dispatch,
    degraded,
    reconnectGap,
    dismissReconnectGap: () => setReconnectGap(false),
    malformedEventCount,
    scriptOutOfSync,
  };
}

export type UseCoachChannelResult = {
  state: CoachState;
  degraded: boolean;
  reconnectGap: boolean;
  malformedEventCount: number;
  scriptOutOfSync: string | null;
};
