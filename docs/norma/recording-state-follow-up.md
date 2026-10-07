# Delayed outbound recording availability

This integrated follow-up depends on the reviewed canonical #792/#793 runtime `09de75fdf6cb71808a681a40fd1c432d4a5ee40d` (schema parent `6b3e5d2fec667e88d5c35c3488faf48f82a8d66e`), which subsumes protected playback from #825. It remains a separate release follow-up and must not block canonical #793 absent a concrete regression. Migration `20261008140100` is reserved by Master for local preparation only. Revalidate the hosted high-water and canonical dependency before publication; the reservation does not admit shared application or guarantee release order. No hosted migration, environment change, provider request or schedule was performed for preparation.

The ledger keys each recording by request and attempt, deriving provider call IDs exclusively from existing request rows. Legacy requests use `bland_call_id` for attempt 1. Retry rows use `first_bland_call_id` for attempt 1 and `bland_call_id` for attempt 2. JSON row projection avoids requiring the retry schema on legacy deployments. Seeding is capped at 100 new identities per run and never resets evidence. A unique provider identity prevents a call being attributed to multiple attempts. Tenant read access follows the parent request's existing RLS; authenticated users cannot write the ledger or invoke service functions.

No recording trigger or lookup is added to dispatch, completion, webhook, outcome or notification transactions. A separate service sweep pulls committed identities. Recording failure therefore cannot roll back an outcome or delay Slack delivery. Availability is advisory: `reported_available` means the provider supplied recording evidence, not proof that audio played successfully. The browser receives attempt/state only and retains the existing authenticated audio endpoint. Expiring URLs are neither persisted nor sent to the browser.

## Reconciliation and failure behavior

Both `NORMA_RECORDING_RECONCILIATION_ENABLED` and the singleton database control's `enabled` must be explicitly enabled by the release coordinator. Both default off. The endpoint is not scheduled in `vercel.json`. It requires the existing cron secret and Bland key.

Each run takes a two-minute global lease, seeds at most 100 identities, and claims at most five due recordings. Each provider request is GET-only, fixed-host, redirect-denied, limited to eight seconds and 4 MiB decoded JSON. Evidence must match provider call ID, outbound direction, destination phone, and request metadata when present. There are at most six lookups per recording with exponential backoff starting at five minutes. Successful evidence is terminal and stale workers cannot overwrite it. Exhausted missing audio becomes unavailable; exhausted transport or invalid evidence becomes failed. Manual protected playback stays usable even if availability checks fail.

A 401/403 stops the entire batch and persists a disabled control with a denial timestamp. No alternate credential, endpoint or authorization mode is attempted. Re-enablement requires an admitted changed-access condition, an explicit database-control action and any exhausted-attempt recovery deemed necessary by the operator. Before each provider request, a write-ahead `awaiting_result` barrier is committed. A matching successful checkpoint clears it. A lost result or failed denial write leaves the barrier set, blocking new batches even after lease expiry. This intentionally requires operator recovery after an uncertain crash or database failure; it cannot silently retry a possible access denial. Denials disable the control even if a stale worker no longer owns the lease. No automatic reset or re-enablement is provided.

Claimed but unprocessed rows consume a claim attempt and backoff. When recovering a denied or uncertain batch, the operator must inspect and reset only unprocessed claims as appropriate; an exhausted claim does not prove that six actual provider requests occurred. Historical seeding excludes already-associated provider identities so conflicts cannot starve later records. Before activation, assess query duration on the actual request volume: the write batch is bounded, but its historical candidate scan is not indexed by a dedicated cursor.

## Release and rollback

1. Reconcile latest main/canonical dependency and reserve migration identity; update local-only integration inclusion/exclusion paths.
2. Re-run full verification and the dedicated disposable SQL suite; obtain integrated release review.
3. Use the established Root-owned test-to-production schema workflow. Keep both activation controls off.
4. Deploy runtime and verify tenant authorization, both attempt mappings and protected playback against owned evidence. User-reported recording capture alone does not prove playback.
5. Only after provider access admission, approve schedule, bounded lookup workload and activation. Do not retry the known provider 403 without a changed condition.
6. For rollback, disable the database control and runtime flag/schedule. The prior runtime ignores these additive tables/functions. Retain durable recording evidence; no reverse migration deleting it is required.

Provider field contract checked against https://docs.bland.ai/api-v1/get/calls-id on October 5, 2026. No provider response or customer transcript was collected for this implementation.
