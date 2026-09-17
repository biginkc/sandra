# Inbox RPC work_mem remeasurement — 2026-09-17 (Astra round-4 gate on #604)

## Why this exists
Astra's round-3/round-4 gate on PR #604 flagged that `SET work_mem TO '32MB'`
(added in the round-3 E5 fix) was picked by an ascending ladder on a small
dev-scale fixture and never re-measured at a representative row count, and
that the 2026-09-14 investigation doc itself already documents 32MB as
"UNSAFE on the 2GB tier as-is" under concurrency — shipping it anyway without
a remeasurement or an explicit tradeoff call was the defect. This doc is that
remeasurement.

## Method
Owned PG17 fixture (`sandra-inbox-projection-t2-db`, docker/colima profile
`inbox-redesign-20260913`), not the small dev fixture the original ladder
used. Synthetic data generated inside a transaction and rolled back after
measurement (never committed): 20,000 contacts, 15,000 properties, 65,000
distinct conversations, 91,000 messages (~1.4 msgs/conversation, close to
prod's 1.22), all within the function's `p_cutoff` window — sized to match
the ~64,643-row in-window scale the function actually operates over
post-E5 (E5 already prefilters contacts/properties down to that window, so
the base tables' full 308k/184k prod row counts no longer drive this
function's memory profile the way they did pre-E5).

The real migration function body was installed under a test name with the
`SET work_mem` clause stripped, so `work_mem` could be varied per call via
session-level `SET` without redefining the function each time.
`EXPLAIN (ANALYZE, BUFFERS, SUMMARY)` against `select public.<fn>(...)`,
single-shot, filter=unread (matching the 2026-09-14 doc's own methodology)
plus a spot-check on filter=all/hide_noise=false.

## Ladder (representative fixture, single-shot)
| work_mem | temp spill | exec ms | verdict |
|---|---:|---:|---|
| 8MB | written=8945 (8kB blocks, ~70MB) | 1,328 | spills |
| 12MB | written=8945 | 1,246 | spills |
| 16MB | written=3254 (~26MB) | 1,290 | spills |
| 17MB | written=2242 (~18MB) | 1,288 | spills |
| **18MB** | **0** | **1,089** | **spill eliminated (Batches: 1)** |
| 19MB | 0 | 1,038 | clean |
| 20MB | 0 | 1,030-1,044 | clean, confirmed on both unread and all/hide_noise=false |
| 24MB | 0 | 1,046 | clean |
| 28MB | 0 | 1,015 | clean |
| 32MB (round-3 value) | 0 | 1,050 | clean, no faster than 18-20MB |

**Minimum spill-eliminating value on this fixture: 18MB.** Execution time is
flat from 18MB through 32MB — the original 32MB choice bought zero latency
benefit over 18-20MB, only extra memory headroom. Shipped: **20MB** (measured
minimum + small margin, not the unmeasured 32MB).

## Honest per-call memory footprint — MEASURED (2026-09-17, round-4 followup)
Astra correctly rejected the first version of this doc's "50-63MB" figure:
it was a proportional scaling of the 2026-09-14 doc's 32MB number, and
`work_mem` bounds PER-OPERATION memory, not total query memory — scaling
it linearly assumes every materialized CTE actually needs the full cap,
which is not established. `pg_log_backend_memory_contexts` and
`auto_explain`'s internal-plan capture are both blocked in this managed
container (see prior attempts below), so the fix was a kernel-level
measurement that needs neither.

**Method:** a FRESH `psql` connection per test (never one that already ran
the earlier bulk data-generation `INSERT`s — an early attempt reused the
data-loading connection and showed zero measurable growth, because that
backend's allocator arena was already primed to ~240-320MB from the
inserts and simply reused freed blocks for the query; that run's numbers
are not used here). `select pg_backend_pid()`, then read
`/proc/<pid>/status` `VmHWM` (the kernel's own monotonic peak-RSS-ever
tracker for that process — needs no Postgres-side permission) immediately
after connecting (baseline) and again after each RPC call, on the same
~65k-in-window synthetic dataset used for the ladder above. The real
migration function body (with its actual `SET work_mem TO '20MB'`) was
installed and run, not a stripped test copy.

| run | baseline VmHWM | post-call VmHWM | delta | calls |
|---|---:|---:|---:|---|
| 1 | 247,052 kB | 257,640 kB | **+10,588 kB (≈10.3MB)** | filter=unread, then filter=all/hide_noise=false (2nd call added 0 further) |
| 2 | 166,260 kB | 167,720 kB | **+1,460 kB (≈1.4MB)** | filter=all + p_search='Synth', then filter=needs_outcome |

**Measured peak per-call delta: ≈10.3MB** (worst of two runs covering
unread/all/search/needs_outcome filter branches). This is far below the
32MB `work_mem` cap itself, let alone the earlier 50-63MB estimate —
consistent with Astra's point that most of this function's ~13 materialized
CTEs, at this row-count scale, never approach the work_mem ceiling
individually; the query has few, small work_mem-bound operations, not many
full-cap ones.

Test data and the temporary test-named function were fully cleaned up
(`DELETE`/`DROP FUNCTION`, committed) after measurement — row counts on
the fixture verified back to their pre-test baseline (1,275 contacts,
1,282 properties, 131,295 messages).

## Tier/concurrency budget (same formula as the 2026-09-14 doc)
Safe budget A ≈ 0.25 × (RAM − shared_buffers), divided by assumed concurrent
live PostgREST calls (≈15, per the 2026-09-14 doc's own measurement, which
is a pool-size/app-config number rather than something that scales with DB
tier).

- **2GB tier** (measured in the 2026-09-14 doc): shared_buffers 512MB → A ≈
  384MB → ≈25.6MB/call safe ceiling.
- **4GB tier** (the currently-intended standing tier per the Sandra
  Messages incident/tier-bump note, 2026-09-14): shared_buffers estimated
  ≈1024MB (Supabase's ~25%-of-RAM convention, not independently confirmed
  for this exact tier) → A ≈ 768MB → ≈51.2MB/call safe ceiling.
- **8GB tier** (confirmed live on `sandra-crm` right now via Supabase MCP:
  shared_buffers 2048MB, max_connections 160, work_mem default 12MB) → A ≈
  1536MB → ≈102.4MB/call safe ceiling.

**Headroom at the measured ≈10.3MB/call, 15 concurrent calls:** 15 ×
10.3MB ≈ 154.5MB vs the 4GB-tier's 768MB budget → **≈613.5MB headroom,
~5x margin** (supports ≈74 concurrent calls before the budget is exhausted,
at this measured rate). Even padding generously for run-to-run variance or
call shapes not covered by the two measured runs (say 2.5x the worst
observed delta, ≈25MB/call), 15 concurrent calls ≈ 375MB still fits the
768MB budget with ≈2x margin. The 2GB-tier ceiling (25.6MB/call) is the
only one a padded 25MB/call estimate would get close to — the 4GB and 8GB
tiers both hold real margin.

**Conclusion: RESOLVED, not an open tradeoff.** 20MB `work_mem` is
memory-safe under concurrency on the 4GB target tier (and the current live
8GB tier) based on measured peak-RSS delta, not estimate. Safe to merge on
the memory dimension.

Related: docs/performance/2026-09-14-inbox-query-latency-investigation.md
(original investigation, E1-E6). PR #604.
