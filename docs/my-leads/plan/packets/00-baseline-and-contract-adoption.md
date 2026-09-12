# Packet 00 — Baseline and contract adoption

**Depends on:** none

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `docs/my-leads/plan/BASELINE-RECEIPT.md (new execution receipt; no product files)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Read AGENTS, PRD, CONTRACTS and this plan. Verify Sandra origin, current main and owned clean worktree; compare the planning SHA to execution head.
2. Refresh open PR paths/contracts for 519, 522, 492 and assignment work. Record actual dependencies and original source owners; do not copy unreviewed branches.
3. Verify Jitter remote-main and deployed build identity for the later producer packet through supported read-only metadata. Source identity alone is not deployed identity.
4. Confirm package-lock/npm, Node>=22 (CI24), Next16.2.4 and available version docs. Do not upgrade dependencies. Inventory test accounts/physical targets without creating or resetting anything.

## Verification

- `git status --short`
- `git rev-parse HEAD origin/main`
- `gh pr list --repo biginkc/sandra --state open --json number,title,headRefName,baseRefName`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Baseline receipt identifies head, dependencies, scope owners and verification assumptions. Contracts are adopted unchanged or reconciled before consumer implementation.

## Boundaries

No migrations, feature execution or new task dispatch. Unavailable live metadata blocks only the relevant live operation.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
