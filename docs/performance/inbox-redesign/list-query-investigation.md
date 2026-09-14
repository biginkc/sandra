# Local Inbox list query investigation

September 13, 2026. Read-only investigation of candidate 1's remaining list cost; no optimization, index, migration, provider, or production change. Numerical list acceptance remains pending user approval.

## Result

The existing list query does substantial work for the entire eligible tenant history before returning 200 conversations. The inspected local plan groups 550,500 messages into 55,000 conversations, sorts the message set on disk, hydrates/classifies all 55,000 conversations, and computes counts before applying the page limit. This is verified local evidence of dataset-sensitive work, not proof of production root cause.

## Safety and method

- Exclusively owned `sandra-inbox-redesign-20260913` Docker project/context, fixed loopback database port 58422. Used `scripts/lib/inbox-baseline-target.mjs`, explicit PostgreSQL connection configuration, and checked dedicated container labels/port before the first probe. No production environment files or connection fallback.
- `BEGIN READ ONLY`, 15-second statement timeout and two-second lock timeout. Rolled back both transactions. No fixtures or database settings were persistently changed.
- Used the synthetic BMH tenant and its existing synthetic member identity from the private local fixture file. Set transaction-local JWT claims and `SET LOCAL ROLE authenticated`, so RLS and the function's authenticated-user branch applied. This is ordinary database-role access; it is not HTTP/JWT-provider verification or browser measurement.
- First ran `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` over the deployed SQL function's extracted body with typed bound arguments. This exposes nested work hidden by the SQL function wrapper, but is not proof that its parameter-specialized plan exactly matches the wrapper's cached internal plan.
- Separately ran one bounded `EXPLAIN ANALYZE` of the actual `sms_inbox_thread_page_snapshot` function call. No warmed/cold-cache guarantee, no controlled concurrency, no repeated statistical sample.
- Arguments: 90-day cutoff, `all` filter, requesting member as assignee argument, no pinned thread, hide noise, limit 200, offset zero, no search.
- Persisted only sanitized observations below. No raw plans, identities, credentials, customer bodies, or query result documents retained in this report.

## Verified source and local catalog

The local function body exactly matches the first function in `supabase/migrations/20260909080000_messages_search.sql` after trimming outer whitespace. SHA-256 of the catalog's untrimmed body: `cb84f1fae32da6daf7c79751624850657ed33071a727613c9863186df054a401`. It is SECURITY INVOKER with a 15-second function statement timeout.

Relevant source stages:

- `src/lib/messages/list-threads.ts:448`: list read requests the snapshot RPC, including counts and pagination in the same response.
- `supabase/migrations/20260909080000_messages_search.sql:68`: eligible recent messages and per-conversation `row_number`.
- `supabase/migrations/20260909080000_messages_search.sql:95`: materialized grouped conversations with unread counts and latest-property fallback.
- `supabase/migrations/20260909080000_messages_search.sql:212`: materialized contact/property/thread/consent hydration and search filtering.
- `supabase/migrations/20260909080000_messages_search.sql:318`: counts for the filters over classified conversations.
- `supabase/migrations/20260909080000_messages_search.sql:373`: late page limit after filtering and total/hidden-count work.

The useful composite partial index already exists: `idx_messages_sms_inbox_org_conversation_latest (org_id, conversation_id, created_at DESC, id DESC) INCLUDE (contact_id, property_id, direction, read_at)`, excluding queued/paused and unlinked/non-SMS rows. Do not propose adding this same index as if it were absent. Separate created-at and org indexes also exist.

Local settings: `work_mem=4MB`, `shared_buffers=128MB`. Database contained 1,112,250 messages across retained synthetic fixtures; the tested tenant contained 550,750 messages, of which 550,500 were linked messages. This is a modeled fixture, not measured production distribution. Unknown messages numbered 250; no pending AI reviews exercised the old-review branch.

## Observations

| Measurement | Observed result |
|---|---:|
| Extracted-body execution / planning | 1,894.529 ms / 7.421 ms |
| Actual function-call execution / planning | 1,451.494 ms / 0.018 ms |
| Extracted plan recent messages processed | 550,500 |
| Grouped and hydrated conversations | 55,000 |
| Message ranking sort | External merge, 75,488 kB disk space |
| Recent grouping cumulative time | 1,147.725 ms |
| Core hydration cumulative time | 1,542.010 ms |
| Latest-consent index probes | 55,000 loops, even with no matching consent rows |
| Final page sorting/limit stage | 200 rows, 7.896 ms cumulative at that stage |
| Actual wrapper temporary blocks read / written | 25,783 / 30,958 |

Plan node times include their children and must not be added together. Buffer reads may be served by the operating system cache and are not proof of physical disk latency. The first diagnostic and subsequent wrapper run have different cache conditions.

The extracted plan chose `idx_messages_created`, considering 1,112,446 index entries before the tenant and other predicates yielded 550,500 rows. It did not choose the available tenant/conversation ordering index for this scan. Heap scan time was 576.048 ms and ranking-sort cumulative time was 936.551 ms. Properties, contacts and thread records were then joined for every eligible conversation. Several wide materialized CTEs spilled/re-scanned temporary data. Final JSON hydration over only 200 rows was comparatively small.

These results are consistent with the earlier ordinary-member source-read observations: the 1,000-conversation fixture list p50 was about 30 ms, while the 55,000-conversation fixture was about 1,274 ms. Those runs preceded the extra browser tenant and are not identical database/cache conditions to this investigation.

## Candidate-1 options to test, not implemented or approved as passing

1. **Keep conversation switching independent of list recomputation.** This directly avoids making a detail click await this broad aggregation. It does not fix initial list loading or search/filter latency.
2. **Prototype a more explicit authenticated tenant access path in isolated SQL.** Investigate whether the `current_user` disjunction plus visible-org subquery/RLS prevents an efficient tenant-constrained access path. The plan proves the chosen broad created-at scan; it does not prove why the planner chose it. Compare validated tenant-constrained joins against existing semantics, with ordinary-role RLS, before changing SQL. Preserve authorization and ambiguous-organization handling.
3. **Separate independently refreshed counts from page delivery.** Exact counts and offset clamping currently require classifying the eligible set. Moving counts off the critical path may help, but merely splitting identical expensive queries would duplicate work. Preserve visible count-loading/error states and pagination correctness; benchmark total work as well as first-row latency.
4. **Reduce wide materialization and defer display-only hydration.** Examine whether narrower intermediate rows and late contact/address/body hydration reduce sort/CTE spill. Eligibility fields needed for filters, DNC hiding, search, and pending AI review must remain authoritative before deciding page membership. Naively limiting to 200 before applying eligibility would silently drop valid rows and is not acceptable.
5. **Treat work-memory changes as a diagnostic only.** The observed spill makes this worth a bounded transaction-local sensitivity test, not a recommendation to raise global settings. Memory is per operation/worker, and concurrent users can multiply usage. No such change was made here.

Do not jump straight to a new vendor or maintained projection from this single plan. Candidate 1 still has concrete experiments. If it cannot meet approved budgets without changing semantics or moving excessive work elsewhere, compare the plan's bounded summary/synchronization candidate using the same fixture and correctness checks.

## Still required

Frozen user-approved list/search/filter targets; authenticated browser initial-load evidence; realistic tenant/history/consent/review skew; search and alternate filters; repeated same-fixture candidate comparisons; incoming activity and concurrent operators; complete old/new Inbox and Outbox regression coverage. This report satisfies none of those gates by itself.
