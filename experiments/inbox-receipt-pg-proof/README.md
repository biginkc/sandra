# Actual PostgreSQL receipt retry check

Run `npm ci` then `npm test` in this directory. The harness only connects to the
owned synthetic T1 database at loopback port 58782, checks its identity on both
connections, and creates a random private test schema. It never changes a
publication or calls a messaging provider. Timeouts bound database work.

The real application `retryReceiptTransaction` helper runs an update inside a
REPEATABLE READ transaction. A second connection commits a conflicting update
after the first snapshot. PostgreSQL produces a genuine 40001 serialization
failure. The failed transaction rolls back; the helper opens a fresh transaction
and persists the receipt without repeating simulated provider acceptance.

The receipt records two attempts, one simulated acceptance, the actual abort code,
the committed row, source hashes and verified schema cleanup. Evidence is only
written after successful cleanup. A module-format import failure occurred before
any database access on the first run; using the application's CommonJS boundary
through createRequire resolved it without changing the application helper.

This validates the helper with a real database rollback. It does not validate
PostgREST error transport, the complete sendSmsToContact/releaseQueuedMessage
wrappers, a real provider, deadlocks, ambiguous commit, process death or durable
recovery after remote acceptance. Those require separate evidence.
