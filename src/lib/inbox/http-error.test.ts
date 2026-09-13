import { describe, expect, it } from "vitest";
import { inboxDatabaseError } from "./http-error";
describe("canonical SQL domain HTTP mapping", () => {
  it.each([
    ["42501", "INBOX_AUTH_REQUIRED", 401], ["42501", "INBOX_SESSION_REVOKED", 401],
    ["42501", "INBOX_SESSION_EXPIRED", 401], ["42501", "INBOX_ORG_DENIED", 403],
    ["42501", "INBOX_REPLACEMENT_DENIED", 403], ["42501", "INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", 403],
    ["22023", "INBOX_INVALID_WORKSET", 400], ["55000", "INBOX_GENERATION_RATE", 429], ["55000", "INBOX_GENERATION_LIMIT", 429],
    ["42501", "INBOX_ACCESS_BASELINE_MISSING", 503], ["42501", "permission denied for function", 503],
    ["PGRST301", "JWT signature rejected", 401], ["PGRST303", "JWT expired", 401], ["PGRST202", "missing schema", 503], ["unknown", "INBOX_ORG_DENIED", 503],
  ])("maps exact domain %s/%s to %s without exposing database text", (code, message, status) => {
    const error = inboxDatabaseError({ code, message }); expect(error.status).toBe(status); expect(error.message).toBe("Inbox unavailable");
  });
});
