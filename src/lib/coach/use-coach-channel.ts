"use client";

import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { useEffect, useReducer, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { coachReducer, initialCoachState } from "./event-reducer";
import type { CoachEvent, CoachPhaseId, CoachState } from "./types";

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
 * realtime.messages RLS policy), reduces incoming CoachEvents into
 * CoachState, and tracks a rolling degraded (no-live-data) signal so the UI
 * can fall back to a static, manually-scrollable script. Degraded is not a
 * one-shot "no event in the first N seconds" check — it re-arms after every
 * event, and reacts immediately to subscription status changes
 * (CHANNEL_ERROR/TIMED_OUT/CLOSED), resubscribing with backoff.
 */
export function useCoachChannel(callId: string | null, startingPhaseId: CoachPhaseId = "introduction") {
  const [state, dispatch] = useReducer(coachReducer, startingPhaseId, initialCoachState);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!callId) return;
    let mounted = true;
    let generation = 0;
    let channel: ReturnType<ReturnType<typeof createClient>["channel"]> | null = null;
    let livenessTimer: ReturnType<typeof setTimeout> | null = null;
    let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const supabase = createClient();

    const armLiveness = () => {
      if (livenessTimer !== null) clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        if (mounted) setDegraded(true);
      }, LIVENESS_WINDOW_MS);
    };

    const teardownChannel = () => {
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
    };

    const scheduleResubscribe = () => {
      if (!mounted) return;
      const delay = RESUBSCRIBE_BACKOFF_MS[Math.min(attempt, RESUBSCRIBE_BACKOFF_MS.length - 1)];
      attempt += 1;
      resubscribeTimer = setTimeout(() => {
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
          dispatch(message.payload as CoachEvent);
        })
        .subscribe((status) => {
          if (!mounted || myGeneration !== generation) return;
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            attempt = 0;
            armLiveness();
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
      if (resubscribeTimer !== null) clearTimeout(resubscribeTimer);
      teardownChannel();
    };
  }, [callId]);

  return { state, dispatch, degraded };
}

export type UseCoachChannelResult = {
  state: CoachState;
  dispatch: (action: CoachEvent) => void;
  degraded: boolean;
};
