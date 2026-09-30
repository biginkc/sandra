# Inbox reconciliation completion tool

`inbox-reconcile-completion.mjs` is the R6a operator check for the two completion columns in `inbox_control.rollout`.

It opens a repeatable-read, read-only transaction by default. It enumerates conversations from the J5a base source tables, asks `inbox_maintained.snapshot` for the database-owned candidate, and checks missing, extra, and mismatched maintained rows. It then reconciles both database-owned bridge outputs: `inbox_bridge.summaries` and `inbox_bridge.filter_rows`. It also checks the disabled serving gate, baseline stage, per-organization backfill rows, pending worker state, collision state, the independent catalog fingerprint, capture fingerprint stability, current source-writer triggers, and a source-writer operator assertion for the period since installation.

The normal tool does not run the projection worker, acknowledge collisions, repair rows, bump capture generation, enable serving, or invoke the offline fixture script. The attestation field is intentionally named `operator_assertion_digest`: it is a digest of an operator-supplied assertion, not a cryptographic signature. The expected catalog fingerprint is loaded from the committed independent catalog artifact at `scripts/inbox-reconcile-catalog.expected.json`, unless an explicitly reviewed value is supplied.

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

The apply path refuses `serving_enabled=true`, locks the J5a source tables, bumps `inbox_capture_boundary.generation`, invalidates read boundaries tied to the prior generation, rebuilds capture targets and route edges from current base rows, republishes through `inbox_maintained.snapshot`/`publish`, reconciles both bridge tables, and writes neither serving nor completion markers. Its receipt records the old/new generation, invalidated-boundary count, rebuild counts, and post-recovery reconciliation evidence.
