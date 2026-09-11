# Packet 13 — Launch preview, initialization and rollback tooling

**Depends on:** P02, P06, P09

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_launch_commands.sql`
- `scripts/my-leads-launch.ts (new dry-run-by-default tool)`
- `src/lib/my-leads/launch.integration.test.ts (new)`
- `docs/my-leads/plan/LAUNCH-RUNBOOK.md (execution-specific receipt/runbook)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Implement read-only exact cohort preview, count/status exclusions, fingerprint and per-property expected values for verified Maria identity.
2. Implement separate admitted atomic apply command with fingerprint/version/assignee recheck, prior-value evidence, excluded launch episodes and advanced/terminal preservation.
3. Test retry and concurrent cohort change; no fake calls/attempts/offer/time, no task/enrollment. Handoff recipient identity/configuration verified before enablement.
4. Document additive schema first, receiver before producer, flag off, admitted launch apply then gate enablement and read verification. Rollback disables feature first; never deletes actual activity.
5. Keep actual production invocation out of package install/migration startup. Provide exact approved operation args only after target/identity/candidate is known.

## Verification

- `npm run test:integration -- src/lib/my-leads/launch.integration.test.ts`
- `node --import tsx scripts/my-leads-launch.ts --help (once tool exists; must perform no writes)`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Dry run is read-only, apply bound to exact set, repeat no duplicates, active work protected by compensating-rollback guards. Actual cohort execution still gated.

## Boundaries

No literal production emails/IDs/credentials in checked-in fixtures. User authorized planning now, not executing launch.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Replay and concurrent-change safety

Include open episode ID/assignment revision, member designation/access and settings revision in preview fingerprint and locked apply checks. Test assignment away-and-back and designation toggle invalidation. Use `apply_acquisition_launch` command receipt/hash; replay returns the original cohort/count and never writes a second launch. Respect command/property lock order, with properties sorted.
