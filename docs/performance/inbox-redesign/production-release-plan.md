# Production delivery sequence

Goal: ship the full approved core Inbox (P1–P4/P8), not only a performance hotfix.
Gated sequence enrollment, apology + permanent DNC and Undo are separate proposals.

## Release 0: evidence and independent foundation

Current branch `codex/inbox-redesign-p0-20260913`, based on main 7912891c.
Depends on: none. Open draft PRs #514/#518/#521/#418 are overlap references only.

Deliver approved budget/cap, all-inventory acceptance matrix, opt-in existing-page
timings and candidate-neutral read contract. Gather bounded catalog and workload
evidence, isolated authenticated baseline and old Inbox/Outbox smoke tests. Freeze
remaining numerical budgets and P0 decision before architecture implementation.
No new Inbox entry enabled and no outgoing provider traffic in this increment.

## Release 1: flagged read experience

Implement independent detail/list/search/count/unknown paths, bounded history and
cache, rendered-detail mark-read, scoped reconciliation and old/new entry flag.
Test A/B/A cancellation, deep links, access revocation, incoming activity and the
approved first-open/revisit targets. Summaries or new synchronization code require
the P0 decision. This release is a performance pilot, not completed bulk scope.

## Release 2: selection and durable saved actions

Implement exact selection gestures, keyboard equivalents, hidden-target review,
stable incoming rows, shared click/drop command path, saved action builder and
durable outcome/assignment operations. Include promotion and snapshot-scoped
unknown dismiss/restore. Feature targets stay disabled until their server handlers
are correct. Test rollback-free partial results, repeat requests, crash/replay,
expired worker claims, concurrent edits, tenant boundaries and revoked permissions.

## Release 3: reviewed bulk replies

Implement the approved recipient/content review with a server cap of 50, frozen
personalization and routes, collision resolution, new-inbound invalidation and
durable dispatch attempts. Unknown provider acceptance is not auto-retried. Use
test doubles for faults; actual provider verification, if needed, needs separately
authorized test traffic. Preserve Outbox execution and reporting semantics.

## Release 4: full core pilot and default enablement

Require all approved core acceptance rows, realistic volume/growth/arrival tests,
ordinary authenticated synthetic users, and old Inbox/Outbox regression evidence.
Pilot the completed experience with the VA before making it default. Verify that
accepted operations remain observable and recoverable when the interface flag is
disabled. Preserve old interface fallback; it does not reverse data mutations.

## Exact-candidate release mechanics

1. Recheck current main and open dependencies. Declare `Depends on` for every PR;
   stack validated unmerged dependencies. Never blindly merge competing old state
   machines or copy unreviewed branch code.
2. Run focused behavior tests during each increment, then repository-required
   verification, build, migration rehearsal and disposable database E2E. The
   current E2E workflow provisions isolated Supabase; do not use old shared reset
   harnesses or treat synthetic DOM tests as backend proof.
3. Independently review the exact candidate and repair findings. Preserve original
   Fable-approved plan hash; material plan changes get a fresh actual Fable review.
4. Test preview with ordinary authenticated synthetic data and record commit,
   deployment, schema, feature flag and fixture identity. A preview build alone is
   not acceptance. Migration changes follow repository guarded workflows.
5. Merge only the owned reviewed green candidate under repository rules. Record
   Production deployment SHA/status and verify runtime against it. Enable only the
   stage whose evidence passed; observe error/latency/job/ingestion behavior.
6. On correctness regression, disable new UI/action admission while preserving
   receipt visibility and recovery. Do not delete additive schema or repeat
   uncertain sends. Rollback must not interrupt safe handling of accepted jobs.

## Current evidence and gaps

- User approved initial budgets and cap; companion budget file records them.
- GitHub Production deployment 6419416079 reports successful 7912891c deployment.
- Fresh owned Colima/Supabase environment is being prepared, separate from other
  local stacks. Native E2E remains the release gate.
- Supabase project-list authentication returned Unauthorized on September 13.
  Production catalog/statistics access is not established. This blocks that
  evidence item, not isolated implementation or testing.
- No end-to-end speedup, new Inbox parity, or bulk acceptance is claimed yet.
