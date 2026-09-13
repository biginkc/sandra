# Inbox production catalog preflight — prepared, not executed against production

Status: Supabase CLI access was reported Unauthorized. This task did not read credentials, call production, install extensions, change schema, or query customer rows. The SQL is ready for an operator who already has authorized access. No project identifier, access token or database password is invented or embedded.

## What the SQL collects

`production-preflight.sql` opens an explicit READ ONLY transaction, sets a5-second statement timeout,500ms lock timeout and15-second idle transaction timeout, emits one JSON object, then ROLLBACKs. It uses catalog/statistics views only, with file-size metadata functions; no exact row counts, transcript/history scan, EXPLAIN ANALYZE, pg_stat_statements query text, subscription connection string, or extension installation.

The allowlist covers canonical messages, properties, contacts, message_threads, AI review records, consent events, SMS suppression, global DNC, memberships and proposed Inbox read/operation tables. Public-schema objects absent from the catalog are reported separately; absence is not automatically a defect because new tables are not expected before their migration.

Collected sections:

- PostgreSQL version/read-only state, WAL/replication and connection/worker budgets.
- Aggregate connection states; no client address or query text.
- Replication slot activity and retained/unconfirmed WAL byte differences. These are byte positions, not elapsed lag or an SLA.
- Estimated table rows/pages and heap/index/total bytes; RLS flags and reader SELECT visibility.
- Index state/method plus full definition **only for an ordinary index without expressions or a predicate**. Complex index definitions, predicates and expressions are hashed to avoid exporting embedded constants.
- Trigger names/enabled state and source function identity/definition hashes; function source and trigger arguments are never persisted.
- Policy names/commands/roles and expression hashes; no policy expressions.
- Relevant role names/privileges/connection limits and memberships. No passwords, password hashes, role config or secret-bearing connection details.
- Publication flags and relevant table names; no row filter text.
- Database/table cumulative counters, reset/analyze/vacuum timestamps where exposed.

MD5 hashes are change-detection fingerprints, not cryptographic security attestations. Matching hashes do not establish correct trigger or authorization behavior. A separate restricted source review will be needed for effective function semantics, partial-index predicates, visibility policies and complete writer coverage. Review that content in an authorized environment rather than adding definitions to this export.

## Operator procedure

1. Use an existing authorized PostgreSQL connection with catalog visibility appropriate to the task. Prefer its saved service/approved connection profile; do not paste a database URL with credentials into commands, documentation or chat. Verify the intended environment outside this script. The script itself does not invent or select a Supabase project.
2. Review the SQL before running. With an already configured connection environment, run from `experiments/inbox-stack/evidence`:

   ```sh
   psql -X -qAt -v ON_ERROR_STOP=1 -f production-preflight.sql > preflight-private.json
   ```

   This command relies on the operator's existing connection configuration. Do not use it until that configuration is verified. Keep the raw output private initially; if a statement fails, stop and inspect the cause rather than weakening permissions or the timeout automatically. Read-only transaction settings expire with this transaction.
3. Inspect the JSON locally. Confirm `sample.read_only` is `on`, expected database/version and timestamp, all requested sections and any nulls. Catalogue access restrictions can hide rows or deny a section; neither means zero usage or no security controls.
4. Before sharing, review names and ordinary-index definitions for internal identifiers or accidental sensitive constants. Redact database/reader/role/slot/publication names if organizational handling requires it; retain stable aliases to compare samples. Do not append logs, connection errors containing URLs, environment variables or credentials. Export only the reviewed JSON.
5. For interval rates, collect a second sample in a **new invocation/new transaction** after a known interval (for example60seconds during representative usage). Compute nonnegative counter differences divided by timestamp difference only when database reset timestamp is unchanged and no known per-table reset occurred. A reset/decrease invalidates the comparison. These are observed interval-average database writes, not inbound-message counts or instantaneous peak records/second. Repeated updates, other writers and retries are included. One sample cannot establish a rate.

## Local validation actually performed

The exact SQL parsed and executed successfully against the owned `sandra-inbox-stack-db`, host58782, PostgreSQL17.6; output reported read_only=on and16 top-level sections. Its public dependencies were absent, as expected in the isolated fixture schema.

A second read-only run replaced only the schema string in memory with `inbox_t1`; this exercised2 fixture relations,2 indexes and3 triggers successfully. No source SQL was changed for that variant, and no fixture rows or schema were mutated. The fixture has no matching policies, so nonempty policy output has not been independently exercised here. Production version compatibility, privileges, timings, volume, slot capacity and current deployed definitions remain unverified.

## What this still cannot answer

- Tenant skew, live Inbox cardinality under business filters, conversation history distribution and second-level ingestion peaks.
- Actual query plans or measured first-open/revisit latency.
- Whether every production writer increments the right versions and dirty generations.
- Whether proposed logical replication permissions, quotas and network routes are available in the hosting plan.
- Whether RLS/role/policy semantics authorize the intended stream or commands.

These require separately authorized, bounded follow-up research. This catalog preflight is a starting artifact, not production readiness or deployment approval.
