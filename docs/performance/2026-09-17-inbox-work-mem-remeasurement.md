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

## What this does NOT resolve — the honest memory-footprint question
`pg_log_backend_memory_contexts` (the exact per-call byte measurement the
2026-09-14 doc used to derive its "~80-100MB honest per-call footprint" at
32MB) is permission-denied for the `postgres` role on this managed Supabase
container, and `auto_explain` cannot capture the function's internal
per-CTE plan here either — the function's `SET search_path`/`SET
statement_timeout`/`SET work_mem` clauses make it non-inlinable, so it
executes as an opaque call and only the outer `Result` node is visible to
`EXPLAIN`/`auto_explain`, not the internal Hash/Sort/Materialize node
memory breakdown. This is an environment limitation, not a "verified safe"
finding — do not read the ladder above as proof of the real per-call byte
footprint at 20MB.

**Estimate only** (proportional scaling from the 2026-09-14 doc's own
measured 80-100MB @ 32MB, since total footprint at spill-elimination is
dominated by concurrently-live `AS MATERIALIZED` CTE tuplestores that scale
with the work_mem cap, not just the hash join): 20MB/32MB × 80-100MB ≈
**50-63MB estimated per call**.

## Tier/concurrency budget (same formula as the 2026-09-14 doc)
Safe budget A ≈ 0.25 × (RAM − shared_buffers), divided by assumed concurrent
live PostgREST calls (≈15, per the 2026-09-14 doc's own measurement, which
is a pool-size/app-config number rather than something that scales with DB
tier).

- **2GB tier** (measured in the 2026-09-14 doc): shared_buffers 512MB → A ≈
  384MB → ≈25.6MB/call safe ceiling. 20MB fits; 32MB did not.
- **4GB tier** (the currently-intended standing tier per the Sandra
  Messages incident/tier-bump note, 2026-09-14): shared_buffers estimated
  ≈1024MB (Supabase's ~25%-of-RAM convention, not independently confirmed
  for this exact tier) → A ≈ 768MB → ≈51.2MB/call safe ceiling.
- **8GB tier** (confirmed live on `sandra-crm` right now via Supabase MCP:
  shared_buffers 2048MB, max_connections 160, work_mem default 12MB) → A ≈
  1536MB → ≈102.4MB/call safe ceiling. 20MB (and even the old 32MB) fit
  comfortably here.

**The estimated 50-63MB per-call footprint at 20MB sits right at the edge
of the 4GB-tier ceiling (~51MB/call), not comfortably under it.** This is a
genuine tradeoff, not something this migration can silently resolve:

1. If the app stays on the current 8GB tier (or is confirmed to stay above
   ~6GB), 20MB is safe with real margin.
2. If it downgrades to the planned 4GB tier, 20MB is borderline — safe only
   if real concurrent inbox-RPC load stays at or below the ~15-call
   assumption, and that assumption itself is not re-verified against
   current traffic in this doc.
3. A comfortably-safe-at-any-tier fallback exists: 12MB (no override
   needed beyond the current 8GB-tier default's ballpark) still spills
   ~70MB to temp but still runs ~1,246ms single-shot on this fixture —
   19% faster than the original 1,538ms pre-narrowing baseline — trading
   the last ~200ms of latency win for a comfortable memory margin at any
   tier.

**Recommendation:** ship 20MB (this migration) as a strict improvement over
the unmeasured 32MB regardless of tier, but treat the tier choice (stay on
8GB vs downgrade to 4GB) and the ~15-concurrent-call assumption as an open
capacity decision for Jarrad, not something resolved by this remeasurement.

Related: docs/performance/2026-09-14-inbox-query-latency-investigation.md
(original investigation, E1-E6). PR #604.
