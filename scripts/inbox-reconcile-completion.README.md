# Inbox reconciliation completion tool

`inbox-reconcile-completion.mjs` is the R6a operator check for the two completion columns in `inbox_control.rollout`.

It opens a repeatable-read, read-only transaction by default. It checks the disabled serving gate, baseline stage, per-organization backfill rows, pending worker state, collision state, maintained-to-summary projection counts and digests, live catalog fingerprint, capture fingerprint stability, current source-writer triggers, and a source-writer attestation for the period since installation.

The tool does not run the projection worker, acknowledge collisions, repair rows, bump capture generation, enable serving, or invoke the offline fixture script. A source-writer attestation is required because PostgreSQL catalog state cannot reconstruct a historical `TRUNCATE`, replica-mode restore, logical import, or disabled-trigger interval. The attestation payload is digest-checked and must carry the current capture generation and expected catalog fingerprint.

Hosted connections require `INBOX_RECONCILIATION_DATABASE_URL` without TLS query parameters and a single pinned CA at `INBOX_RECONCILIATION_CA_FILE` or `NODE_EXTRA_CA_CERTS`. The local fixture target is available only to explicitly marked test code.

Required non-secret inputs:

- `INBOX_RECONCILIATION_EXPECTED_CATALOG_SHA256`: reviewed catalog fingerprint.
- `INBOX_RECONCILIATION_SOURCE_WRITER_ATTESTATION`: JSON attestation path.
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
