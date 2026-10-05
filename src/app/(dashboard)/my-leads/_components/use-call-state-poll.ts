"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { pollMyLeadsCallStateAction } from "../call-state-actions";
import {
  EMPTY_CALL_STATE,
  type AmbiguousCallItem,
  type CallbackDueItem,
  type CallPromptItem,
  type CallStateSnapshot,
} from "@/lib/my-leads/call-state";

type Options = { enabled: boolean; suspended: boolean; intervalMs?: number; backoffMs?: number };

type Result = {
  state: CallStateSnapshot;
  prompts: CallPromptItem[];
  ambiguous: AmbiguousCallItem[];
  callbacksDue: CallbackDueItem[];
  error: string | null;
  refreshNow: () => void;
  loadMorePrompts: () => void;
};

const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

/** Visibility-gated, non-overlapping poll of the durable call state. */
export function useCallStatePoll({ enabled, suspended, intervalMs = 10_000, backoffMs = 30_000 }: Options): Result {
  const [state, setState] = useState<CallStateSnapshot>(EMPTY_CALL_STATE);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<CallStateSnapshot>(EMPTY_CALL_STATE);
  const suspendedRef = useRef(suspended);
  useEffect(() => {
    suspendedRef.current = suspended;
  }, [suspended]);
  const controls = useRef<{ fetchNow: (more: boolean) => void }>({ fetchNow: () => {} });
  const prevSuspended = useRef(suspended);

  useEffect(() => {
    if (!enabled) {
      stateRef.current = EMPTY_CALL_STATE;
      controls.current = { fetchNow: () => {} };
      return;
    }
    let alive = true;
    let inFlight = false;
    let backedOff = false;
    // No polled flag is on for the org: stop the timer instead of re-reading flags every interval.
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (idle) return;
      timer = setTimeout(() => {
        if (!alive) return;
        if (isVisible()) fetchNow(false);
        schedule();
      }, backedOff ? backoffMs : intervalMs);
    };

    const fetchNow = (more: boolean) => {
      if (!alive || inFlight || suspendedRef.current) return;
      const cursor = stateRef.current.promptsCursor;
      if (more && !cursor) return;
      inFlight = true;
      const done = (ok: boolean, snapshot?: CallStateSnapshot, message?: string) => {
        inFlight = false;
        if (!alive) return;
        if (ok && snapshot) {
          let next = snapshot;
          idle = snapshot.idle === true;
          const failed = snapshot.failedSurfaces ?? [];
          if (failed.length > 0) {
            // A failed read keeps its last good value; only the successful parts update.
            const prev = stateRef.current;
            next = {
              ...snapshot,
              prompts: failed.includes("prompts") ? prev.prompts : snapshot.prompts,
              promptsCursor: failed.includes("prompts") ? prev.promptsCursor : snapshot.promptsCursor,
              callbacksDue: failed.includes("callbacks") ? prev.callbacksDue : snapshot.callbacksDue,
              ambiguous: failed.includes("ambiguous") ? prev.ambiguous : snapshot.ambiguous,
            };
          }
          if (more) {
            const seen = new Set<string>();
            const prompts = [...stateRef.current.prompts, ...snapshot.prompts].filter((p) => {
              if (seen.has(p.attemptId)) return false;
              seen.add(p.attemptId);
              return true;
            });
            next = { ...next, prompts };
          }
          stateRef.current = next;
          setState(next);
          setError(failed.length > 0 ? "Some call state could not refresh." : null);
          backedOff = failed.length > 0;
        } else {
          setError(message ?? "Could not refresh call state.");
          backedOff = true;
        }
        schedule();
      };
      pollMyLeadsCallStateAction(more && cursor ? { promptsCursor: cursor } : undefined).then(
        (res) => (res.ok ? done(true, res.state) : done(false, undefined, res.message)),
        (err: unknown) => done(false, undefined, err instanceof Error ? err.message : undefined),
      );
    };

    controls.current = { fetchNow };
    const onVisibility = () => {
      if (isVisible()) fetchNow(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (isVisible()) fetchNow(false);
    schedule();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      controls.current = { fetchNow: () => {} };
    };
  }, [enabled, intervalMs, backoffMs]);

  useEffect(() => {
    const was = prevSuspended.current;
    prevSuspended.current = suspended;
    if (was && !suspended && enabled && isVisible()) controls.current.fetchNow(false);
  }, [suspended, enabled]);

  const refreshNow = useCallback(() => controls.current.fetchNow(false), []);
  const loadMorePrompts = useCallback(() => controls.current.fetchNow(true), []);

  const current = enabled ? state : EMPTY_CALL_STATE;
  return {
    state: current,
    prompts: current.prompts,
    ambiguous: current.ambiguous,
    callbacksDue: current.callbacksDue,
    error: enabled ? error : null,
    refreshNow,
    loadMorePrompts,
  };
}
