"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useEffect, useReducer, useState } from "react";

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
 * not a silent one) — it represents unrecoverable missed history, not a
 * transient blip, so it only ever clears when the caller explicitly calls
 * `dismissReconnectGap` — a fresh event proves the feed is current again,
 * not that the gap never happened.
 * `scriptOutOfSync` is the producer's declared scriptVersion whenever it
 * differs from this app's loaded script (CLOSR_SCRIPT.version) — reset to
 * null the moment a later event reports a matching version. Every valid
 * event carries scriptVersion (required by the wire contract), so this is
 * checked on every dispatch, not conditionally.
 */
export function useCoachChannel(callId: string | null, startingPhaseId: CoachPhaseId = "introduction") {
  const [state, dispatch] = useReducer(coachReducer, startingPhaseId, initialCoachState);
  const [degraded, setDegraded] = useState(false);
  const [reconnectGap, setReconnectGap] = useState(false);
  const [malformedEventCount, setMalformedEventCount] = useState(0);
  const [scriptOutOfSync, setScriptOutOfSync] = useState<string | null>(null);

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

  useEffect(() => {
    if (!callId) return;
    let mounted = true;
    let generation = 0;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    let livenessTimer: ReturnType<typeof setTimeout> | null = null;
    let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let everSubscribed = false;
    const supabase = createClient();

    const armLiveness = () => {
      if (livenessTimer !== null) clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        if (mounted) setDegraded(true);
      }, LIVENESS_WINDOW_MS);
    };

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
          armLiveness();
          setDegraded(false);
          const result = parseCoachEvent(message.payload);
          if (!result.ok) {
            if (result.reason === "malformed") {
              setMalformedEventCount((value) => value + 1);
              console.warn("[coach] dropped malformed event", result.rawType, message.payload);
            }
            return;
          }
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
            attempt = 0;
            armLiveness();
            // Only a *re*-subscribe (not the first one) implies a real gap:
            // there is no producer-side snapshot API to rebuild phase/gate
            // state from, so this is an honest "may have missed events"
            // signal rather than a silent one.
            if (everSubscribed) setReconnectGap(true);
            everSubscribed = true;
            return;
          }
          if (
            status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
            status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
            status === REALTIME_SUBSCRIBE_STATES.CLOSED
          ) {
            setDegraded(true);
            scheduleResubscribe();
          }
        });
    };

    armLiveness();
    void start();
    return () => {
      mounted = false;
      if (livenessTimer !== null) clearTimeout(livenessTimer);
      clearResubscribeTimer();
      // Unmounting (or callId changing, since this effect's cleanup runs
      // on every dependency change too) doesn't need to await the removal
      // before doing anything else — nothing here recreates the channel
      // synchronously the way scheduleResubscribe's continuation does.
      void teardownChannel();
    };
  }, [callId]);

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
