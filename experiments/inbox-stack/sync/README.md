# Local Electric / TanStack runtime slice

Synthetic-only integration. No production schema, authentication, providers or data are used.

## Proven evidence

- `evidence-explicit_ids.json`: 11 passing checks, 100-ID immutable server-selected shape, actual TanStack DB eager collection snapshot, subsequent direct PostgreSQL update, lifecycle cleanup/rebuild, cross-user/tenant and handle/parameter rejection, updates outside membership excluded, expiry and revoked access denial, and access epoch rechecked after receiving upstream body before forwarding any row bytes.
- `evidence-membership_subquery.json`: same 11 checks at 500 rows through an additional server-owned membership table/subquery.
- `initial-414-evidence.json`: direct 500-ID shape FAILED HTTP414. The upstream request was 31,102 bytes. POST subset APIs do not solve a long base shape URL. Preserve this failure as architecture evidence.
- Package typecheck passes. These are local correctness checks, not throughput, population latency or production authorization proof.

## Architecture decision for this slice

The standalone gateway defaults to `explicit_ids`, capped at100 rows. This keeps the original fixed-ID shape design for the UI integration. Five100 shards, HTTP2/3 and stream handover are NOT yet tested. The subquery variant remains an isolated research alternative, not an approved production architecture change. It requires one inserted membership record per selected ID, an extra table in the Electric publication, cleanup/expiry handling and measurement of shape cardinality/write churn.

Client contract on loopback58784:

- `Authorization: Bearer synthetic-a` or `synthetic-b`. Tokens map server-side to fixture-only membership rows. They are public test constants, not production credentials.
- `POST /worksets` with `{ "limit": 100 }` returns id, fixed ordered ids, access epoch, expiry, and shapeUrl. No caller SQL, table, tenant or columns allowed. At most two unexpired generations per user.
- `GET /shape/:id?offset=-1` starts; follow Electric offset/handle/cursor/live/log protocol. Handles belong to that generation/user. `log=full` only. `0_inf` is a valid SDK continuation offset and is accepted.
- `DELETE /worksets/:id` disposes that generation. Fixed TTL is60seconds in this research server. Expired worksets deny requests; old membership records are removed on next workset creation or clean gateway close. No autonomous database TTL janitor is implemented.
- Four concurrent upstream requests per user, five-second upstream lease, maximum2MB buffered response. Browser client should recreate/revalidate after410. Production retry/auth handling is not supplied by this test gateway.

No server-sent events and no subset POST support in this slice. Eager mode is intentionally used over a strictly bounded shape. TanStack on-demand compiled in the earlier package smoke but was not runtime-tested here.

## Start / reproduce

Run from `experiments/inbox-stack`, after root's shared fixture setup and package install:

1. Run `./sync/start-electric.sh` (verified exact existing-instance reuse; labeled pinned creation when absent). It starts owned Electric on Docker network `sandra-inbox-stack-t1`, container `sandra-inbox-stack-electric`, host127.0.0.1:58783 →3000.
2. Manual publication `electric_publication_inbox_t1` includes only `inbox_t1.conversation_summaries` and (alternative tests only) `inbox_t1.sync_workset_members`. Apply `sync/setup.sql` to the guarded disposable database for the alternative.
3. `./node_modules/.bin/tsx sync/serve.ts` starts standalone gateway58784.
4. `SYNC_STRATEGY=explicit_ids ./node_modules/.bin/tsx sync/verify.ts` runs direct100 variant with an ephemeral gateway58790.
5. `./node_modules/.bin/tsx sync/verify.ts` runs alternative500 variant. It does not modify the standalone gateway's strategy.

Tests alter only synthetic preview text and the fixture user's membership access_epoch/active status. Run serially with bulk fixture tests; they restore active=true but deliberately leave epoch monotonic. Existing worksets become stale as expected. Tests close their collections, gateway and pool; Node/HTTP client cleanup can take roughly a minute before the process exits. Do not run both copies simultaneously on58790.

## Container provenance

Official image: `electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139` (Docker Hub manifest digest verified after pull).

Runtime cap:512MiB,1CPU; `ELECTRIC_DB_POOL_SIZE=2`, `ELECTRIC_MANUAL_TABLE_PUBLISHING=true`, `ELECTRIC_REPLICATION_STREAM_ID=inbox_t1`, `ELECTRIC_MAX_SHAPES=16`. Database URL is the owned Docker fixture, with dummy postgres password and sslmode=disable. Passwordless trust URL caused an Electric startup crash in password-obfuscation code; the dummy password fixed startup without changing fixture auth.

`ELECTRIC_INSECURE=true` is local-only: Electric binds to loopback and contains synthetic data; the gateway is the tested application authorization boundary. Production must use private authenticated upstream transport. `ELECTRIC_TELEMETRY=false` was provided, but current official config does not document this switch; do not claim it disables all telemetry. No OTLP/Honeycomb/StatsD/Sentry export destination or credentials were configured, and no paid telemetry service was enabled.

Official references: [configuration](https://electric.ax/docs/sync/api/config), [shape predicates](https://electric.ax/docs/sync/guides/shapes), [gateway authentication](https://electric.ax/docs/sync/guides/auth).

## Unproven / missing before production

Actual Hugo sessions, row-level visibility beyond tenant, authenticated CDN behavior, full500 direct/sharded delivery, gateway HTTP2/3, on-demand subsets, server409 restart/retention recovery, automatic resync after410, browser cache disposal on logout/revocation, long-run membership cleanup, replica/WAL capacity, huge transcript/history paging, production Node version and realistic multi-operator load are not certified here. Lifecycle rebuild test is not a server409 test. Returned operation txids and durable bulk results are integrated separately by root.

Client recovery source findings: [client-recovery-guidance.md](client-recovery-guidance.md). Startup script leaves the existing gateway58784 untouched.
