export type CallLockSource = 'dialpad' | 'softphone';

/** Identity of one holder (one useApiDial instance, or the softphone). Only the owning token can re-acquire or release. */
export type CallLockToken = symbol;

export const CALL_LOCK_MESSAGE = 'Finish your current call before starting another.';

export interface CallLock {
  /** Take the lock. True when it is free or already held by this same token; false when any other holder has it. Synchronous, so two clicks in one tick cannot both win. */
  acquire(source: CallLockSource, token: CallLockToken): boolean;
  /** Release only if `token` owns the lock; any other release (another hook instance, a stale cleanup) is a no-op. */
  release(token: CallLockToken): void;
  /** The holder's dialer type, for the UI. */
  holder(): CallLockSource | null;
  subscribe(listener: () => void): () => void;
}

/**
 * One active-or-pending call at a time across Dialpad and the Telnyx softphone. Each dialer acquires at its
 * lowest dial entry and releases when the call (or its pending retry countdown) reaches a terminal state.
 */
export function createCallLock(): CallLock {
  let current: { source: CallLockSource; token: CallLockToken } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    acquire(source, token) {
      if (current !== null) return current.token === token;
      current = { source, token };
      emit();
      return true;
    },
    release(token) {
      if (current === null || current.token !== token) return;
      current = null;
      emit();
    },
    holder: () => current?.source ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
