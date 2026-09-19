"use client";
import { useEffect, useState } from "react";
import type { InboxQueryIdentity } from "@/lib/inbox/workspace-query";
export type AccessLease = "checking" | "valid" | "unavailable" | "denied";
/** Authority is never put in Query's data cache. A request-start anchored lease
 * cannot gain extra lifetime from a slow response. Hidden tabs recheck on resume.
 */
export function useInboxAccessLease(identity: InboxQueryIdentity & { expiresAt: number }): AccessLease {
  const [state, setState] = useState<AccessLease>("checking");
  useEffect(() => {
    let stopped = false, generation = 0;
    let request: AbortController | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      request?.abort(); clearTimeout(refresh);
      const controller = new AbortController(); request = controller;
      const token = ++generation, started = Date.now();
      try {
        const response = await fetch("/api/inbox/context", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]), credentials: "same-origin", redirect: "error", cache: "no-store" });
        if (controller.signal.aborted || stopped || token !== generation) return;
        if (response.status === 401 || response.status === 403) { stopped = true; clearTimeout(deadline); setState("denied"); return; }
        if (!response.ok) throw Error("Authority unavailable");
        const value = await response.json();
        if (controller.signal.aborted || stopped || token !== generation) return;
        if (["orgId", "userId", "sessionId", "accessEpoch"].some(key => value[key] !== identity[key as keyof InboxQueryIdentity])) { stopped = true; clearTimeout(deadline); setState("denied"); return; }
        const until = Math.min(started + 15_000, value.expiresAt, identity.expiresAt);
        if (!Number.isFinite(until) || until <= Date.now()) throw Error("Expired authority response");
        clearTimeout(deadline);
        setState("valid"); deadline = setTimeout(() => setState("unavailable"), until - Date.now());
        refresh = setTimeout(() => void check(), Math.min(10_000, until - Date.now()));
      } catch {
        if (!controller.signal.aborted && !stopped && token === generation) {
          // A transport failure is not a canonical denial. Existing visibility
          // expires at its original deadline; retry does not extend authority.
          if (!deadline) setState("unavailable");
          refresh = setTimeout(() => void check(), 5_000);
        }
      }
    };
    const visibility = () => {
      request?.abort(); generation++; clearTimeout(refresh); clearTimeout(deadline); deadline = undefined;
      if (!stopped) { setState("checking"); void check(); }
    };
    void check(); document.addEventListener("visibilitychange", visibility);
    return () => { stopped = true; request?.abort(); clearTimeout(refresh); clearTimeout(deadline); document.removeEventListener("visibilitychange", visibility); };
  }, [identity]);
  return state;
}
