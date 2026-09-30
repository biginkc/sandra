# Inbox hosting candidate

Proposed, not provisioned. This package does not authorize spending, set production
variables, create a logical slot, or enable the redesigned Inbox. The worker image
and migration release remain explicit incomplete dependencies in candidate.json.

Use a new Sandra Inbox project in the existing biginkc Railway workspace. Four
single-replica pilot services run in Railway Virginia, near the verified Supabase
us-east-1 database: private Electric, private Restate, private operation/projection
worker, and an authenticated public sync relay. Sandra's existing Next deployment
calls the relay after its own canonical user/workset authorization; browsers never
receive the relay secret. Electric and Restate receive no public domain. No new
PostgreSQL server or unrelated Railway project is reused.

The relay is necessary because the existing Vercel app cannot directly resolve
Railway's private network. It restricts the upstream table and columns, strips
browser cookies/credentials and non-allowlisted response headers, buffers at most
2MB per response with32 concurrent shape requests, bounds request time, and does not retry uncertain requests. Its readiness
requires Electric200, not merely process-running202. Next route wiring must pass
INBOX_ELECTRIC_RELAY_TOKEN through upstreamHeaders; that change is a separate
reviewed application dependency. Missing credentials fail closed.

## Candidate resources and costs

Candidate limits: Electric1GiB/1CPU/10GB volume; Restate2GiB/1CPU/20GB volume;
worker1GiB/1CPU; relay0.5GiB/0.5CPU. One replica each, no auto-sleep. The proposed
monthly review threshold is150 USD incremental, not a provider hard ceiling.
Using the provider's listed units, sustained nominal limits total119.5 USD/month
before egress; assumed100GB egress adds5 USD. GiB/GB accounting, billing periods,
existing plan credits, backups, Supabase/Vercel usage and taxes affect the actual
bill. These are sizing assumptions, not a measured production workload or quote.

