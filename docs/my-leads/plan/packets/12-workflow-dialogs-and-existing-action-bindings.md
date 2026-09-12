# Packet 12 — Workflow dialogs and existing action bindings

**Depends on:** P05, P06, P08, P10, P11

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `src/app/(dashboard)/my-leads/attempt-dialog.tsx, offer-dialog.tsx, lifecycle-dialog.tsx, action-bar.tsx (new)`
- `src/app/(dashboard)/my-leads/dialogs.test.tsx (new)`
- `src/app/(dashboard)/my-leads/existing-actions.ts and existing-actions.test.ts (new thin adapters)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Bind row/header Start call to current shared call entry without replacing pre-call setup. Render optional-recording attempt flow with actual external occurrence time.
2. Implement motivation/readiness and direct offer flow, required follow-up date/time, and manual contract signed. No forced appointment/stage sequence.
3. Implement decline/Needs sequence handoff and deliberate archive using P06 results; show atomic failure vs success clearly.
4. Reuse existing note templates/composer and appointment booking/lifecycle actions through authorized adapters. Only an explicit schedule action creates an appointment.
5. Revalidate selected queue, own badge and affected lead surfaces after committed success. Keep idempotency UUID on retry; stale state asks refresh, not duplicate submission.

## Verification

- `npm run test:rtl -- 'src/app/(dashboard)/my-leads/dialogs.test.tsx'`
- `npm run test -- 'src/app/(dashboard)/my-leads/existing-actions.test.ts'`
- `npm run typecheck`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

One-call qualification/offer/sign works; offer logging sends nothing; no recording allowed; No motivation provided accepted; Needs sequence produces exact handoff only.

## Boundaries

Do not modify eSign send or reminder/sequence workers. No provider mocks passed off as seller initiation proof.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
