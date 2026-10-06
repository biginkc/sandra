export type CallLockSource = 'dialpad' | 'softphone';

export const CALL_LOCK_MESSAGE = 'Finish your current call before starting another.';

export interface CallLock {
  /** Take the lock for `source`. True when it is free or already held by the same source; false when the other dialer holds it. Synchronous, so two clicks in one tick cannot both win. */
  acquire(source: CallLockSource): boolean;
  /** Release only if `source` holds it (a stale release from the other dialer is a no-op). */
  release(source: CallLockSource): void;
  holder(): CallLockSource | null;
  subscribe(listener: () => void): () => void;
}

/**
 * One active-or-pending call at a time across Dialpad and the Telnyx softphone. Each dialer acquires at its
 * lowest dial entry and releases when the call (or its pending retry countdown) reaches a terminal state.
 */
export function createCallLock(): CallLock {
  let current: CallLockSource | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    acquire(source) {
      if (current !== null && current !== source) return false;
      if (current !== source) {
        current = source;
        emit();
      }
      return true;
    },
    release(source) {
      if (current !== source) return;
      current = null;
      emit();
    },
    holder: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
