# Shared TEST read-only fixture

`inbox-test-readonly-fixture.mjs` is the permanent, inert PRE→POST fixture from
Ruling v2 (`TRP2-1..9`). It is the only write-capable tool in this directory
allowed to target shared TEST.

The tool is additive-only. Its database writes are fixed-id
`INSERT ... ON CONFLICT DO NOTHING` statements into `organizations`,
`memberships`, and `messages`, plus one Supabase admin `createUser`. Every SQL
statement passes through `q()`. The only accepted first keywords are
`select`, `insert`, `begin`, `commit`, `rollback`, and `set`; an insert conflict
action that would change an existing row is refused. The admin surface exposes
only `createUser` and `getUserById`.

`--remove` and `--cleanup` are retired. They exit nonzero with `MODE_REMOVED`
before target validation or any database access. The fixture is never repaired:
fixed rows that are missing may be inserted, while any existing drift exits
with `FIXTURE_DRIFT` and no further write.

## Target contract

The database URL, Supabase API URL, and service-role key are read only from
`TEST_SUPABASE_DB_URL`, `TEST_SUPABASE_URL`, and
`TEST_SUPABASE_SERVICE_ROLE_KEY`. The command line accepts no URL and the tool
does not load `.env` files.

```sh
export TEST_SUPABASE_DB_URL='postgresql://postgres.ncsngxlcyxylaeskiteu:...@aws-1-us-east-1.pooler.supabase.com:5432/postgres'
export TEST_SUPABASE_URL='https://ncsngxlcyxylaeskiteu.supabase.co/'
export TEST_SUPABASE_SERVICE_ROLE_KEY='...'
export INBOX_RO_FIXTURE_ACK=ncsngxlcyxylaeskiteu
unset MESSAGING_PROVIDER
```

The raw authority is parsed with `pg-connection-string`. Encoded authority
characters, socket paths, query/options, wrong users, wrong ports, non-TEST
poolers, and non-TEST API URLs are refused. The PostgreSQL client receives only
the validated `host`, `port`, `user`, `password`, `database`, and `options`
fields; it never receives a `connectionString`. Loopback is accepted only by
the disposable local suite with `NODE_ENV=test` and
`INBOX_RO_FIXTURE_TEST_MODE=1`.

## Fixed permanent fixture

The org name is `Inbox RO fixture (permanent, inert)`. The auth user is created
without a supplied password; GoTrue owns the resulting opaque bcrypt hash. The
fixture checks only that `banned_until` is after 2100, both
`email_confirmed_at` and `last_sign_in_at` are NULL, the nested
`app_metadata.inbox_ro_fixture` stamp is exact, `providers` is exactly
`["email"]`, and there is at most one `email` identity. Other GoTrue metadata
keys are ignored. The reserved-TLD email is `inbox-ro-fixture@fixtures.invalid`.
If local GoTrue rejects that syntax, the suite and fixture use
`inbox-ro-fixture@fixtures.test` instead.

The org contains exactly two fixed queued `mock` SMS rows. Both have null
contact, property, campaign, conversation, from, to, and external-id fields.
m1 is scheduled for `2099-12-31T00:00:00Z`; m2 has no schedule. Their metadata
is the fixed permanent-purpose stamp, not a run or lease marker. The UUIDv5
namespace and all five IDs are recorded in
`scripts/permanent-test-fixtures.md`.

The receipt is informational: run id, owner, purpose, lease window, script
binding, lock PIDs, diagnostics, and fixed-ID copies. No code path uses receipt
IDs or markers as a target. The advisory lock holder spans the PRE→POST window,
with a six-hour cap; expiry or abort releases the holder and never removes
data. If an existing receipt points to a dead holder, use a new run-id instead
of reusing that receipt.

```sh
node scripts/inbox-test-readonly-fixture.mjs \
  --create --run-id 20261002-j5a --owner j5a-orchestrator
node scripts/inbox-test-readonly-fixture.mjs \
  --verify --run-id 20261002-j5a
node scripts/inbox-test-readonly-fixture.mjs \
  --hold-lock --run-id 20261002-j5a \
  --lease-expires-at 2026-10-02T18:00:00.000Z --ready-file /tmp/fixture-ready.json
```

The fixture is permanent TEST infrastructure. Whole-DB observations treat this
org and rows derived from it as expected. Production and disposable lanes are
untouched; the tool sends nothing and never targets a hosted database from the
local suite.

## Verification

Run the disposable PostgreSQL 17 + Supabase stack and all AT1–AT9 checks with:

```sh
npm run test:inbox-ro-fixture
```

The suite also runs the T1 Vitest check. AT9 runs `--create`, `--verify`, and a
second `--create` through real local GoTrue, and compares the stub's auth row
shape with a real GoTrue row. T1 proves m1 is not selected by the
sequence-tick clock at now+10y, no send-path status-only query selects m1, the
real release guard leaves both rows unchanged, and the mock provider is not
called until the deliberate local mutation of m2. The suite probes local
GoTrue and reports whether `.invalid` or `.test` was accepted.
