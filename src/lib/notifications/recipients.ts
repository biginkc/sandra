/**
 * Pure recipient resolvers — encode the "who gets the notification"
 * decisions from the Feature 7 plan:
 *
 *   Decision #1 — self-assignment suppressed.
 *   Decision #3 — prior assignee NOT notified on reassignment (absent
 *                 from this file by design; no resolver for it).
 *   Decision #6 — unassigned property inbound SMS → all admins.
 *
 * No DB access here. Callers resolve `assignedUserId` / `adminUserIds`
 * upstream and pass them in so these stay trivially testable.
 */

/**
 * Who should receive a notification when a regular inbound SMS arrives?
 * Assignee wins over admin fallback — a lead with a named owner has a
 * clear recipient. Falls back to all admins only when unassigned.
 */
export function resolveOwnerMessageRecipients(params: {
  assignedUserId: string | null;
  adminUserIds: readonly string[];
}): string[] {
  if (params.assignedUserId) {
    return [params.assignedUserId];
  }
  return [...params.adminUserIds];
}

/**
 * Who should receive a notification when a lead is assigned? Only the
 * new assignee, and only if it isn't the same user who performed the
 * assignment (self-assign suppressed — decision #1). Unassigning a
 * lead (newAssigneeId = null) never produces a notification.
 */
export function resolveAssignmentRecipients(params: {
  newAssigneeId: string | null;
  actorId: string | null;
}): string[] {
  if (!params.newAssigneeId) return [];
  if (params.newAssigneeId === params.actorId) return [];
  return [params.newAssigneeId];
}

/**
 * Who should receive a notification when a job terminates? The user who
 * kicked it off. System-created jobs (createdBy null) notify nobody.
 */
export function resolveJobRecipients(params: {
  createdBy: string | null;
}): string[] {
  if (!params.createdBy) return [];
  return [params.createdBy];
}
