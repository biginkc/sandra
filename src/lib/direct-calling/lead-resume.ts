import type { DirectCallStore } from "./store";

/** A claimed resume is not re-claimed by another session for this long. */
export const RESUME_LEASE_SECS = 30;

/**
 * Lead enrollment pause ownership. Prepare pauses a lead's enrollments. When a lead call becomes terminal
 * without having connected, direct_call_apply sets `resume_pending` on the call (atomically, and only when
 * no other non-terminal direct call is on the property). The resume itself needs the operator's own
 * authenticated session (the resume RPC refuses a service-role caller), so it is worked ONLY here, from
 * the operator's own server actions: status polls, start, and control. A connected call's resume stays
 * with wrap-up, and the flag is never set for it.
 *
 * `resume` is the existing resumeFailedSoftphoneCall, called unchanged. It swallows every error and
 * returns void, so a failed or refused resume is not visible here: the flag is cleared when it returns
 * without throwing. The scheduled call-in-progress sweeper is the backstop (same as the Jitter path).
 *
 * Re-checked at work time: if another direct call has since taken the property, that call owns the pause,
 * so the obligation is cleared without resuming.
 */
export async function processPendingResumes(
  deps: {
    store: DirectCallStore;
    resume: (propertyId: string) => Promise<void>;
    now: () => Date;
    report: (error: unknown, tag: string) => void;
  },
  operatorUserId: string,
): Promise<number> {
  let resumed = 0;
  try {
    const claimed = await deps.store.claimPendingResumes(operatorUserId, deps.now().toISOString(), RESUME_LEASE_SECS);
    for (const row of claimed) {
      try {
        if (row.property_id && !(await deps.store.hasActiveCallForProperty(row.property_id, row.id))) {
          await deps.resume(row.property_id);
          resumed += 1;
        }
        await deps.store.clearResumePending(row.id);
      } catch (error) {
        // Left set (leased): retried by a later action once the lease expires.
        deps.report(error, "direct_call_resume");
      }
    }
  } catch (error) {
    deps.report(error, "direct_call_resume");
  }
  return resumed;
}
