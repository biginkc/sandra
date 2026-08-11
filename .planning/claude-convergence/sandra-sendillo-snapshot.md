# Sandra Sendillo Snapshot Convergence Ledger

## Goal

- `goal_id`: `sandra-sendillo-snapshot`
- Move Sendillo SMS health aggregation out of the Overview request and into a durable 15-minute background snapshot.
- Plan source: Jarrad-approved thread plan, Fable plan verdict `BLOCKING: NO`, `APPROVE_PLAN: YES`.
- Baseline: `origin/main` at `94080b6c8e4946d7c5de00d688e415fbe4200c37`.
- Authority: production-aware; migrations use Sandra's guarded workflow.

## Acceptance gates

- [x] Stored Sendillo snapshot preserves current queued/non-queued semantics.
- [x] Overview performs one stored read and no paginated Sendillo/property aggregation.
- [x] 15-minute cron is authenticated and restricted to 06:00-midnight America/Chicago.
- [x] Last-good snapshot survives compute/write failures and overlapping runs.
- [ ] Typecheck, full unit/RTL, migration safety, build, and Playwright pass. (All except Playwright are green.)
- [ ] Current-head Codex manual review returns no blockers.
- [ ] Current-head Fable review returns `BLOCKING: NO`, `APPROVE_MERGE: YES`.
- [ ] Production Chrome proves cold <5s, warm <2s, and no startup Tracerfy/Sendillo pagination.
- [ ] Two scheduled production snapshots advance about 15 minutes apart.

## Preflight

- Claude/Fable CLI is installed and authenticated; deterministic exact-SHA review will use CLI.
- GitHub, Supabase, and Vercel CLIs are available.
- Chrome extension control is available for final production evidence.
- A fresh isolated worktree was created from current `origin/main` and dependencies installed with `npm ci`.
- PR dependency audit found no open Sendillo/dashboard-metric dependency; planned PR declares `Depends on: none`.
- Jarrad authorized the pending PR #358 production migration; its guarded Production environment was approved.

## Iterations

- Iteration 0: Plan approved by Fable with service-role/global semantics, queued-row asymmetry, reset hygiene, operating-window acceptance, dependency declaration, and migration approval requirements incorporated.
- Iteration 1: Implemented the durable snapshot table, service-role computation/capture functions, Central-window cron route, single-row Overview read, stale/unavailable UI, reset hygiene, generated types, and parity/safety tests.
- Iteration 1 evidence: disposable PostgreSQL rehearsal passed queued parity, provider exclusion, authenticated read-only ACLs, service-only refresh, and atomic newer-reading-wins behavior. Full verification passed 1,571 unit tests and 510 RTL tests; production build and migration-safety rehearsal passed. Repository-wide lint remains red on 324 pre-existing errors, while targeted lint for every changed TypeScript file passes.
- Credit rollout: PR #358 is merged at `94080b6c8e4946d7c5de00d688e415fbe4200c37`; guarded production migration run `31435642275` completed successfully.
- Iteration 2 manual review: accepted two findings—direct snapshot reads needed Sandra's active-access lifecycle gate, and the message-window dates needed the same Central timezone as the snapshot timestamp. Added a forward policy-hardening migration because the original migration had already reached the test project, plus active/suspended hosted authorization coverage and a UTC-midnight/Central-evening UI regression.
- Iteration 2 rejected finding: per-organization snapshot storage conflicts with the approved global service-role metric model; global aggregation is intentional, while active-account authorization is still enforced.
- Hosted test evidence at iteration 1 head: guarded test migration run `31502712523` succeeded and SQL/JavaScript parity plus newer-wins integration tests passed. The forward access migration and expanded integration test must rerun on the corrective head.
- Iteration 3 manual review: accepted a test-contract finding that the already-applied forward policy migration itself needed a static sentinel. Added exact drop/create/active-access assertions so deleting or weakening the forward correction fails locally even if a shared hosted database retains old state.
