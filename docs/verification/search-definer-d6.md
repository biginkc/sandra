# D6 definer scoping verification

Depends on: #503 (`fix/search-relevance-d1-d4`). Migration:
`20260909084500_search_global_definer_scoping.sql`.

## Security contract

The function runs as postgres with SECURITY DEFINER and a fixed
`public, pg_temp` search path. Effective membership requires the calling uid,
active status, no deletion preparation, and an unexpired access window.
All three branches apply visibility outside their complete match expression.
Owner destinations independently require visibility and matching org IDs.
Thread contact titles and property IDs require same-org references; deleted
properties are not destinations. Missing uid returns no rows even for service
role. Anon cannot execute; authenticated and service_role can.

The migration rejects CREATE privilege on public for anon/authenticated and
asserts postgres ownership. Only search_global is replaced; D1/D4 token rules,
structured-query gate, ranking, caps, escaping, and minimum query length remain.

Removing the RLS evaluation barrier allows predicates to examine foreign rows
before filtering. Returned-row isolation is tested; timing noninterference is
not guaranteed. The expected Supabase advisor warning is
[0029: authenticated SECURITY DEFINER execution](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).
The before/after security advisor comparison found this as the only new finding.

## Reproducible checks

Both search suites install original → D1/D4 → D6 and restore that sequence.
Global setup holds the session advisory integration mutex. D6 applies twice.
Run the security mutation proofs with:

```sh
NODE_OPTIONS=--max-http-header-size=65536 SEARCH_D6_MUTATIONS=1 npm run test:integration -- \
  supabase/migrations/20260909000000_global_search.integration.test.ts
```

Each mutation reads pg_get_functiondef, asserts that its edit changes the final
installed definition, proves the intended assertion RED, restores the definition
in finally, and repeats the assertion GREEN. Covered boundaries: contact
structure, each of the three membership lifecycle conditions, property/message
branch authorization, combined contact/destination protection, both multi-org
owner destinations, thread title, and single-/multi-org thread property.
Positive reachability is checked before corrupting each crossed-reference fixture.

Contact auth is redundant at the output level because BOTH destinations have
visible-org guards. Without conversation visibility it could be detected through
that path alone. The structural and combined-mutation assertions are separate.

Null-uid coverage includes real service-role RPC and authenticated SQL execution
with no-sub request.jwt.claims. **A signed authenticated JWT without sub is not
covered:** the supplied environment has no signing key. Anon denial and a real
user JWT with zero memberships are independent cases. Robustness uses real user
RPC for null/empty/short/100-char/punctuation-only/broad queries and limit edges.

The existing six D1/D4 mutations remain available via SEARCH_MUTATION and now
edit the installed final definitions, including the shared prefix helper.

## Representative performance

```sh
NODE_OPTIONS=--max-http-header-size=65536 SEARCH_D6_PERFORMANCE=1 npm run test:integration -- \
  supabase/migrations/20260909000000_global_search.integration.test.ts -t 'D6 representative'
```

The fixture seeds 150,000 properties, 250,000 contacts, and 60,000 SMS across
3,000 conversations into three new synthetic tenants (98%/1%/1%). Generated
columns and indexes remain enabled. Only unrelated business triggers are bypassed
within the synthetic insert/cleanup transaction. Cleanup verifies zero remaining
synthetic rows and updates planner statistics.

For every query, owner EXPLAIN runs within one explicit transaction/connection,
sets claims, asserts auth.uid and nonempty visible_orgs, and applies the installed
function configuration. PostgREST uses a real user JWT, discards three warmups,
and records 20 samples. Exact function-definition checks before measured calls
reject concurrent changes despite the integration mutex.

The literal plan has an additional planner barrier: materialized bounds/input
CTEs hide the digit gate. A word query's phone bitmap index lookup visits all
contacts for `%%`, then rejects them. The property branch scans the dominant
tenant via the org index. SECURITY DEFINER alone does not establish the <500ms gate.

A read-only NOT MATERIALIZED experiment (not shipped) reduced owner EXPLAIN to
1.320ms (Sunflower), 16.380ms (Vanderplanken), 9.348ms (8165551234), and 4.698ms
(appoin). This does not prove real-RPC performance and requires a scope extension
from the literal approved plan.

## Production acceptance

After dependency and D6 deployment through the established migration workflow:

```sh
node scripts/verify-search-global-production.mjs
```

Supply SEARCH_PROD_DATABASE_URL, SEARCH_PROD_URL, SEARCH_PROD_ANON_KEY, and an
existing authorized SEARCH_PROD_JWT through the environment. The script performs
no production writes. It validates all five defect queries against the D1/D4
oracle under authenticated RLS, with only intentional same-org/deleted-reference
corrections, and gates 20-sample warm real-JWT p95 below 500ms.

Production acceptance has not run. #503 remains an external dependency; do not
merge this child into its parent branch or release it ahead of that dependency.
