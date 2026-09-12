# Packet 06 — Contract, decline, handoff and archive commands

**Depends on:** P05

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_handoff_commands.sql`
- `src/lib/my-leads/lifecycle-actions.ts and lifecycle-actions.test.ts (new)`
- `src/lib/my-leads/lifecycle-actions.integration.test.ts (new)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Implement fn_record_acquisition_contract, fn_decline_acquisition_offer, fn_handoff_acquisition_lead and fn_archive_acquisition_contract.
2. Contract signed persists signed event independent of offer; resolve pending offer if provided. Archive does not imply closed deal.
3. Decline locks offer/property/state, records Offer Declined, Needs sequence, verified recipient assignment and archive atomically. Nurture handoff does same without Dead or invented decline.
4. Replay successful handoff for original authorized actor even after ownership changed; no new command by previous owner. Inject failure/concurrent reassignment to verify all-or-nothing behavior.

## Verification

- `npm run test -- src/lib/my-leads/lifecycle-actions.test.ts`
- `npm run test:integration -- src/lib/my-leads/lifecycle-actions.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Handoff has no partial success, no automatic enrollment/task/send; Jarrad active identity verified each time; past credit and later/terminal protections remain.

## Boundaries

Do not wrap several existing PostgREST actions and label them atomic. Preserve real DNC paths; avoid touching sequence execution code.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
