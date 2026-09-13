# Prepared history-query alternatives under newer-arrival noise

**Recommendation for the next bounded implementation:** select only covered keys (`id`, `created_at`) in a scoped `MATERIALIZED` CTE with `LIMIT 50`, then fetch bodies and inbound revisions by primary key. Keep the arrival head, limited keys, fetched bodies and final ordered JSON in **one SQL statement / MVCC snapshot**. Do not fetch the head in a separate HTTP request. This proof tests the history portion; the next integrated read RPC must prove that full contract again.

Eight checks passed. No data, index, statistics, global planner setting or application migration was changed. `run.py` is a read-only owner SQL harness against the existing 100,000-message target and 10,000 newer unrelated messages. It verifies the immutable offline fixture and disabled cron, rejects optimized Python before Docker, and uses bounded process/SQL timeouts. `plans.json` retains the failed direct custom plan as well as alternatives; `queries.json` contains the exact first-page statement shapes.

## Results

Second repeated sample, execution milliseconds; both samples are preserved:

| Shape | Custom first page | Generic first page | Custom cursor page | Generic cursor page |
| --- | ---: | ---: | ---: | ---: |
| Direct body selection | 4.330 | 0.062 | 0.106 | 0.062 |
| Limited key CTE + ordinary PK join | 0.225 | 0.236 | 0.192 | 0.193 |
| Limited key CTE + lateral PK lookup | 0.248 | 0.264 | 0.223 | 0.223 |

The direct custom first-page plan still scans `idx_messages_created` and rejects 10,617 unrelated rows. Its cursor performs better because the timestamp boundary skips newer noise. The direct generic plan happens to use the scoped history index on this fixture. That observation does not justify forcing generic plans in production.

The chosen ordinary-join shape uses `t2_proof_history_idx` to select 50 keys (37 on the cursor page), then `messages_pkey` once per key. Both samples under both cache modes are asserted to use that limited scoped scan and those PK lookups, with no global-created index scan. Exact ordered IDs match the independent direct query and the previously captured latest-50 IDs. Two 37-row pages match the first 74 IDs exactly using raw PostgreSQL timestamp text plus UUID; this cuts across ten-row timestamp ties.

The lateral shape added complexity with no observed benefit. Choose the ordinary join initially, and retain plan regression checks in the integrated fixture.

## Proposed statement boundary

The key CTE should project **only** `id` and `created_at`; fetching `body` or arrival revision before the limit would lose the covered-key benefit tested here. Join back using the primary key and repeat org/conversation/SMS scope predicates. Explicitly order the final output by the key timestamps and IDs; an outer JSON aggregate must also state its order.

The arrival head belongs in a sibling materialized CTE in the same statement. Its value controls later acknowledgement. History ordering remains `(created_at DESC, id DESC)` and does not use the head as a substitute for display ordering. The RPC must perform real requester/membership checks and return the final snapshot, not trust a caller-supplied boundary or canonical INSERT/UPDATE RETURNING.

## Why prepared plans were tested

Tenant/conversation values and cursor timestamp/UUID are true PREPARE parameters here; page size is a fixed server-side constant. Custom/generic modes were set using `SET LOCAL plan_cache_mode` inside read-only transactions, then inspected with `EXPLAIN EXECUTE`. There is no global setting change. PostgreSQL documents that automatic plan selection can switch after initial custom executions; actual RPC, driver and pool behavior must therefore be tested instead of extrapolating from literal SQL. [PostgreSQL PREPARE documentation](https://www.postgresql.org/docs/15/sql-prepare.html).

`MATERIALIZED` keeps the limited key subquery separate from outer optimization. It does not freeze the index chosen inside that subquery. [PostgreSQL CTE documentation](https://www.postgresql.org/docs/15/queries-with.html).

## Limits and remaining gates

Observed key scans were index-only with zero heap fetches. That benefit depends on visibility-map state: freshly written or updated pages may require heap visits. This run did not add churn, vacuum the fixture or prove a stable index-only path under sustained arrivals. [PostgreSQL index-only scan documentation](https://www.postgresql.org/docs/15/indexes-index-only-scans.html).

These are warmed, sequential local samples, not latency percentiles or production capacity guarantees. The fixture has fixed payloads and a limited tenant distribution. The harness exercises explicit owner SQL, not PostgREST, an installed RPC, Hugo authorization, RLS policies, prepared-session auto-transition or token/receipt handling. Plans may change with statistics, version, churn and real auth predicates. Production remains gated on the authenticated whole-snapshot RPC, prepared/pooled execution, empty and small conversations, larger interleaving/skew and active-write measurements. No generic-plan mode, planner hint, index removal or extension is proposed as a deployment fix.
