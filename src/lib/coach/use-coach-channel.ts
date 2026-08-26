"use client";

import { useEffect, useReducer, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { coachReducer, initialCoachState } from "./event-reducer";
import type { CoachEvent, CoachPhaseId, CoachState } from "./types";

/** How long we wait after a call goes live with zero coach events before
 * surfacing the "coach connecting…" degraded pill. */
const DEGRADED_TIMEOUT_MS = 10_000;
/** Objection cards auto-dismiss after this long unless tapped away first. */
const OBJECTION_CARD_TTL_MS = 45_000;
/** Broadcast event name the coach service publishes on `coach:{call_id}`. */
const COACH_BROADCAST_EVENT = "coach_event";

/**
 * Subscribes to the coach service's Supabase Realtime Broadcast channel for
 * one call (`coach:{callId}`), reduces incoming CoachEvents into CoachState,
 * auto-expires objection cards, and flags a degraded (no-data) state so the
 * UI can fall back to a static, manually-scrollable script.
 */
export function useCoachChannel(callId: string | null, startingPhaseId: CoachPhaseId = "introduction") {
  const [state, dispatch] = useReducer(coachReducer, startingPhaseId, initialCoachState);
  const [degraded, setDegraded] = useState(false);
  const dismissedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!callId) return;
    let mounted = true;
    const degradedTimer = window.setTimeout(() => {
      if (mounted) setDegraded(true);
    }, DEGRADED_TIMEOUT_MS);

    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const start = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel(`coach:${callId}`)
        .on("broadcast", { event: COACH_BROADCAST_EVENT }, (message) => {
          window.clearTimeout(degradedTimer);
          if (mounted) setDegraded(false);
          dispatch(message.payload as CoachEvent);
        })
        .subscribe();
    };

    void start();
    return () => {
      mounted = false;
      window.clearTimeout(degradedTimer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [callId]);

  useEffect(() => {
    const timers = state.objectionCards
      .filter((card) => !dismissedRef.current.has(card.id))
      .map((card) => {
        dismissedRef.current.add(card.id);
        return window.setTimeout(() => {
          dispatch({ type: "dismiss_objection", cardId: card.id });
        }, OBJECTION_CARD_TTL_MS);
      });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [state.objectionCards]);

  return { state, dispatch, degraded };
}

export type UseCoachChannelResult = {
  state: CoachState;
  dispatch: (action: CoachEvent) => void;
  degraded: boolean;
};
