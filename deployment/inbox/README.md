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
- Deploy the relay from services/inbox-sync-relay; its railway.json is scoped to
  that service root. Other service image/config creation requires explicit IDs.
- Rollback disables new Inbox admission and returns users to the existing Inbox,
  while workers finish/recover accepted operations. Preserve old worker versions,
  receipts and Restate data. Never delete a replication slot while a consumer is
  still using it, or delete accepted-job state as part of a UI rollback.

References: [Electric deployment](https://electric.ax/docs/sync/guides/deployment),
[Restate memory](https://docs.restate.dev/server/memory),
[Restate persistence](https://docs.restate.dev/server/overview),
[Railway regions](https://docs.railway.com/deployments/regions).

The32-poll relay ceiling admits six full five-partition worksets with two spare
slots; each additional browser tab counts as another workset. This is a candidate
pilot sizing limit, not proof of multi-user production capacity. Total memory
exceeds buffered payload because fetch buffers and concatenation also consume RAM.
Health probes are coalesced separately and cannot consume shape admission slots.
