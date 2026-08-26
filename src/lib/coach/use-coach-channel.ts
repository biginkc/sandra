"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useEffect, useReducer, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { coachReducer, initialCoachState } from "./event-reducer";
import { parseCoachEvent } from "./event-validation";
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
 * not a silent one) — callers should surface it and clear it once
 * acknowledged or once fresh events prove the feed is current.
 */
export function useCoachChannel(callId: string | null, startingPhaseId: CoachPhaseId = "introduction") {
  const [state, dispatch] = useReducer(coachReducer, startingPhaseId, initialCoachState);
  const [degraded, setDegraded] = useState(false);
  const [reconnectGap, setReconnectGap] = useState(false);
  const [malformedEventCount, setMalformedEventCount] = useState(0);

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

    const teardownChannel = () => {
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };

    const scheduleResubscribe = () => {
      if (!mounted) return;
      clearResubscribeTimer(); // never let two resubscribe attempts stack
      const delay = RESUBSCRIBE_BACKOFF_MS[Math.min(attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)];
      attempt += 1;
      resubscribeTimer = setTimeout(() => {
        resubscribeTimer = null;
        teardownChannel();
        void start();
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
          // A fresh, valid event is the best evidence we have that the feed
          // is caught up — clear the gap flag whether or not it was set.
          setReconnectGap(false);
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
      teardownChannel();
    };
  }, [callId]);

  return {
    state,
    dispatch,
    degraded,
    reconnectGap,
    dismissReconnectGap: () => setReconnectGap(false),
    malformedEventCount,
  };
}

export type UseCoachChannelResult = {
  state: CoachState;
  degraded: boolean;
  reconnectGap: boolean;
  malformedEventCount: number;
};
