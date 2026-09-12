# Packet 04 — Central working-time and warning functions

**Depends on:** P00

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `src/lib/my-leads/time.ts and time.test.ts (new)`
- `supabase/migrations/<new>_acquisition_time_helpers.sql`
- `src/lib/my-leads/time.integration.test.ts (new)`
- `src/lib/time/zoned.ts (only a proven missing export if necessary)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Reuse zoned.ts wall-time conversion; implement pure workingDeadline/workingMinutesBetween with Central M-F09-17, 30minutes and elapsed12h offer threshold.
2. Implement a SQL helper with the same calendar contract for authoritative query warnings. Do not persist stale booleans or use now() in index predicates.
3. Provide identical fixture vectors to TS and SQL: midnight boundaries, Friday carryover, afterhours, spring/fall DST, actual stop outside hours and null launch timing.
4. Keep elapsed KPI duration distinct from warning business minutes. Return next warning transition instant for later UI refresh.

## Verification

- `npm run test -- src/lib/my-leads/time.test.ts src/lib/time/zoned.test.ts`
- `npm run test:integration -- src/lib/my-leads/time.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

TS/SQL match boundary vectors; Friday16:50 -> Monday09:20; Needs offer red at12 elapsed hours; no login dependence.

## Boundaries

No timezone package addition, holiday engine, cron or schedule-settings UI. Migration timestamp order coordinated with schema owner.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
