# Historical backfill and cutover readiness rehearsal

This implements a durable, bounded historical scan against the owned canonical fixture. It is not a production migration or authorization to switch the Inbox. It leaves the existing capture implementations and earlier proof schemas intact.

## Historical scan

`start(org)` creates a persistent organization job only when all eight expected capture triggers are enabled. It records a fingerprint of those trigger definitions, enabled modes and top-level trigger function bodies. A job walks three UUID-keyset streams: messages, reviews and threads. `claim()` leases at most 100 jobs; `batch()` consumes at most 500 source rows and commits its stream/cursor/revision with its private writes. Fresh worker invocations resume the stored cursor. Stale tokens cannot reuse or replace a newer checkpoint.

For messages, the batch:

1. Locks the entire bounded canonical source page in UUID order before acquiring private registry, dirty or edge locks. It uses `FOR UPDATE` without `SKIP LOCKED`: a blocked historical row must wait or retry, never silently fall behind the cursor. First-page and cursor queries are separate shapes, with fixture index candidates on organization/source UUID.
2. Uses the current locked source tuples. It allocates or reuses the exact raw unknown identity through the existing `sender_id` helper, queues known and unknown targets, and reconstructs current normalized route edges. It does not serialize message bodies or infer eligibility from an old copy.
3. Locks and validates the job token, lease, revision, stream and cursor only after seeding. A stale fence rolls back every seed write and source lock acquired in the subtransaction. A successful transaction records exactly the consumed page.

This source-row locking is deliberate: live source changes cannot commit a new edge while a stale backfill copy replaces it. Canonical locks are acquired before private writes, and there are no further canonical locking reads in that batch. The caller must supply bounded statement/lock timeouts and retry the whole transaction on deadlock/serialization failure. The supplied harness uses 20-second statement and 2-second lock timeouts. Batch size and lock overhead are operational parameters still requiring realistic measurement.

Review rows seed their conversation targets, including review-only conversations. Thread rows seed known targets and enqueue collision inspection. New or moved source relationships behind a committed cursor remain covered by the installed direct message/review/thread capture; the scan is not a long-running consistent snapshot.

## Thread identity collisions

The canonical thread constraint is unique on channel/contact/property, not organization/conversation. The fixture demonstrates two otherwise valid thread rows sharing the same organization/conversation. A new private thread trigger queues old/new identity keys for collision inspection, including changes after the historical cursor has completed.

`inspect_collisions(org, limit)` reads at most two current thread IDs per queued identity through an organization/conversation/UUID index. It records a bounded duplicate pair and acknowledges only the captured generation. A newer generation remains pending; an older inspector cannot overwrite a newer acknowledgement. It never merges, deletes or otherwise repairs canonical threads. Resolution requires an explicit decision in the separate identity workflow, then a fresh inspection.

`readiness(org)` reports historical scan completion, whether the recorded capture fingerprint still matches, pending collision inspection and observed duplicate pairs. It always returns `production_cutover_authorized: false`. A completed scan with a duplicate is not ready to switch. Even a clean report still requires projection drain/parity, authenticated synchronization, performance acceptance and rollout authorization.

The fingerprint checks named top-level trigger definitions/functions at observation points. It does not prove that a privileged operator never disabled capture between those observations, nor fingerprint every helper, table, index or policy dependency. Privileged bypass/restore repair and full release artifact verification remain mandatory.

## Evidence

- `run.py`: five grouped runtime checks cover bounded progress/replay, atomic rollback, a verified behind-cursor arrival, persisted-cursor lease replacement, retained unknown registry allocation from absent private state, route seeding, review-only targets, duplicate reports and private privileges. Drains are capped at 30 batches.
- `concurrency.py`: four tests use independent PostgreSQL sessions and observed `pg_blocking_pids`, not timing alone. A concurrent source UPDATE changes phone and conversation before the backfill resumes; the final edge is current. A concurrent DELETE produces no resurrected edge. A tenant/conversation/phone move causes the waiting source query to recheck its organization predicate: the departing page contains zero rows, the old edge stays absent, and both direct invalidations plus the destination edge remain intact. A worker blocked on a private child after acquiring source locks is late-fenced by a replacement claim; its child increment and checkpoint effects roll back, and the replacement progresses.
- `collision-concurrency.py`: a real inspector blocks after reading a single thread. The lock holder inserts a second thread and advances the capture generation before releasing the inspector. The old result acknowledges only its captured generation; a new inspection then reports the exact duplicate pair.
- All receipts include exact setup and runner SHA256 values. The concurrency runner verifies every installed function body before writes. All validate the explicit fixture flag, immutable owned container, fixture marker and disabled cron.

The historical fixture honestly models missing pre-capture private data by deleting only newly created test-organization registry/dirty/edge/queue entries; canonical rows and all capture triggers stay active. Those throwaway identities have no saved actions or external references. This demonstrates reconstruction mechanics, not a real production capture-install boundary or policy-version backfill. Earlier fixtures and evidence were not reset.

The initial installation failed on an ambiguous PostgreSQL internal `char` concatenation in the fingerprint. Its transaction rolled back; `initial-install-failure.txt` preserves the failure. Casting `tgenabled` to text fixed installation. Successful receipts correspond to the corrected setup, without silently replacing previously installed objects.

```sh
python3 experiments/inbox-projection/backfill/run.py --run-owned-fixture
python3 experiments/inbox-projection/backfill/concurrency.py --run-owned-fixture
python3 experiments/inbox-projection/backfill/collision-concurrency.py --run-owned-fixture
```

The first runner refuses an existing schema. The second adds fresh synthetic identities after installed-source verification. No runner simulates actual process termination: rollback and lease replacement are the covered recovery cases. The late-claim assertions specifically verify the known dirty counter and replacement checkpoint, not absent unknown-registry allocation or changed-edge rollback. The original concurrency runner/receipt are retained as `concurrency-before-org-move.py` and `concurrency-evidence-before-org-move.json`; their earlier broad assertion wording is superseded by the narrower current receipt.

## Remaining production requirements

Complete command-policy/version seeding, actual capture-install/backfill boundary validation, privileged bypass repair, representative index plans and lock costs, bounded retry integration across writers, continuous job scheduling, projection drain, parity/access checks, and release/pilot recovery are unfinished. Four canonical indexes here are fixture candidates, not approved production index builds. Provider send/receipt ambiguity remains the separate durable attempt problem; replaying a database transaction must not duplicate external sends. No production data or customer messaging was touched.
