/**
 * SQLSTATE the My Leads RPCs raise for definite business conflicts (STALE_STATE,
 * STALE_ASSIGNMENT, IDEMPOTENCY_CONFLICT, ...). It is deliberately not 40001:
 * PostgREST retries serialization failures, and a stale check never succeeds on retry.
 */
export const MY_LEADS_CONFLICT_SQLSTATE = "MLS01";
