# Inbox stack integration gate (T1)

This is a runnable, isolated integration gate for the approved Inbox architecture:
PostgreSQL authority → Electric → TanStack DB, and accepted command → Restate →
database receipt → synchronized summary. It is not a production Inbox or evidence
that the existing production schema, Hugo authentication, workload, or providers
have passed integration.

The approved specification is SHA256
`9074b4c2ee4302ebed6fa8342a2cc010a2d6b59a8b1992ff82574bbfc3209d07`,
reviewed by Fable on September 13, 2026. Source package lives at
`artifacts/design/inbox-workspace/` in the parent Sandra workspace. Its
implementation conditions remain gates. Outbox is untouched.

## Ownership and boundaries

- `shared/` and package/dependency management: root integration owner.
- `sync/`: Electric service, bounded fixture gateway and collection verification.
- `bulk/`: Restate service, durable operation/receipt and replay verification.
- `ui/`: exact selection state machine and invariant tests.
- `browser/`: real React selection, Virtual list and click/drop integration.
- `evidence/`: safe results and image/package digests; no real customer data.

No app imports this directory. Nothing here is exposed by Next.js routes or
deployed as an active customer feature. HTTP fixture identities are explicit test
subjects, not a replacement for production session authentication. Never adapt
these endpoints into production by merely changing their host names.

## Disposable database

The fixture uses PostgreSQL 17.6 in an owned Docker container, with logical
replication enabled and host port bound only to `127.0.0.1:58782`. Local trust auth
is intentional for synthetic data on this isolated network; it is not a production
configuration. Every adapter validates the fixture database name and marker.

`shared/setup.sql` initializes a fresh database named `sandra_inbox_t1`, two
synthetic memberships, 501 conversation summaries and canonical properties. Two
conversations share one property to exercise deduplication. A small database
trigger projects canonical property changes into summaries. This does not stand
in for the complete production writer/expiry/identity projection design.

The old Supabase fixture and user prototype remain separate. Docker operations
use the explicit `inbox-redesign-20260913` Colima socket, never a changed default
context. Ports are reserved as follows:

| Port | Service |
|---|---|
| 58782 | Fixture PostgreSQL |
| 58783 | Electric, loopback only |
| 58784 | Synthetic-auth synchronization gateway |
| 58785 / 58786 | Restate ingress / admin, loopback only |
| 58788 | Restate worker callback endpoint |
| 58789 | Fixture command/status API |
| 58790 | Browser lab (also used by sync verification; run separately) |

## Verification checklist

- [x] Fresh worktree from main; no dependency on unmerged Messages branches.
- [x] Exact package pins installed without lifecycle scripts.
- [x] Disposable schema initialized and canonical-to-summary trigger installed.
- [x] Real Electric bounded snapshot/delta, tenant/handle/epoch tests.
- [x] Real Restate replay and per-step command receipt tests.
- [x] One accepted command reaches the subscribed collection through both services.
- [x] Exact single/Shift-click/Shift-drag selection invariants.
- [x] Runtime/image/package versions and limitations recorded.
- [x] Independent integration review; findings fixed and browser regressions passed.
- [x] Repository typecheck/build/unit/RTL/synthetic checks passed locally; PR CI remains a release gate.

T1 results do not waive actual session/role/RLS, inbound-writer, provider,
large-volume, resource, hosting, spending, design-interaction or production gates.


## Reproduce on the owned local environment

This first lab explicitly names the dedicated Colima socket. It does not create a
VM, purchase services, use the default Docker context or target production.
Start that owned VM before these commands. Existing labeled resources are
verified and preserved; initialization will not reset a partially populated schema.

```
npm ci --ignore-scripts --no-audit --no-fund
python3 shared/start-database.py
# Required for the alternate membership-subquery experiment and lifecycle cleanup:
docker --host unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock exec -i sandra-inbox-stack-db psql -U postgres -d sandra_inbox_t1 -v ON_ERROR_STOP=1 < sync/setup.sql
bash sync/start-electric.sh
node --import tsx bulk/setup.ts
```

In separate terminals, start `node --import tsx bulk/worker.ts`, then
`bash bulk/start-runtime.sh` to register it, `node --import tsx bulk/server.ts`,
`node --import tsx sync/serve.ts`, and `node --import tsx browser/server.ts`.
The browser lab is at http://127.0.0.1:58790/. Its public synthetic identity is
explicit in the client; no real sessions or customers are represented.

Run `npm run typecheck` and `node --import tsx ui/selection.test.ts` for static
and selection checks. Run `node browser/verify.mjs` only while the interactive
fixture is otherwise idle. It uses real browser pointers and actual API/worker/
Postgres/Electric roundtrips, including an intentionally lost response. Install
Chromium with the pinned Playwright CLI if no compatible browser is available.
Run sync and bulk fault suites separately as documented in those directories;
those tests temporarily change the shared synthetic membership or kill a worker.
Do not run sync verification while the browser server occupies58790.

## Measured result and remaining gates

- Sync:11 checks each for100 explicit IDs and an alternate500-row membership
  subquery. The alternate schema is research, not an adopted production change.
- Restate:8 failure/correctness scenarios;4 additional HTTP checks.
- Selection:11 state-machine cases.
- Browser:4 additional access/renewal fault checks, plus10 end-to-end checks, including click/drop, group exceptions, explicit
  inspection, response-loss recovery,45-second renewal and updates after idle.
- Node22.23.2 strict package compilation, selection suite and browser server/harness passed. The first
  service tests used hostNode26; full production runtime validation remains open.

The500-ID direct request failed HTTP414 at31,102bytes;100 IDs work. Five-shard
multiplexing, HTTP1 fallback, stream reset and resource churn are unproven. The
100-row scope is a bounded spike, not an approved product maximum. The metadata
fixture action uses50 targets; that is not a new product cap on all bulk actions.
A60-second scope and45-second browser renewal accelerate lifecycle tests; the
production contract and authorization semantics remain in the approved spec.

This screen inspects summaries only. It does not implement history, new-arrival
indicators, auto-scroll selection, all filters, unknown senders, reply preparation,
real authentication or the complete supplied visual design. None of the approved
production latency targets has been measured by this lab. In particular a passing
local click/action does not establish p95 under the actual backlog and arrivals.