Railway prices RAM10 USD/GB-month, CPU20 USD/vCPU-month, volumes0.15 USD/GB-month
and egress0.05 USD/GB. [Official pricing](https://docs.railway.com/pricing/plans).
The existing plan was not changed. Resource ceilings must be set through the
service configuration and verified afterward; railway.json does not claim to
encode those limits. Confirm workspace plan supports the proposed volumes.

Railway's hard usage limit applies to the workspace and can stop every workload.
Do not set a shared workspace hard limit for this Inbox experiment. Monitor this
project's incremental usage and stop new Inbox admission before crossing the
approved review threshold; preserve accepted jobs and persistent volumes.
A genuinely isolated hard billing cap needs a separately approved billing setup.
[Official cost controls](https://docs.railway.com/pricing/cost-control).

## Configuration and deployment conditions

- Keep INBOX_WORKSPACE_SERVER_ENABLED disabled until the per-user pilot gate,
  canonical schema baseline and full-stack acceptance tests pass.
- Pin all images, including the final worker; do not auto-update image tags.
  The relay Node22 image index was resolved from Docker's registry on2026-09-13.
- Electric settings: storage at /var/lib/electric, manual publication, a dedicated
  replication stream ID, ELECTRIC_LONG_POLL_TIMEOUT=8000ms, query pool2 initially, telemetry off. Scrape a metrics
  endpoint if enabled; otherwise leave it disabled. Allowlist only the narrow
  projection with REPLICA IDENTITY FULL. A fixed maximum shape count requires
  measured generation churn and cleanup before setting its production value.
- Reserve at most8 new direct database connections initially: up to5 for Electric
  management/query/replication,2 operation workers and1 projection maintenance.
  Verify actual connections under load; defaults are not the budget. Existing
  PostgREST/API load is additional and needs the end-to-end concurrency test.
- Restate pinned image is1.7.5. Candidate memory pools: RocksDB512MiB,
  query128MiB, record cache64MiB, invoker128MiB, with room for runtime overhead.
  Validate these exact settings in the pinned runtime before deployment.
  Restate's durable volume is required. A single node is a pilot choice with
  restart recovery, not high availability. Test volume recovery and application
  receipt reconciliation; do not promise zero data loss for volume destruction.
- Store DB credentials and relay secret only in the named services' secret
  variables. Scope the DB role to the required projection or operation wrappers.
  Require verified TLS to Supabase. No administrator database fallback.
- The production Electric role packet is `experiments/inbox-production-install/electric-replication-role.production.sql`.
  Run it only through `run-electric-replication-role.py` with `PGHOST` set to
  the direct host `db.<project-ref>.supabase.co`; the runner compares that
  host-derived ref with `--project-ref` before invoking psql. The role password
  input must be a client-computed `SCRAM-SHA-256$...` verifier on stdin, for
  example:
  ```sh
  printf '%s\n' "$SCRAM_VERIFIER" | python3 experiments/inbox-production-install/run-electric-replication-role.py --packet install --project-ref "$PROJECT_REF"
  ```
  Also export `PGSSLMODE=verify-full` and
  `PGSSLROOTCERT=$PWD/experiments/inbox-production-install/supabase-prod-ca-2021.crt`.
  The runner rejects `PGHOSTADDR`, `PGSERVICE`, and `PGSERVICEFILE`, and checks
  the CA file's exact SHA-256 pin before invoking psql. The committed CA is the
  public Supabase Root 2021 certificate; it is not a credential.
  The runner emits `\set` directives followed by `\i`, so the verifier is
  never a process argument and plaintext passwords are refused. Do not use
  `psql -v electric_password=...` or put a password in a DSN. Keep the
  preflight receipt's `prior_replica_identity` and
  `prior_replica_identity_index`; teardown requires those exact values and
  restores them after dropping the publication.
- Every Restate worker deployment must set
  `INBOX_RESTATE_REGISTRATION_PATH=/runtime/<64-lowercase-hex-image-digest>`.
  The worker serves that versioned path and the registration helper uses it as
  the deployment identity. Railway registration also requires
  `INBOX_RUNTIME_GENERATION=<64-lowercase-hex-image-digest>`; a missing,
  reused, or first-12-hex collision is rejected before registration.
- `INBOX_ELECTRIC_RELAY_TOKEN` (Next, read by `src/lib/inbox/sync-upstream-config.ts`)
  and `INBOX_RELAY_TOKEN` (relay, read by `services/inbox-sync-relay/server.mjs`)
  are the SAME secret in two processes' own env vars — not a mismatch to
  reconcile, a value to keep identical on every rotation. Generate it from the
  Next alphabet (`[A-Za-z0-9_-]{32,256}`, e.g. a base64url random value); the
  relay's own check only requires 32-256 non-whitespace characters, so a
  Next-valid token is always relay-valid (parity proved by
  `deployment/inbox/relay-token-fixtures.json`, consumed by both
  `src/lib/inbox/sync-upstream-config.test.ts` and
  `services/inbox-sync-relay/server.test.mjs`). `INBOX_ELECTRIC_SHAPE_URL` must
  be an `https://` shape URL with no query/fragment/userinfo and path exactly
  `/v1/shape` (Next enforces this at `sync-upstream-config.ts:8`); TLS
  terminates at the Railway edge, not in application code. The projection
  worker service gets no public Railway domain — same rule as Electric and
  Restate above; only the relay is public.
- Deploy the relay from services/inbox-sync-relay; its railway.json is scoped to
  that service root. Other service image/config creation requires explicit IDs.
- Rollback disables new Inbox admission and returns users to the existing Inbox,
  while workers finish/recover accepted operations. Preserve old worker versions,
  receipts and Restate data. Never delete a replication slot while a consumer is
  still using it, or delete accepted-job state as part of a UI rollback.

### Generation rollout and drain procedure

Each Railway operation/reply worker service is generation-specific. For an image
digest `G`, create the new private services with hostnames
`inbox-operation-worker-G[:12].railway.internal` and
`inbox-reply-send-worker-G[:12].railway.internal`, where `G[:12]` is the first
12 lowercase hex characters of the full 64-character digest. Set each worker's
`INBOX_RESTATE_REGISTRATION_PATH=/runtime/G`, and set the registration helper's
`INBOX_RUNTIME_GENERATION=G`. Register the new endpoints only after `/livez` and
the Restate registry readback pass. The helper rejects any registered generation
whose short hostname collides with a different full digest and keeps at most two generations per
Restate service, so the old endpoint remains registered and routable while its
outbox is drained.

During rollback or replacement, stop new admission, observe the old generation's
outbox/attempts and readiness until it is drained, then deregister and retire the
old Railway services. Never repoint the old hostname, delete its service, or
remove its Restate registration before that drain proof. A second generation may
be registered and served concurrently; the generation path and hostname are both
part of the deployment identity.

References: [Electric deployment](https://electric.ax/docs/sync/guides/deployment),
[Restate memory](https://docs.restate.dev/server/memory),
[Restate persistence](https://docs.restate.dev/server/overview),
[Railway regions](https://docs.railway.com/deployments/regions).

The32-poll relay ceiling admits six full five-partition worksets with two spare
slots; each additional browser tab counts as another workset. This is a candidate
pilot sizing limit, not proof of multi-user production capacity. Total memory
exceeds buffered payload because fetch buffers and concatenation also consume RAM.
Health probes are coalesced separately and cannot consume shape admission slots.
