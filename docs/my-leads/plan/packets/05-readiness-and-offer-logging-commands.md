# Packet 05 — Readiness and offer logging commands

**Depends on:** P03

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_offer_commands.sql`
- `src/lib/my-leads/offer-actions.ts and offer-actions.test.ts (new)`
- `src/lib/my-leads/offer-actions.integration.test.ts (new)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Implement fn_ready_acquisition_offer and fn_log_acquisition_offer through authenticated wrappers and frozen mutation envelope.
2. Require motivation supplied or already recorded, allow explicit no_motivation, require sent/follow-up time and positive amount; protect later/terminal status and stale assignment/version.
3. Make queue stage, shared Interested/Offer Sent, offer fact, version and audit one transaction with replayed command result.
4. Allow direct offer from fresh/Contacted state. A Dropbox Sign method does not invoke eSign. No task or appointment for follow-up field.

## Verification

- `npm run test -- src/lib/my-leads/offer-actions.test.ts`
- `npm run test:integration -- src/lib/my-leads/offer-actions.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Direct first-call offer path works; exact retries replay; distinct pending offer rejected; missing fields fail with field errors; no provider/task/enrollment writes.

## Boundaries

Do not alter lead-esign-actions or existing calendar vocabulary. Retain original performer even when owner operates.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Offer integrity cases

Reject follow-up equal to/before sent time, a second distinct pending offer, and resolved outcomes missing actor or timestamp. Concurrent pending inserts must be stopped by the database partial unique index. Historical valid follow-up may already be overdue; do not silently replace it.
