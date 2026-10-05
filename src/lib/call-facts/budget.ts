/**
 * One cron run's time budget and the claim window, in one place.
 *
 * Worst case for ONE claimed call: one choice request, then up to MAX_SCORED_TURNS yes/no requests
 * with SCORING_CONCURRENCY in flight, every request taking its full timeout and never retrying.
 * budget.test.ts asserts the worst case stays well under the route's maxDuration and the lease
 * stays above it, so a lease cannot expire mid-run and trigger reprocessing.
 */
/** Only calls that ended within this many hours are claimed (no backlog sweep). Pre-enable gate: Jarrad to confirm. */
export const CLAIM_WINDOW_HOURS = 48;
/** Calls claimed per cron run. */
export const CLAIM_BATCH = 1;
/** Per-request timeout, and no per-request retries (a failed call is retried by the lease instead). */
export const FACTS_REQUEST_TIMEOUT_MS = 8_000;
export const FACTS_REQUEST_RETRIES = 0;
export const MAX_SCORED_TURNS = 40;
export const SCORING_CONCURRENCY = 4;
/** Must equal the literal in the route (`export const maxDuration`), which Next reads statically. */
export const ROUTE_MAX_DURATION_S = 300;
/** Longer than the route can run, so a live run never loses its lease. */
export const CLAIM_LEASE_SECONDS = 900;

export const worstCaseWaves = (): number => 1 + Math.ceil(MAX_SCORED_TURNS / SCORING_CONCURRENCY);
export const worstCaseRequests = (): number => 1 + MAX_SCORED_TURNS;
export const worstCaseMsPerCall = (): number => worstCaseWaves() * FACTS_REQUEST_TIMEOUT_MS * (FACTS_REQUEST_RETRIES + 1);
