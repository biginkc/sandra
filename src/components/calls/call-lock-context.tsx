"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

import { createCallLock, type CallLock, type CallLockSource } from "@/lib/calls/call-lock";

const CallLockContext = createContext<CallLock | null>(null);

/** Owned above both the softphone and Dialpad providers so they share one lock. */
export function CallLockProvider({ children }: { children: ReactNode }) {
  const [lock] = useState(createCallLock);
  return <CallLockContext.Provider value={lock}>{children}</CallLockContext.Provider>;
}

/** The shared lock, or a private one when rendered outside the dashboard (tests, isolated use). */
export function useCallLock(): CallLock {
  const shared = useContext(CallLockContext);
  const [fallback] = useState(createCallLock);
  return shared ?? fallback;
}

/** Reactive: who currently holds the lock (null when free). */
export function useCallLockHolder(): CallLockSource | null {
  const lock = useCallLock();
  return useSyncExternalStore(lock.subscribe, lock.holder, () => null);
}
