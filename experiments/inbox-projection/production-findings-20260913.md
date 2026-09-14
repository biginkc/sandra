# Production evidence changes the next performance investigation

On 2026-09-13 the newly available Supabase connector successfully executed two
bounded READ ONLY transactions against the project identified by the production
migration workflow: sandra-crm, copflsklaefwzipsrjqz. Earlier CLI Unauthorized
observations remain historical evidence, not the current access state.

No customer message bodies, phone numbers, names or row IDs were exported. No
schema, settings, rows, replication slots or hosting resources were changed.
The queries used five-second statement and 500ms lock timeouts. Retained JSON
contains catalog metadata and aggregate distributions only.

The first catalog sample estimates 125,115 message rows with 206,684,160 total
bytes including indexes (about197MiB). Estimates are not exact counts. A second
aggregate snapshot counted125,948 messages:14,999 inbound received and110,949
outbound across delivered/sent/failed/paused/queued. These include all organizations
and whatever test/canary records currently exist; this is not a count of active
Inbox work or customer-only traffic.

There are100,724 scoped SMS conversation identities with nonnull conversation IDs.
Their history lengths are p50=1,p95=3,p99=5,max44. This is materially different
from the100,000-message single-conversation stress fixture. That stress test
remains useful worst-case query evidence, but must not be presented as the
representative production distribution. Next tests should emphasize many small
conversations, filtered list/count/search aggregation, authorization work and
client request waterfalls. Per-conversation history volume alone is currently
an unlikely explanation for everyday switching latency; actual traces/plans are
still needed to establish a cause.

PostgreSQL17.6 reports logical WAL,10 configured slots,10 WAL senders,90 maximum
connections,4 logical replication workers and6 worker processes. Two current
logical slots are active. These settings do not certify an Electric deployment,
network reachability, sustained WAL capacity, spare connection budget or spending
approval. A slightly negative sampled LSN difference is a sampling race, not
negative lag. No slot was created.

The catalog has the existing scoped SMS Inbox index; it has no new Inbox summary,
operation, saved-action or send-attempt tables. The new system is not deployed.
Catalog fingerprints still need comparison with the canonical fixture before
migration design is declared equivalent. Cumulative stats are not interval rates,
and a null reset timestamp does not prove resets never occurred. No arrival-per-
second or end-user p95 latency claim follows from these samples.

Next: compare deployed source function/index/policy fingerprints, measure the
existing list/detail request costs under representative many-short-conversation
fixtures, finish unified capture/fanout/expiry and authorized live adapters, then
validate the approved stack against the real workload and agreed budgets.

The subsequent read-only comparison checked all30 deployed noninternal triggers
on the preflight table allowlist against the owned canonical fixture. Enabled
states, trigger-definition fingerprints and function-definition fingerprints
matched for all30. This narrows catalog uncertainty but does not cover untriggered
functions, index/policy semantics, disabled privileged paths or runtime behavior.
