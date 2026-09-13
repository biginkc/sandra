# Inbox database contract rehearsal (T2)

This work continues the approved Inbox architecture after the isolated Electric /
TanStack / Restate integration. It is not a production migration or rollout.

The first slice establishes the post-render read boundary against the actual
canonical schema and its existing identity/safety triggers. The small T1 fixture
was insufficient to prove that interaction. PostgreSQL AFTER capture must observe
final canonical identity, allocate the destination revision transactionally, and
avoid treating read-only or body corrections as new inbound arrivals.

## Isolation

The dedicated `sandra-inbox-projection-t2-db` container has network mode `none`,
no published ports, and scheduling disabled before source replay. It uses the
pinned Supabase PostgreSQL17.6 image, with512MiB and oneCPU. It never mounts an old
database volume or copies customer rows. CLI access is through `docker exec` on
the explicit owned Colima socket. Source bootstrap and proof scripts must verify
container ownership, isolation and fixture identity before writes.

The existing local Supabase, T1 database/runtime, user prototype and production
remain unchanged. Production catalog access is still unavailable; local schema
replay does not establish deployed production equivalence.

## Checklist

- [x] Source-backed50-case parity inventory and writer/trigger assessment in T1.
- [x] Read-only assessment of the existing owned local catalog; no data copied.
- [x] New network-isolated container created from pinned image.
- [x] Reproducible vendor bootstrap: 237 application migrations and 13 pinned prerequisites.
- [x] Candidate atomic inbound revision baseline and AFTER capture, offline only.
- [x] Real-schema concurrency, rollback, identity move and no-recursion proofs: 20 checks pass.
- [x] Offline read-boundary SQL: six checks cover later arrivals, history batches and DNC rollback.
- [x] Sidecar alternative: corrected correctness checks and retained A/B measurements.
- [x] Minimal maintained projection integration: 11 strengthened checks pass.
- [x] Indexed history/read query comparison at 1k, 10k and 100k messages.
- [x] Test a limited key-page history query against newer unrelated arrivals: eight checks pass.
- [ ] Integrate the chosen history query with authenticated head snapshots and write churn.
- [ ] Review, failure correction and promotion into an additive migration.
- [ ] Entity-version/dirty capture, narrow summaries and bounded repair.
- [ ] Detail/search/count/read APIs and complete parity/expiry checks.

Production rollout additionally needs deployed catalogs, writer coverage,
workload/hold-time/WAL measurements, auth and hosting decisions, migration gates
and the remaining implementation described in the approved specification. Never
reset retained revision heads to make a failed proof pass.

## Current decision

T1 integration lab PR #551 merged as `e7e2eae47f9b53bbedfe48ad3caff7a2deaecb7f`
after all repository CI checks passed. This branch now starts from that validated
main commit. No application route uses the lab.

The T2 candidate remains a reference implementation, not a production migration.
The rehearsal demonstrated a real multi-statement row/head deadlock; retrying the
whole aborted transaction works in the proof, but actual writer coverage still
needs assessment. The self-update also increased WAL and server execution time
in a small synthetic comparison. See [head proof](head-proof/README.md) for exact
measurements and limits. A separate per-message arrival table is being compared
as an alternative; it is not an approved architecture replacement and does not
remove the deadlock by itself.

The post-render read endpoint, maintained product summaries and complete source-writer
integration are still unimplemented. The [SQL read proof](read-proof/README.md)
validates the fixed boundary against canonical triggers, but does not implement
browser acknowledgment, user authorization, signed tokens or recovery receipts.
Its query plans also expose scans beyond the returned batch size; query/index
work is continuing before any production capacity claim.

The [index comparison](index-proof/README.md) found an effective fixed-boundary
unread index, but adding a scoped history index did not guarantee its use. With
10,000 newer unrelated arrivals, the history plan rejected 10,617 rows before
returning the target page. This is retained as an unresolved performance finding,
not hidden by the passing correctness assertions. A subsequent
[query comparison](index-proof/history-query-alternatives/README.md) found a
materialized key page followed by primary-key content reads avoided that scan
under both tested prepared-plan modes. It is the next implementation candidate;
production/authenticated RPC and concurrent-write behavior remain unproved.

## Checks that do not access a database

The Inbox isolated CI workflow verifies retained vendor/license hashes, Python
syntax, JSON evidence readability, SQL transaction-envelope handling and fixture
isolation guards (also under optimized Python). Run the same checks locally:

```sh
python3 experiments/inbox-projection/verify_sources.py
python3 experiments/inbox-projection/fixture/transaction_envelope.py
python3 -O experiments/inbox-projection/fixture/guards_test.py
```

These checks do not execute the recorded database/concurrency proofs. Those
require the explicitly owned fixture and coordinated exclusive access described
in each proof directory. Never run every `run.py` automatically: installation
and replay preconditions differ.
