import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";

/**
 * Messages actions are callable independently of the /messages page. Keep
 * the same fail-closed shared-workspace boundary at every server-action
 * entry point, including actions invoked from stale or forged clients.
 */
export async function assertMessagesWorkspaceAccess(): Promise<void> {
  const memberships = await getCallerMembershipsOrThrow();
  if (!canAccessMessagesAndLeadsBoard(memberships)) {
    throw new MessagesWorkspaceAccessError();
  }
}

export class MessagesWorkspaceAccessError extends Error {
  constructor() {
    super("Messages workspace access is unavailable.");
    this.name = "MessagesWorkspaceAccessError";
  }
}
