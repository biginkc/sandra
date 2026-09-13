# Hosting preflight — 2026-09-13

Read-only Railway CLI 4.57.1 checks succeeded. This worktree is not linked to a
Railway project. The authenticated workspace is biginkc’s Projects
(b6fd2179-2a55-4cb8-b890-0dd4ce8b9c23). Project inventory exposes
jitter-dialer-worker and closer-lab-relay; neither is an Inbox-specific deployment.
No project/service/environment was created, linked, configured, or deployed.
No credentials or variable values were requested. Access availability is now
verified; authority to spend or reuse those existing workloads is not inferred.

## Current official deployment constraints

Electric’s deployment guide requires logical replication and a suitable database
role, plus persistent shape storage. It documents a default query pool of20;
that default must not be adopted blindly against the observed Sandra maximum of90
connections. A separately sized pool and explicit manual publication allowlist
remain required. Readiness requires HTTP200;202 is a live but not-ready process.
See [Electric deployment](https://electric.ax/docs/sync/guides/deployment).
These current docs are guidance; each setting still needs validation against the
pinned server image before deployment. This does not change the approved version.

Railway currently prices measured RAM at$10/GB-month, CPU at$20/vCPU-month,
egress at$0.05/GB and volumes at$0.15/GB-month. Plan minimums/included usage apply.
See [Railway pricing](https://docs.railway.com/pricing/plans).
These rates are not a quote or authorization: measured resource averages,
volumes, retention, traffic and the existing workspace plan are still needed.
A spending control must not inadvertently stop unrelated shared services; review
its actual workspace scope before changing it.
[Cost controls](https://docs.railway.com/pricing/cost-control).

## Concrete next gate

Prepare an Inbox-specific deployment configuration with private Electric ingress,
Restate persistent recovery, worker service, authenticated app gateway, explicit
DB connection allocation, storage retention/alerts, region and rollback. Compare
that configuration’s measured isolated workload against provider constraints,
then request approval for the named environment/services and incremental budget.
Do not add services to the unrelated existing projects merely because CLI access
works. No production credentials, logical slot/publication or paid resources
were changed in this preflight.
