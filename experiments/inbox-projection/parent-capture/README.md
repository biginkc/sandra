# Parent dependency capture and bounded fanout

Private, owned canonical fixture implementation. This is not a production migration or complete writer coverage.

The property/contact AFTER triggers compare actual finalized OLD/NEW fields consumed by the current summary. They only increment persistent parent generations for distinct old/new organization and entity keys. They do not enumerate child conversations or serialize whole canonical rows. Unrelated timestamps do not enqueue work. Parent counters survive deletion. Review insert/update/delete directly dirties old/new conversation keys, including departing property/conversation relationships and pending-state exits; property fanout also visits review links regardless of review status.

Each parent has a durable active scan generation, stream, source-record UUID cursor, acknowledgement, claim token and lease. A property walks message links followed by review links. A contact walks message links. Each batch examines at most the configured number of source records (1–500), deduplicates only that bounded batch and enqueues known conversation keys in sorted order. Non-SMS messages still advance the source cursor but do not enqueue children. Three fixture-only canonical indexes support `(org, parent id, source id)` enumeration. First-page and cursor SQL have different query shapes, avoiding a generic nullable-cursor OR filter. Index cost and actual deep production plans remain unmeasured.

New generations do not restart an active scan. Finishing acknowledges only its captured generation; a newer pending generation starts a fresh scan. Membership changes behind a cursor depend on existing direct message capture and the new direct review capture. These are separate transactions, not a long-lived snapshot. Removed and added relationships independently dirty their old/new conversation keys.

A batch reads its canonical links before private write locks. It then enqueues child keys and finally locks/fences the parent checkpoint. If another worker replaced its lease or checkpoint while it waited, a PostgreSQL subtransaction rolls back those child enqueues before returning `stale_claim`. Successful enqueue and checkpoint changes commit together. Child-before-parent order accommodates the existing nested property-outcome trigger that can dirty reviews before the property's AFTER capture. This is not a proof of freedom from deadlocks in every legacy writer. The claim transaction touches only private parent rows and ends before batch execution. Each successful batch releases its lease for another bounded invocation.

## Verified in the isolated database

- `run.py`: eight grouped checks cover bounded batches, review-only children, hot parent generations, stale replay, rollback/retry, simulated lease expiry/reclaim, behind-cursor insertion/rescan, review move/delete, contact fanout, old/new organizations and private privileges.
- `concurrency.py`: actual independent PostgreSQL sessions hold a child row, block an old worker after its source read, replace its expired claim, then release it. The old worker rolls back its child increment and cannot change the new worker's cursor/token. The replacement successfully advances. Lease expiry itself is simulated by a private fixture update; this is not a wall-clock timeout or process-crash claim.
- Receipts contain exact setup and runner hashes. The initial runner refuses an existing schema; the concurrency runner verifies installed function bodies before writes. Both check explicit opt-in, immutable container identity, fixture marker and disabled cron. No production database commands were run.

Commands, only with exclusive owned fixture access:

```sh
python3 experiments/inbox-projection/parent-capture/run.py --run-owned-fixture
python3 experiments/inbox-projection/parent-capture/concurrency.py --run-owned-fixture
```

The first command defaults to refusing an installed schema. Explicit `--continue-installed` verifies all installed function bodies before adding fresh synthetic identities; it never replaces schema or earlier data. Drains are limited to 20 batches. The original pre-bounds runner and receipt are retained as `run-before-bounded.py` and `evidence-before-bounded.json`; do not use that historical runner. The second adds fresh synthetic identities and preserves prior evidence/data.

## Remaining release requirements

Consent and route-suppression parent capture, direct thread capture, complete action-policy version namespaces, a continuously scheduled bounded worker, production concurrent-write backfill/cutover, privileged trigger-bypass repair, parent deletion/reinsert parity under every canonical FK path, and representative throughput/index/lock measurements remain unfinished. These private summary generations are not prepared-action policy versions.

Source transactions must support bounded whole-transaction retry for `40P01`/`40001` before capture is enabled across writer paths. Current application paths have not established that general retry contract. Provider sends cannot be naively replayed with a failed database receipt: provider acceptance/receipt ambiguity requires the separate durable attempt recovery protocol. Source-trigger write amplification and added canonical index build/storage cost must be measured and accepted before production rollout. None of this fixture work enables Electric publication or customer messaging.
