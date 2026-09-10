# Sandra latency source map — September 10, 2026

Scope: identify the sources before choosing a lasting database redesign. No production configuration, schema, or customer data was changed. This work builds on reviewed PR #514; that PR has not established a production speedup.

## Ranked evidence

| Source | Evidence | Confidence / limitation |
| --- | --- | --- |
| Whole-inbox reconstruction before pagination | Production function groups message history, finds latest messages/properties, joins contact/property/thread state, looks up consent per conversation, applies suppression/search classification, counts all filters, and only then limits rows. Current PostgREST statement entries average 2,576.9ms over13,975 calls and3,800.1ms over1,329 calls; maxima14,463.5ms and14,880.5ms. | Confirmed major backend cost. Accumulated averages combine traffic/parameters over their collection windows; they are not today's p95. |
| Message click waits on page reconstruction | Production selection calls router.replace. Production browser baseline: click→detail DOM3618ms; corresponding Messages RSC response3367.7ms. | Confirmed in code and measured in one sample. PR514 removes this dependency for local selection, but does not eliminate every rebuild. |
| Repeated background rebuilds | InboxThreadList subscribes to message INSERT/UPDATE, message_threads and AI review changes. Events feed useThrottledRefresh, with10-second minimum interval per hook instance. Reading unread messages can produce an UPDATE and a background refresh. | Confirmed workload amplifier. Not a global throttle; active clients can each refresh. Hidden documents defer refresh. Actual daily event/client concurrency not yet measured. |
| Large intermediates and temporary writes | Fresh prior authenticated default probe:2783.1ms,797900 shared buffer hits,13946 temporary blocks written (~109MiB at8KiB). Current accumulated statement entries have substantial temp writes. work_mem is5MiB. | Confirmed temporary storage use; exact disk-time contribution is unknown because track_io_timing is off. Cached buffer hits do not mean the query is cheap. Do not raise global work_mem from this evidence alone. |
| Sequential server dependencies | Messages waits for the main result group, then resolves membership/team identity labels; loadOrgTeamMembers can paginate Auth Admin listUsers. Lead detail contains sequential eSign, neighbors, preferences, mark-read, message/activity/tag/template reads. | Code-confirmed waits, not individually timed. Some are true dependencies; only independent reads can safely run concurrently. |
| External imagery on lead critical path | Production lead page awaits Street View metadata. Timeout4s; successful/no-coverage results cached in process for15min with500-entry maximum; fetch uses no-store. Failures are not cached. | Code-confirmed variable wait, not a measured4s delay on every click. Lead click baseline2476.4ms. Process/cache churn may contribute to variability, but a one-day cycle has not been established. PR514 streams imagery separately. |
| Leads board loading | Baseline Messages→Leads cards956.2ms. Earlier fresh urgency-count probe25.4ms, simplified core8.1ms using existing indexes. Board requires additional card, roster and decoration reads. | Overall delay measured once; count query is not proven to dominate this page. |

Production inbox function body matches the checked-in September9 search migration exactly: MD5 `5bfab134887e615681f6df65c5edf889`,17,790 characters. This is a drift check, not a security hash.

## What the evidence does not establish

- No lock wait was present in the sampled connection state; a snapshot cannot exclude transient contention.
- Recent automatic analysis exists for messages, properties and message_threads. Contacts show20,420 changes since analysis. Dead-row estimates exist, but neither bloat nor stale plans has been established as the dominant cause.
- No measurements yet isolate Vercel cold starts, function queuing, CPU utilization, database I/O latency, or regional network overhead.
- The precise “fast for a day, then slow” pattern remains unproven. The15-minute imagery cache is not evidence of a24-hour cycle.
- Existing indexes include the partial SMS `(org_id, conversation_id, created_at DESC, id DESC)` index with included fields, plus conversation/property/task indexes. Additional indexes remain candidates if query plans demonstrate benefit; existing indexes alone do not prove indexing is exhausted.
- Browser values are single warm-session baseline samples to expected DOM presence, not exact paint, percentiles, or after-change results.

## Provider documentation and application

- [PostgreSQL17 EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html): use actual execution, loops and buffers to localize cost; an outer RPC time is not a per-node breakdown.
- [PostgreSQL17 statement statistics](https://www.postgresql.org/docs/17/pgstatstatements.html): identify rows by database/user/query/top-level tuple and respect collection resets. Compare deltas over time instead of comparing cumulative averages as if they were daily samples.
- [PostgreSQL CTE materialization](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-CTE-MATERIALIZATION): materialization can prevent predicate pushdown; changing it requires checking repeated computation and actual plans.
- [Supabase query optimization](https://supabase.com/docs/guides/database/query-optimization): evaluate index candidates against query plans, statistics and write cost.
- [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes): realtime has its own authorization/throughput considerations. This application's additional full-page refresh is a separate source of repeated work.
- [Next.js data fetching](https://nextjs.org/docs/app/getting-started/fetching-data) and [useRouter](https://nextjs.org/docs/app/api-reference/functions/use-router): parallelize independent requests and stream slow sections; router.refresh requests server data again.
- [Vercel Observability](https://vercel.com/docs/observability): function/request evidence is required before attributing latency to hosting infrastructure. Those timings have not yet been collected here.
- [Google Street View metadata](https://developers.google.com/maps/documentation/streetview/metadata): metadata is a separate provider request. Our4s timeout and15min cache are application policies, not provider guarantees.

Supabase's current changelog was fetched; no relevant database-query API breaking change was identified. Installed Next version for this reviewed branch is16.2.4; database major version17.

## Next measurements and implementation gate

The companion `scripts/performance/inbox-latency-snapshot.sql` collects read-only, content-free counters for comparison over several days. With stable statement identities and stats_since, compute interval mean as delta(total_exec_time)/delta(calls), and temporary blocks per call as delta(temp_blks_written)/delta(calls). A reset starts a new baseline. Neither these counters nor max_exec_time provides interval p95.

Before selecting a maintained summary or query rewrite, compare actual plan-node costs, preserve cutoff semantics and all filters/counts, and prove freshness for message changes, opt-outs, suppression, assignment, AI review and tenant authorization. A summary that becomes stale would replace a performance problem with a correctness problem.
