import { DIRECT_CALL_TERMINAL_STATUSES } from "./contract";
import type { DirectCallFullRow, DirectCallStore } from "./store";

/**
 * Lead enrollment pause ownership. Prepare pauses a lead's enrollments; when a lead call ends WITHOUT
 * connecting (any failure path), the server resumes them via the existing resume function. A connected
 * call's resume stays with wrap-up, and nothing is resumed while another non-terminal direct call is
 * still on the same property.
 */
export async function resumeLeadIfUnowned(
  deps: { store: DirectCallStore; resume: (propertyId: string, operatorUserId: string) => Promise<void>; report: (error: unknown, tag: string) => void },
  propertyId: string | null,
  operatorUserId: string,
  excludeCallId: string | null,
): Promise<void> {
  if (!propertyId) return; // unlinked manual and training calls never paused anything
  try {
    if (await deps.store.hasActiveCallForProperty(propertyId, excludeCallId)) return;
    await deps.resume(propertyId, operatorUserId);
  } catch (error) {
    // The scheduled call-in-progress sweeper is the durable backstop.
    deps.report(error, "direct_call_resume");
  }
}

/** Resume after a transition that moved a call from non-terminal to terminal without it ever connecting. */
export async function resumeAfterTransition(
  deps: Parameters<typeof resumeLeadIfUnowned>[0],
  before: Pick<DirectCallFullRow, "status">,
  after: DirectCallFullRow | null,
): Promise<void> {
  if (!after || DIRECT_CALL_TERMINAL_STATUSES.has(before.status) || !DIRECT_CALL_TERMINAL_STATUSES.has(after.status)) return;
  if (after.connected_at) return;
  await resumeLeadIfUnowned(deps, after.property_id, after.operator_user_id, after.id);
}
