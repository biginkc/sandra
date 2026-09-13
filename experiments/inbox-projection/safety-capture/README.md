# Consent, responder-state and suppression summary capture

Private implementation against the owned canonical fixture. No production migration, command-policy version coverage or provider behavior claim.

`setup.sql` adds three AFTER triggers without changing the reviewed message or parent capture source:

- Consent changes compare `id,org_id,contact_id,channel,event_type,occurred_at`. Both old and new SMS sides enqueue their contact parent when the event is one of the five types consumed by the summary. An opt-in, deletion, timestamp reordering, departure to another channel or type, and organization/contact move can all reveal a different latest policy state. Help events and source/detail/created timestamps do not change this summary.
- Thread changes compare organization, conversation and responder status, and dirty old/new known conversation keys directly. The summary joins by organization/conversation; capture does not invent a narrower channel predicate. Reason, delivery fields and timestamps are not consumed by this summary. Existing tuple-level uniqueness does not establish uniqueness of organization/conversation; collision assessment remains a separate requirement.
- Suppression insert/delete/key moves enqueue old/new organization and exact phone keys in `inbox_t2_safety.routes`. Metadata updates do not change suppression existence. The canonical constraint permits only SMS suppression rows, so the runtime tests do not fabricate an unsupported alternate suppression channel.

Route work uses persistent generation/acknowledgement, captured scan generation, message UUID cursor, claim token and lease. A batch reads at most 500 existing route edges through `(org_id,phone_e164,message_id)`; first and cursor query shapes are separate. It enqueues distinct conversation IDs only within that bounded batch, then fences and advances the route checkpoint atomically. A stale checkpoint rolls back child changes using a PostgreSQL subtransaction. Source edge reads occur before private write locks. A new suppression generation does not reset an in-progress scan and is not acknowledged by an older pass. Successful batches release their lease for the next invocation. Claim discovery is limited to 100 keys.

A message relationship entering or leaving a scanned route is handled by the existing direct message capture, which dirties its conversation and changes its edge in the source transaction. This is essential for an edge that moves behind a committed cursor. Route edges currently contain post-capture fixture writes; historical production edge backfill and concurrent cutover have not been implemented by this slice. The source's North American phone normalization is preserved rather than broadened silently.

## Runtime evidence

`run.py` passes six grouped cases: actual computed consent state after insertion/reordering/deletion; consumed versus excluded consent fields and old/new scopes; thread state/move/delete with excluded fields; bounded route batches, replay, rollback, newer-generation retention and a verified behind-cursor edge move; suppression tenant move/delete; and transactional rollback/private role restrictions. Every drain is capped at 20 iterations. Exact source and runner hashes are in `evidence.json`.

`concurrency.py` uses real independent PostgreSQL sessions. A holder locks the relevant child dirty row, a route worker blocks after reading edges, and the harness observes `pg_blocking_pids`. It expires the private lease, obtains a fresh claim through the real claim function and releases the child lock. The old worker returns stale, leaves the child generation and replacement cursor/token unchanged, and the replacement completes. Expiry is explicitly simulated; this is not a process-crash or wall-clock-expiry test. Its source and runner hashes are in `concurrency-evidence.json`.

Both runners require explicit owned-fixture opt-in, immutable container validation, marker validation and disabled cron. The primary runner defaults to refusing an installed schema. `--continue-installed` verifies all five installed function bodies and adds fresh identities without resetting prior data. The prior runner and receipt, before the explicit behind-cursor position assertion was added, are retained as `run-before-cursor-assertion.py` and `evidence-before-cursor-assertion.json` for evidence provenance, not normal execution.

```sh
python3 experiments/inbox-projection/safety-capture/run.py --run-owned-fixture
python3 experiments/inbox-projection/safety-capture/concurrency.py --run-owned-fixture
```

## Remaining rollout gates

This remains worker-private summary invalidation. Complete action-policy version namespaces, production authenticated synchronization, historical edges and projection backfill, privileged bypass/restore repair, representative indexed plans/write amplification, continuously scheduled work, deadlock/serialization retry across writers and provider acceptance/receipt recovery remain separate requirements. The current source triggers do not themselves provide that retry contract. No production data or real customer messaging was touched.
