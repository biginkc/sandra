# Packet 08 — Sandra call evidence receiver and attempt logging

**Depends on:** P03

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `src/lib/my-leads/call-evidence.ts, call-evidence.test.ts and call-evidence.integration.test.ts (new)`
- `src/app/api/internal/jitter/my-leads/call-started/route.ts and route.test.ts (new, reuse existing internal auth)`
- `supabase/migrations/<new>_acquisition_attempt_commands.sql`
- `src/lib/my-leads/attempt-actions.ts and attempt-actions.test.ts (new)`
- `src/lib/dialer/jitter-server.ts and actions.ts (narrow call-binding/wrap-up hooks only; coordinate existing owners)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Add server-only bind_call_context receipt before provider start, using existing stable token; do not count it as an attempt.
2. Implement authenticated internal receiver and service-only fn_record_acquisition_call_start using frozen evidence. Validate signature/context/aliases and record once; ordinary authenticated RPC users cannot fabricate start evidence.
3. Implement manual fn_log_acquisition_attempt and original-call-authorized finalize hook. Keep occurrence/record time separate, optional recordings and pending outcomes, original performer/episode.
4. Provider facts after reassignment attach history but never advance new owner queue. UI forms attach to existing call attempt; preserve writeback-first/wrap-up-first existing behavior and no duplicate count.

## Verification

- `npm run test -- src/lib/my-leads/call-evidence.test.ts src/lib/my-leads/attempt-actions.test.ts src/app/api/internal/jitter/my-leads/call-started/route.test.ts`
- `npm run test -- src/lib/dialer/jitter-server.test.ts src/lib/dialer/actions.test.ts`
- `npm run test:integration -- src/lib/my-leads/call-evidence.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Signed fixture stops clock only for actual seller event; user-supplied start rejected; duplicate/late/reordered evidence safe. Manual external logged time supported without API integration.

## Boundaries

P08 can complete receiver/fixture before P07 producer. Never use after()/coach index or provider setup return as sole evidence; preserve pending PR519/522 call contracts.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Attribution assertions

Both manual and provider paths stop a response clock only for an actual seller call by that eligible episode’s assigned rep with occurrence inside the original assignment interval. Owner/other-performer calls retain performer activity credit but cannot satisfy Maria’s clock. Late receipt is not occurrence time. Persist only the stable-token digest, never signed start capabilities.
