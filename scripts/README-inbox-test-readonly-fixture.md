# Shared TEST read-only fixture

`inbox-test-readonly-fixture.mjs` is the narrow PRE→POST fixture from
`ruling-test-readonly-pre-fixture.md`. It is the only write-capable tool in
this directory that is allowed to target shared TEST.

The database URL, Supabase API URL, and service-role key are read only from
`TEST_SUPABASE_DB_URL`, `TEST_SUPABASE_URL`, and
`TEST_SUPABASE_SERVICE_ROLE_KEY`. The command line does not accept a URL, and
the script never loads `.env` files. Every mode requires:

```sh
export TEST_SUPABASE_DB_URL='postgresql://...'
export TEST_SUPABASE_URL='https://ncsngxlcyxylaeskiteu.supabase.co/'
export TEST_SUPABASE_SERVICE_ROLE_KEY='...'
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
process and backend PIDs. The holder uses a fail-fast `pg_try_advisory_lock`
and heartbeats for at most six hours. The receipt contains only IDs, marker
fields, timestamps, lock diagnostics, script binding, and whole-database row
hashes; it contains no URL, password, service-role key, token, or row body.

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
content hashes against the pre-create baseline. Creation and cleanup deltas
are recorded separately. New/vanished tables, changed non-owned rows,
remaining owned rows, and counter decreases fail the proof. Known monotonic
owner-guard counters are checked for non-decreasing progress. Changes to
Supabase-managed append-only tables are reported by table name rather than
silently omitted.

Run the local mutation-first suite with:

```sh
npm run test:inbox-ro-fixture
```

It creates and destroys its own disposable Supabase stack with PostgreSQL 17,
copies and replays every repository migration, and never contacts a hosted
database. The real local GoTrue API backs the T1 data-path client; a separate
test-only loopback auth stub backs fixture user creation/deletion so the test
can assert that `auth.admin.createUser({ id, email, email_confirm: false })`
sends no password. Default receipts are outside the repository at
`$HOME/.sandra-inbox-fixture/` with mode 0700 (the suite uses a disposable
0700 temp directory).
