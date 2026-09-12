# Packet 14 — Integrated acceptance and coordinated release

**Depends on:** P07, P08, P10, P11, P12, P13

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `e2e/my-leads.spec.ts (new)`
- `tests/integration/fixtures/my-leads.ts (new bounded reuse fixture helper)`
- `docs/my-leads/plan/ACCEPTANCE-RECEIPT.md (new per-candidate receipt)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Follow TEST-AND-RELEASE with exact candidate manual review and Astra Medium approval before shared Tester admission. Preserve feature cumulative review counter.
2. Use at most four accounts total, preferably three reused; no per-test auth creation or whole-tenant resets from this fixture helper. Inspect inherited global setup before running.
3. Run owner/member/foreign-org, one-call offer/sign, handoff/no-side-effects, timers, attribution, launch and neighbor existing lead/call/appointment journeys.
4. Obtain producer/receiver deployed contract proof under existing approved provider limits; code/fixture success is not live transport verification.
5. Controller merges one admitted PR, then verify main CI, migrations and deployment before next PR. Record preview and production separately plus cleanup/restoration release.

## Verification

- `npm run typecheck`
- `npm run test`
- `npm run test:rtl`
- `npm run test:e2e -- e2e/my-leads.spec.ts --project=chromium`
- `Native CI: npm run verify and existing required migration/E2E/Coach jobs in their established environments`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

All PRD acceptance cases traced to passing evidence; original behaviors retained; exact deployed identity, migration state, cohort/flag and restoration recorded.

## Boundaries

Do not launch broad suites locally with unknown target; publication can trigger shared writers. Failure goes to original owner under current review/browser rules, no unrelated cleanup scope.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
