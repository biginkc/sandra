# Inbox reconciliation completion tool

`inbox-reconcile-completion.mjs` is the R6a operator check for the two completion columns in `inbox_control.rollout`.

It opens a repeatable-read, read-only transaction by default. It enumerates conversations from the J5a base source tables, asks `inbox_maintained.snapshot` for the database-owned candidate, and checks missing, extra, and mismatched maintained rows. It then reconciles both database-owned bridge outputs: `inbox_bridge.summaries` and `inbox_bridge.filter_rows`. It also checks the disabled serving gate, baseline stage, per-organization backfill rows, pending worker state, collision state, the independent catalog fingerprint, capture fingerprint stability, current source-writer triggers, and a source-writer operator assertion for the period since installation.

The normal tool does not run the projection worker, acknowledge collisions, repair rows, bump capture generation, enable serving, or invoke the offline fixture script. Completion is blocked by both the collision registry and an independent grouped scan of `public.message_threads`, so a bypass-created duplicate cannot be hidden by a missing registry row. The attestation field is intentionally named `operator_assertion_digest`: it is a digest of an operator-supplied assertion, not a cryptographic signature. The expected catalog fingerprint is loaded from the committed independent catalog artifact at `scripts/inbox-reconcile-catalog.expected.json`, unless an explicitly reviewed value is supplied.

The committed fingerprint is the SHA-256 digest of stable JSON containing the canonical PostgreSQL definitions queried by `catalogFingerprint()` in `inbox-reconcile-completion.mjs`: functions in `CATALOG_SCHEMAS`, relations and columns in those schemas, and non-internal triggers on those schemas and the listed source relations. Generate it only from a disposable Postgres 17 stack after applying the repository's migrations. With `INBOX_RECONCILIATION_TEST_DATABASE_URL` exported by that local stack, run `INBOX_RECONCILIATION_MIGRATION_COMMIT="$(git rev-parse origin/claude/inbox-migrations-v2)" npm run generate:inbox-reconcile-catalog`; the generator is local-database-only and writes the complete artifact shape. Review the live catalog diff, then commit `scripts/inbox-reconcile-catalog.expected.json` with the migration file hashes. Regenerate after any migration or database-side change that can alter a listed function, relation, column, RLS flag, default, or trigger; do not regenerate for application-only changes. A drift fails with an explicit regeneration message.

Hosted connections require `INBOX_RECONCILIATION_DATABASE_URL` without TLS query parameters and a single pinned CA at `INBOX_RECONCILIATION_CA_FILE` or `NODE_EXTRA_CA_CERTS`. The local fixture target is available only to explicitly marked test code.

Required non-secret inputs:

- `INBOX_RECONCILIATION_EXPECTED_CATALOG_SHA256`: reviewed catalog fingerprint.
- `INBOX_RECONCILIATION_SOURCE_WRITER_ATTESTATION`: JSON assertion path. Its digest field is `operator_assertion_digest`.
- `INBOX_RECONCILIATION_TARGET`: `test` or `production` for hosted use.

Dry-run:

```sh
INBOX_RECONCILIATION_DATABASE_URL='postgresql://…' \
INBOX_RECONCILIATION_EXPECTED_CATALOG_SHA256='…' \
INBOX_RECONCILIATION_SOURCE_WRITER_ATTESTATION='/secure/path/coverage.json' \
INBOX_RECONCILIATION_TARGET=production \
node scripts/inbox-reconcile-completion.mjs
```

Completion-marker write is a separate explicit operation:

```sh
node scripts/inbox-reconcile-completion.mjs --write-markers
```

The write path uses `SERIALIZABLE`, locks the singleton row, re-runs the complete evidence check, and updates only `backfill_complete` and `reconciliation_complete` while `serving_enabled=false`. An already-complete pair is a zero-row idempotent result.

Capture-bypass recovery is a separate operation. It is read-only by default and emits a recovery plan:

```sh
node scripts/inbox-reconcile-completion.mjs --recover-capture-bypass
```

Applying recovery requires the separate explicit mutation flag as well:

```sh
node scripts/inbox-reconcile-completion.mjs --recover-capture-bypass --apply-capture-recovery
```

The apply path requires only `serving_enabled=false`; reconciliation failure is the input it repairs. It refuses catalog drift, collisions, or base-table duplicates, and uses short transactions with a 50 ms lock timeout. A repeatable-read diff identifies only stale or missing maintained keys. Recovery writes only those dirty markers, starting at 20 keys and adapting; it never calls `snapshot()` or `publish()` while a marker lock is held, never deletes queue rows, and never bumps already-consistent keys. The projection worker claims the resulting queue rows and owns compute/publish.

Sender groups and route edges are repaired idempotently. Route-edge repair briefly locks the source message and uses an atomic upsert, closing the DELETE-then-INSERT race described in `research-reconcile-recovery-locking.md`. The final recovery gate is one repeatable-read snapshot: non-pending base/projection mismatches must be zero, captured pending work must still have a queue row, the independent base-table duplicate scan must be clean, and the collision registry must be clean. It does not compare dirty-table digests across time, so committed customer writes after the snapshot do not make a valid recovery fail.

There is no persisted cursor. An interrupted run recomputes the diff and is idempotent. The global capture generation changes only when read boundaries exist; the generation transition and boundary invalidation are one short transaction, so a rerun does not bump it again after the boundaries are gone. The procedure reconciles both bridge tables and writes neither serving nor completion markers. Its receipt records only digests, counts, batch metrics, and post-recovery evidence. If a failure occurs after any recovery transaction commits, the CLI reports `change landed` and exits with code 3 so the operator knows to verify/resume rather than treat it as a rollback.
