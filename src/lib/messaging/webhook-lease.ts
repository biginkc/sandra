/**
 * How long one webhook delivery may hold an inbound event while it processes it (insert, gates,
 * scheduling the delayed reply). Past this a redelivery may take the event over: a webhook
 * that has not finished by then is treated as dead.
 */
export const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;
