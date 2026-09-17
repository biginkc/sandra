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

## Per-shape, fresh-backend measurements (2026-09-17, second follow-up)
Astra's next critique was correct: the two runs above reused each backend
for a second query shape, so a second shape's peak could hide under the
first's already-elevated `VmHWM`. Redone properly: **one fresh backend
connection per shape**, no reuse, for all four shapes (all / unread /
search / needs_outcome). Each: connect, read `/proc/<pid>/status`
immediately (entry: `VmRSS`, `VmHWM`, `RssAnon`, `RssFile`, `RssShmem`),
run exactly ONE RPC call, read `/proc/<pid>/status` again (post).

| shape | entry VmHWM | entry RssAnon (private) | entry RssShmem (shared) | post VmHWM | peak-above-entry |
|---|---:|---:|---:|---:|---:|
| all | 286,708 kB | 20,000 kB | 69,820 kB | 286,708 kB | **0** |
| unread | 279,416 kB | 19,932 kB | 68,900 kB | 279,416 kB | **0** |
| search | 281,984 kB | 13,840 kB | 68,944 kB | 281,984 kB | **0** |
| needs_outcome | 267,932 kB | 6,592 kB | 69,012 kB | 267,932 kB | **0** |

`peak-above-entry = post_VmHWM − max(entry_VmRSS, entry_VmHWM)`, per the
gate's own formula. **Zero for all four shapes independently** — each
call's own memory need fit entirely inside what the backend had already
touched before the call even ran (RssShmem ≈68-70MB is `shared_buffers`
pages, shared across every backend, not a per-call cost; RssAnon
6.6-20MB is the entry-time PRIVATE figure, and it does not grow further).
Private (`RssAnon`) is the OOM-relevant number; `RssShmem` is double-safe
to ignore for concurrency math since the same physical pages are shared.

This is a genuinely stronger result than the earlier reused-backend runs'
"≈10.3MB delta" — with clean isolation, no shape shows measurable growth
at all at this row-count scale. Both results are kept in this doc; the
per-shape numbers above supersede the reused-backend ones for the
per-call footprint question.

## Real concurrency test — an actual OOM crash (2026-09-17, third follow-up)
Astra asked for actual N-parallel execution, not a multiplied single-call
number. This surfaced something the isolated tests above completely
missed:

**Method:** 15 simultaneous fresh `psql` connections, no staggering, each
running ONE call of the `all` shape, self-sampling their own
`/proc/<pid>/status` from within the same driver script (to avoid a
timing race against my own tool round-trips, which cost an earlier
attempt its measurement window entirely).

**Result: the Postgres instance was OOM-killed by the Linux kernel
(signal 9) four separate times** during this testing, each one taking the
whole `sandra-inbox-projection-t2-db` container down and back through
crash recovery:
```
LOG: server process (PID 706491) was terminated by signal 9: Killed
DETAIL: Failed process was running: select public.sms_inbox_thread_page_snapshot_new_proof(...)
LOG: terminating any other active server processes
LOG: all server processes terminated; reinitializing
```
(repeated at 19:57:19, 19:58:14, 19:58:35, 19:59:38 UTC). Recovery was
automatic and clean each time (WAL replay, `database system is ready to
accept connections` within ~1s); post-incident data integrity was
verified (contacts/properties/messages counts exactly match the
pre-test baseline; no test artifacts left behind).

**Two confounds that keep this from being a clean answer either way:**

1. **This container has a hard 512MiB memory limit** (`docker stats`:
   `MEM USAGE / LIMIT: ... / 512MiB`) — a dev-fixture cgroup cap smaller
   than even the 2GB real Supabase tier's usable budget, let alone the
   4GB target tier this decision is actually about. Hitting a 512MB wall
   does not mean a real, unconstrained 4GB-RAM managed Postgres instance
   would OOM the same way.
2. **The test used 15 FRESH/cold connections, not pooled ones.** Each
   backend independently builds its own private catalog/relation-cache
   copies on first use — cost that is paid ONCE per backend and then
   reused for every later query on a warm, pooled connection.
   Production traffic goes through PostgREST/Supavisor pooling (the
   2026-09-14 doc's own "~15 live" figure is a POOL size — warm, reused
   connections), which never repeats this cold-start cost 15 times
   simultaneously the way this test did. **The isolated per-shape tests
   above (zero growth per call) strongly suggest the crash is dominated
   by this cold-connection/catalog-cache overhead, not by the RPC's own
   `work_mem`-bound work** — but that is an inference from the isolated
   results, not a direct measurement, and I did not attempt to
   cleanly separate the two causes by, for example, re-running the
   concurrency test against already-warmed connections, because doing so
   meant risking a fifth crash on a fixture other work in this session
   may depend on.

**I am not willing to keep crash-testing a shared fixture to chase a
cleaner number.** Four OOM-triggered restarts against a resource other
agents in this session may be using is already a real cost, even though
recovery was automatic and no data was lost.

## Conclusion: NOT a clean "safe with margin" — a decision for Jarrad
The evidence is genuinely mixed and I am not going to force it into a
tidy verdict:

- Every isolated, single-call measurement (7 across two rounds, covering
  all four filter shapes) shows **zero to ~10MB per-call growth** — no
  signal that 20MB `work_mem` itself is the problem.
- A real 15-concurrent-connection test **crashed the instance via OOM**,
  four times, reproducibly — but on a 512MiB-capped container with cold
  (unpooled) connections, which is a materially harsher and smaller
  environment than the actual 4GB production tier with pooled
  connections this decision is about.
- I have not proven this migration is safe under realistic production
  concurrency (pooled, on an actual 4GB-tier Supabase project), and I
  have also not proven it is unsafe there — I've proven the query CAN
  exhaust a small, unpooled test environment, which is a real signal to
  take seriously, not a data point to explain away.

**Options for Jarrad, not decided here:**
1. Treat the isolated per-call evidence (zero growth) plus the
   cold-connection/pooling confound as sufficient reassurance and ship
   20MB as-is, since production never presents 15 simultaneous cold
   connections the way this test did.
2. Require a proper concurrency test against an actual 4GB-tier Supabase
   project through the real PostgREST/Supavisor pool before merging —
   the only way to remove both confounds at once.
3. Defer this optimization entirely (#604 is a non-critical perf change;
   it is fine to wait) until (2) can be done without risk to a shared
   fixture.

This migration is **not being represented as merge-ready on the capacity
dimension** — the correctness fixes (auth-scoped equivalence, org
isolation, suite lifecycle, `search_path=""`) stand on their own measured
proof, but capacity is handed to Jarrad as a tier/verification decision,
not resolved here.

Related: docs/performance/2026-09-14-inbox-query-latency-investigation.md
(original investigation, E1-E6). PR #604.
