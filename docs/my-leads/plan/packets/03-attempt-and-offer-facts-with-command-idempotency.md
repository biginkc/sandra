# Packet 03 — Attempt and offer facts with command idempotency

**Depends on:** P02

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_activity.sql`
- `src/lib/my-leads/validation.ts and validation.test.ts (new)`
- `src/lib/my-leads/activity.integration.test.ts (new)`
- `src/lib/supabase/types.ts (schema-owned additions)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Add acquisition_attempts and acquisition_offers with positive cents, occurrence/sent/follow-up times, original actors/episodes and unique pending/provider/request identities.
2. Implement shared private SQL authorization/lock/replay helpers used by later commands. Validate same-org/property/episode/call linkage and payload-hash replay conflict.
3. Accept optional DialPad recording; allow pending outcome only for real initiated Sandra calls. Explicit motivation response remains separate from temperature.
4. Define input validation and tagged error types without any provider/network operations. Do not create attempt rows for provisional call intents.

## Verification

- `npm run test -- src/lib/my-leads/validation.test.ts`
- `npm run typecheck`
- `npm run test:integration -- src/lib/my-leads/activity.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Constraints reject cross-linkage, SQL NULL loopholes and duplicate facts; valid DialPad call with no recording succeeds; caller cannot write new tables directly.

## Boundaries

No UI/dialing. Regenerate/update only schema-owned generated types; serialise this file with P01/P02 owners.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Required database assertions

Extend the P01 command ledger, do not recreate it. Assert one partial unique pending-offer index per org/property, `follow_up_at > sent_at`, positive integer cents, and NULL-explicit resolved outcome actor/time checks. Verify concurrent distinct pending offers yield one success and retries return the original result. Immutable actor FKs retain historical users under Hugo’s existing activity policy.
