import "server-only";

// GL-4 (inbox-hardening PLAN.md G5): INBOX_WORKSPACE_SERVER_ENABLED is a
// process-wide switch. The first flip must be cohort-scoped, not global — an
// exact user-id allowlist checked server-side before any inbox_* RPC runs.
// Default empty = nobody. The DB serving gate (inbox_control.rollout) and
// inbox_t2_bridge.authorize/inbox_authorize_sync scope by org membership
// only; neither carries a per-user pilot list, so this allowlist is the
// mechanism (see PR description for the confirmation trail).
const PILOT_ENV_VAR = "INBOX_WORKSPACE_PILOT_USER_IDS";

export function inboxPilotAllowlist(raw: string | undefined = process.env[PILOT_ENV_VAR]): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export function isInboxPilotUser(userId: string | null | undefined): boolean {
  return !!userId && inboxPilotAllowlist().has(userId);
}

export interface InboxPilotAuthClient {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null } }> };
}

// Resolves the caller's canonical user id via Supabase Auth — never a
// domain inbox_* RPC — so the cohort check can fail closed before any
// RPC is created, matching the flag-check pattern already used by every
// /api/inbox route (see route.test.ts:29's "before RPC" style assertions).
export async function isInboxPilotRequest(client: InboxPilotAuthClient): Promise<boolean> {
  const { data } = await client.auth.getUser();
  const userId = data.user?.id;
  if (!userId) return false;
  // Every request remains cohort-scoped until a separately reviewed rollout
  // change replaces this gate. No environment value may bypass the allowlist.
  return isInboxPilotUser(userId);
}
