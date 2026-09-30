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

The apply path locks the rollout singleton only for the short generation transition, refuses `serving_enabled=true`, catalog drift, collisions, or base-table duplicates, sets a 2-second lock timeout and a 15-second statement timeout, and does not take a table-level lock on source tables. It bumps `inbox_capture_boundary.generation`, invalidates read boundaries tied to the prior generation, then rebuilds sender identities, route edges, and capture targets in small committed batches (10 targets and 100 source rows per batch) through `inbox_maintained.snapshot`/`publish`. Each batch commits before the next begins, so a source write waits only for one bounded batch. Committed batches remain valid if the process is interrupted; rerunning recovery is safe and completes the remaining work. A final read-only recovery plan re-verifies the writer set, catalog, collision registry, independent base-table duplicate scan, projections, filters, and source-generation digest. A `RECOVERY_SOURCE_CHANGED` or reconciliation failure means the operator should rerun recovery. The procedure reconciles both bridge tables and writes neither serving nor completion markers. Its receipt records the old/new generation, invalidated-boundary count, batch counts, source-generation stability, and post-recovery reconciliation evidence. If a failure occurs after any recovery or marker transaction commits, the CLI reports `change landed` and exits with code 3 so the operator knows to verify/resume rather than treat it as a rollback.
