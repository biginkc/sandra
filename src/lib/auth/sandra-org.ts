const PRODUCTION_SANDRA_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

/**
 * The acceptance harness owns a disposable organization per run. Keep the
 * production tenant immutable while allowing the harness-only web server to
 * exercise the same middleware and membership gates against that tenant.
 */
export const SANDRA_ORG_ID =
  process.env.INBOX_ACCEPTANCE_RUN === "1" &&
  process.env.INBOX_ACCEPTANCE_ORG_ID?.trim()
    ? process.env.INBOX_ACCEPTANCE_ORG_ID.trim()
    : PRODUCTION_SANDRA_ORG_ID;
