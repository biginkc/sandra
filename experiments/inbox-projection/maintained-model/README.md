# Unified maintained rows and expiry primitive

Five grouped runtime checks passed against the owned canonical fixture. This
connects the direct capture's persistent typed dirty generations to the actual
known/unknown computations and one publication table. Earlier proof tables and
triggers remain installed but are not the acknowledgment source for this model.
No production migration, public endpoint, continuous worker or live UI was added.

The STABLE snapshot captures dirty generation, expected projection revision and
full summary under one caller snapshot. Unknown rows resolve their retained
sender-group UUID before computing the exact raw-address group; successful
output no longer says identity_mapping_required. Missing registry scope yields
no candidate rather than inventing a new identity during a read.

Publication validates kind/identity and locks dirty then projection. It never
reads canonical sources in that locked section. The stored source_generation
serves as the acknowledged generation: a newer dirty generation remains pending.
Revision conflicts and regressed generations reject stale results. Full JSON,
source generation, revision and next expiry commit together. A source-specific
command authorization/version tuple is not replaced by this projection revision.

Expiry discovery can use the partial deadline index. Its wake primitive takes
an expected projection revision, acquires the same lock order, and rechecks the
current deadline. Exact equality remains eligible; only a later clock wakes it.
It increments dirty generation and clears that schedule atomically. A repeated
wake is harmless; rollback preserves both deadline and generation. A subsequent
compute publishes the time-dependent tombstone. A stale wake cannot erase a
newer projection's schedule. Unknown summaries have no time-window expiry.

The recorded tests compare complete published outputs, advance source data
between capture and publication, reject stale candidates, apply unknown dismissal
and deletion while retaining identity, and exercise expiry equality/rollback/
repeat/stale-revision behavior. Private table access requires SQLSTATE42501.
They do not inject process death or concurrent scheduler workers; transaction
rollback/retry evidence must not be described as crash testing.

Run only on a fresh installation of this private integration in the already
owned fixture, with exclusive database access:

```sh
python3 experiments/inbox-projection/maintained-model/run.py --run-owned-fixture
```

The harness refuses existing installation, optimized Python, unexpected container
identity/network/resources, enabled cron, or wrong fixture marker. Preserve the
current receipt; do not reset the database to repeat a test. SQL and subprocess
waits are bounded. Setup and runner hashes are retained in evidence.json.

Outstanding: continuous worker/scheduler deployment, full property/contact/review/consent/suppression fanout, backfill/cutover,
source writer retries, public role/RLS/read authorization, bounded sync worksets,
and meaningful-volume load tests. The rows table holds narrow per-target JSON as
an integration contract; publication-specific columns/indexes for filters/search/
counts still need implementation. Trusted worker candidates are not public input.
The capture registry's exact-raw identity and legacy unknown compute's text
comparison must be checked against deployed collation before production use.

## Durable work discovery and worker invocation

The subsequent queue.sql adds one private queue key per changed typed target.
A trigger on the direct dirty table enqueues in the source transaction. The queue
has an availability index; claim_work locks at most100 requested rows with SKIP
LOCKED and returns fresh per-claim UUIDs. Claim transactions end before computing
canonical data, avoiding a queue-lock-to-source-lock cycle. Expired work becomes
eligible again without deleting the target or its dirty generation.

Completion locks dirty then queue, checks the current unexpired token, then runs
publication while holding no canonical source locks. It removes a queue entry
only when the published generation equals the current dirty generation. Otherwise
it releases the claim with a short retry delay. Errors or lost responses leave
persisted work discoverable; no browser response is used as acknowledgment.

Three grouped queue checks passed: claim bounds/token mismatch, lease expiry and
reclaim fencing, and rollback/newer-generation retention. Expiry was simulated by
updating only owned private lease metadata. This is not a process-kill or real
wall-clock expiry test. queue-evidence.json retains source/harness hashes.

worker-once.py now performs a real bounded claim → canonical snapshot → fenced
publication cycle against this fixture. It leaves errors claimed for later lease
recovery and reports a nonzero exit for failed/missing snapshots. The retained
worker result shows actual publication; no network provider or production service
was invoked. It is a CLI invocation, not an installed daemon or scheduler:

```sh
python3 experiments/inbox-projection/maintained-model/worker-once.py --run-owned-fixture --batch 10
```

The worker claims one target immediately before each computation, up to the
requested invocation cap. It does not consume later targets’ leases while earlier
computations run. Expired completions still fail closed. Its result distinguishes
applied, retry and rejected totals, and invalid/error results exit nonzero. Lease
length and bounded parallelism still require measurement before deployment. Queue bootstrap in
this fixture was a single INSERT from current private dirty rows. Production
backfill and concurrent cutover remain separate gates. expiry-once.py now discovers at most100 indexed due targets and invokes
wake_expiry in separate transactions. It never acquires projection locks before
the dirty lock; concurrent runs recheck the captured revision. Its generation
update enqueues through the same trigger. A continuous deployment is still needed. Parent dependency fanout remains unimplemented.

## Actual expiry worker integration

expiry-proof.py creates an owned canonical message close to its real 90-day
deadline, publishes it, and waits at most eight seconds for the database clock
to cross that deadline. Two separate scheduler processes then run concurrently.
The receipt proves one generation increment and one durable queue key, followed
by an actual worker process publishing the canonical tombstone and removing
caught-up work. Another scheduler pass leaves that target unchanged. This is
real clock and overlapping-process evidence, not a process-kill or load test.
The retained receipt hashes the exact SQL, workers and proof sources.

```sh
python3 experiments/inbox-projection/maintained-model/expiry-proof.py --run-owned-fixture
```
