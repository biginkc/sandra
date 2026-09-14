import "server-only";
/** Only allowlisted domain failures cross the HTTP boundary. Exception text stays private. */
export class InboxHttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 429 | 503) { super("Inbox unavailable"); }
}
export function inboxDatabaseError(error: unknown): InboxHttpError {
  if (!error || typeof error !== "object") return new InboxHttpError(503);
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "PGRST301" || code === "PGRST303") return new InboxHttpError(401);
  if (code === "42501") {
    if (["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(String(message))) return new InboxHttpError(401);
    if (["INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", "INBOX_ORG_DENIED", "INBOX_REPLACEMENT_DENIED", "INBOX_CURSOR_DENIED"].includes(String(message))) return new InboxHttpError(403);
  }
  if (code === "22023" && ["INBOX_INVALID_WORKSET", "INBOX_FILTER_INVALID"].includes(String(message))) return new InboxHttpError(400);
  if (code === "55000" && ["INBOX_GENERATION_RATE", "INBOX_GENERATION_LIMIT"].includes(String(message))) return new InboxHttpError(429);
  return new InboxHttpError(503);
}
