# Shared TEST read-only fixture

`inbox-test-readonly-fixture.mjs` is the narrow PRE→POST fixture from
`ruling-test-readonly-pre-fixture.md`. It is the only write-capable tool in
this directory that is allowed to target shared TEST.

The database URL is read only from `TEST_SUPABASE_DB_URL`. The command line
does not accept a URL, and the script never loads `.env` files. Every mode
requires:

```sh
export TEST_SUPABASE_DB_URL='postgresql://...'
export INBOX_RO_FIXTURE_ACK=ncsngxlcyxylaeskiteu
unset MESSAGING_PROVIDER
```

The hosted URL must be the TEST session-pooler target: username
`postgres.ncsngxlcyxylaeskiteu`, a `.pooler.supabase.com` hostname, and port
5432 (or its default). The Production ref, all other hosted refs, CI, and
loopback/local targets are refused. Loopback is accepted only by the committed
local test with both `NODE_ENV=test` and `INBOX_RO_FIXTURE_TEST_MODE=1`, and the
test uses a disposable PG17 port in the 55000–59999 range.

Create starts a detached holder for the session advisory lock and records its
backend PID. The holder heartbeats for at most six hours. The receipt contains
only IDs, marker fields, timestamps, lock diagnostics, script binding, and
whole-database row hashes; it contains no URL, password, token, or row body.

```sh
node scripts/inbox-test-readonly-fixture.mjs \
  --create --run-id 20261002-j5a --owner j5a-orchestrator
node scripts/inbox-test-readonly-fixture.mjs \
  --status --run-id 20261002-j5a
node scripts/inbox-test-readonly-fixture.mjs \
  --remove --run-id 20261002-j5a
```

`--verify` and `--cleanup` are retained as aliases for status and remove.
Remove deletes only rows tied to the recorded marker org/user and then
re-enumerates every non-system base table, comparing per-row collision-safe
content hashes against the pre-create baseline. New/vanished tables, changed
non-owned rows, remaining owned rows, and counter decreases fail the proof.

Run the local mutation-first suite with:

```sh
npm run test:inbox-ro-fixture
```

It creates and destroys its own local PostgreSQL 17 cluster, replays the
repository's initial and mock-provider migrations, and never contacts a
hosted database.
