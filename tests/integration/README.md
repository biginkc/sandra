# Integration tests

`npm run test:integration` runs against the hosted `sandra-crm-test`
Supabase project (`ncsngxlcyxylaeskiteu`) — real Postgres, so coverage
includes RLS, Realtime publications, and SECURITY DEFINER functions.
Each test file's `beforeEach` truncates the tenant tables via the
`reset_tenant_tables()` RPC.

## Required env (`.env.test.local` in the repo root, gitignored)

```
TEST_SUPABASE_URL=https://ncsngxlcyxylaeskiteu.supabase.co
TEST_SUPABASE_ANON_KEY=<anon key>
TEST_SUPABASE_SERVICE_ROLE_KEY=<service role key>
TEST_SUPABASE_DB_URL=postgresql://postgres.ncsngxlcyxylaeskiteu:<db password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres
```

Keys live in 1Password (`BMH Secrets`): the API keys in the Supabase
console login item, the DB password in **"Supabase - Sandra Test DB
Password"** (URL-encode it if it contains special characters).

## Suite lock (`TEST_SUPABASE_DB_URL`)

The suite truncates shared tables, so two concurrent runs — other
worktrees, other agents, other machines — corrupt each other (deadlocked
truncates, FK seed failures). `tests/integration/suite-lock.ts` takes a
session-level Postgres advisory lock (`hashtext('sandra-integration-suite')`)
on a dedicated connection for the whole run; a second run blocks with a
"waiting" message until the first finishes. Postgres drops the lock
automatically if a run crashes.

The Playwright e2e suite resets the same tables, so it takes the **same
lock** (`e2e/global-setup.ts` → `acquireSuiteLock`): integration and e2e
runs serialize against each other, not just against themselves. Locally
e2e also requires `TEST_SUPABASE_DB_URL`; in CI (where the secret may not
be configured) e2e warns and continues, relying on the workflow's GitHub
concurrency group.

The URL must be the **session** pooler (port 5432) or a direct
connection. The transaction pooler (port 6543) swaps backends per
statement, so the lock wouldn't actually be held — global setup refuses
it. The direct host (`db.ncsngxlcyxylaeskiteu.supabase.co`) is
IPv6-only; prefer the pooler URI above.
