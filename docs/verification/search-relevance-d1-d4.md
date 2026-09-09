# Search relevance D1/D4 verification — 2026-09-09

Migration: `20260909080600_search_relevance_fixes.sql`.
The test project's pooler ledger reported maximum version `20260909080000`
before creation and again before preparing the PR. No ledger rows were written
by the integration rehearsal. Both search suites apply original definitions
followed by the fix twice under the integration global setup's advisory mutex.

## Behavior

- Global owner/property similarity is disabled for queries containing `@`, or
  at least three digits constituting at least 70% of the trimmed, bounded query.
  Substring and phone-digit predicates remain unchanged.
- The shared prefix helper requires a token of length >=3 among the first six
  nonempty normalized tokens. All selected tokens remain AND prefix constraints.
- Bare `45.5` no longer matches message bodies; `45.50 total` does.
  `100%%` intentionally remains `100:*`. Raw short-query behavior is unchanged.
- Only function replacements are shipped. Signatures, volatility, invoker
  execution, search paths, and existing ACLs are preserved; no types regeneration.

## Mutation proofs

Each mutation was applied to the FINAL function definitions, after original +
fix installation. Each run exited 1 on assertion failures; teardown restored
original + fix. Run with `SEARCH_MUTATION=<name> npm run test:integration --
supabase/migrations/20260909000000_global_search.integration.test.ts`.

| Mutation | Failing assertions |
| --- | --- |
| `structured-gate` | 3: similar owner email, property email, exactly 70% numeric property |
| `email-equality` | 4, including the partial-email owner regression |
| `no-similarity` | 3: misspelled surname, 60% numeric property, numeric street-address typo |
| `weak-prefix` | 7: helper and global body-only rejection |
| `drop-short` | 3: retained short token and first-six boundary |
| `boundary` | 1: exactly 70% must skip similarity |

The messages-search integration file also ran with `SEARCH_MUTATION=weak-prefix`:
both `a\b` and `45.5` RPC rejection assertions failed (2 failures).

Fixtures explicitly prove trigram similarity is true and substring matching is
false before asserting RPC results. The email owner has a live destination.
Both RPC suites include positive numeric body-only matches with contact fields
unable to satisfy the query.

## Verification

`npm run verify` passed with a dedicated PostgreSQL 17 instance on local port
55439 supplied through `LOCAL_REHEARSAL_DATABASE_URL`: e-sign atomic packet and
local database rehearsal, typecheck, 330 unit files / 3,667 tests, 110 component
files / 1,178 tests. The pre-commit hook repeats this required verification.
Focused ESLint and `git diff --check` passed.

All five required integration files passed together: **86 passed, 1 skipped**
(the existing opt-in global performance measurement), in 101.27 seconds:

```sh
NODE_OPTIONS=--max-http-header-size=65536 PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run test:integration -- \
  supabase/migrations/20260909000000_global_search.integration.test.ts \
  supabase/migrations/20260909080000_messages_search.integration.test.ts \
  supabase/migrations/20260909020000_dnc_guard_ignore_generated_columns.integration.test.ts \
  src/lib/messages/list-threads.integration.test.ts \
  'src/app/(dashboard)/messages/actions.search.integration.test.ts'
```

The shared test database has 529 preserved memberships. Node 22's default HTTP
header allowance fails the reset helper's large membership-filter response with
`UND_ERR_HEADERS_OVERFLOW`; a read-only fetch reproduced the cause. The explicit
64 KiB allowance resolves it without changing repository code. An initial Node
26 run passed all 19 list-thread tests but was interrupted before completion;
only the complete green run above is counted as final evidence.

## Review and rollout

Adversarial review compared the replacement functions with the originals:
only the two planned predicates change. The helper checks the already limited
six-token set. The structured condition groups the digit minimum and ratio;
both property and owner branches use it. Ranking, RLS/invoker behavior,
destinations, limits, and phone matching are unchanged.

An added metadata test initially assumed anon lacked execute permission. The
actual test database already grants it; the test now compares original and
final ACLs instead of changing permissions outside this brief.

Fable review and the plan's merge approval remain separate rollout prerequisites.
Production migration and regeneration of the two external oracle keys/browser
passes have not been performed. D2's conversation-id backfill remains out of scope.
