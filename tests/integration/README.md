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
truncates, FK seed failures). `tests/integration/global-setup.ts` takes a
session-level Postgres advisory lock (`hashtext('sandra-integration-suite')`)
on a dedicated connection for the whole run; a second run blocks with a
"waiting" message until the first finishes. Postgres drops the lock
automatically if a run crashes.

The URL must be the **session** pooler (port 5432) or a direct
connection. The transaction pooler (port 6543) swaps backends per
statement, so the lock wouldn't actually be held — global setup refuses
it. The direct host (`db.ncsngxlcyxylaeskiteu.supabase.co`) is
IPv6-only; prefer the pooler URI above.

## Run against your own stack (local-integration and Norma configs)

`vitest.local-integration.config.ts`, `vitest.slack-local.config.ts`,
`vitest.norma-queue*.config.ts`, `vitest.norma-stress.config.ts` (and
`vitest.norma-queue-stress*`), `vitest.norma-inbound.config.ts` and
`vitest.norma-recordings.config.ts` run destructive suites (seed, mutate,
delete). They have **no defaults**. A guard
(`src/lib/testing/isolated-db-env.ts`) runs as vitest `globalSetup`, before any
test file loads or connects, and refuses to start unless:

- `LOCAL_SUPABASE_URL`, `LOCAL_SUPABASE_SERVICE_ROLE_KEY`, `TEST_SUPABASE_URL`,
  `TEST_SUPABASE_SERVICE_ROLE_KEY` and `TEST_SUPABASE_DB_URL` are all set
  (Norma configs need only `TEST_SUPABASE_DB_URL`; Norma stress needs
  `NORMA_STRESS_SOURCE_DB_URL` or `TEST_SUPABASE_DB_URL`; slack-local needs
  `SLACK_LOCAL_API_URL`, `SLACK_LOCAL_SERVICE_KEY`, `SLACK_LOCAL_DB_URL`);
- `TEST_SUPABASE_URL` equals `LOCAL_SUPABASE_URL`, and the two service-role keys match;
- every URL is loopback, has no query string, and is not a hosted Supabase host;
- no URL uses the shared dev-stack ports **54321, 54322, 54329, 54331**.

Start a private throwaway stack on unused ports with
`e2e/stress/provision-stack.mjs` (local-safe: refuses the shared ports, the
repo root, and any workdir it did not create). It prints `API_URL`, `DB_URL`,
`ANON_KEY` and `SERVICE_ROLE_KEY` as JSON and writes `<workdir>/stress-env.json`:

```bash
node e2e/stress/provision-stack.mjs --workdir "$(mktemp -d)/sandra-stack" --api-port 54961 --db-port 54962
```

(`scripts/ci/provision-disposable-stack.mjs` is CI-only: it refuses to run
outside a GitHub runner.) Then:

```bash
export LOCAL_SUPABASE_URL=http://127.0.0.1:54961
export LOCAL_SUPABASE_ANON_KEY=<ANON_KEY from the JSON>
export LOCAL_SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from the JSON>
export TEST_SUPABASE_URL=$LOCAL_SUPABASE_URL
export TEST_SUPABASE_SERVICE_ROLE_KEY=$LOCAL_SUPABASE_SERVICE_ROLE_KEY
export TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54962/postgres
npx vitest run --config vitest.local-integration.config.ts <suite>
# when done:
node e2e/stress/provision-stack.mjs --workdir <same workdir> --stop
```

CI exception: the E2E workflow's per-job throwaway stack
(`scripts/provision-e2e-local-database.mjs`) uses the CLI defaults 54321/54322.
Those two ports are allowed only when `CI` is `1`/`true`, `GITHUB_ACTIONS=true`
and `E2E_DISPOSABLE_DATABASE=1` (published by that script). 54329/54331 are
never allowed.
