# Packet 01 — Organization settings and Acquisitions designation

**Depends on:** P00

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_settings.sql`
- `src/lib/my-leads/settings.ts and settings.test.ts (new)`
- `src/lib/supabase/types.ts (schema-owned additions only)`
- `src/lib/my-leads/settings.integration.test.ts (new)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Add acquisition_org_settings and acquisition_commands; add protected memberships.acquisitions_enabled. Feature defaults off.
2. Implement fn_set_acquisition_designation and fn_set_acquisition_settings, authenticated same-org owner checks, active recipient validation and transactional audit.
3. Prevent direct legacy membership UPDATE from bypassing the designation owner check without changing Hugo role/access behavior. Deny direct access to new tables; grant only named RPC execution.
4. Define typed errors/settings payload and verify direct grants as well as UI wrapper behavior. Keep global admin/users unchanged.

## Verification

- `npm run test -- src/lib/my-leads/settings.test.ts`
- `npm run typecheck`
- `npm run test:integration -- src/lib/my-leads/settings.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Owner can change only same-org designation/configuration; member/foreign/expired callers cannot. Role unchanged, gate default false, recipient membership rechecked.

## Boundaries

Integration command requires Tester admission. No live feature enablement or assigning Maria/Jarrad IDs by guess.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Schema and command details

Create the `acquisition_commands` receipt foundation in P01 for settings/designation; P03 extends it. Use the org-level envelopes and operation names in CONTRACTS with request-hash conflict and replay tests. Add the settings/cohort FK in P02 after cohorts exist. Test unchanged Hugo/service membership writes, rejected direct designation changes, and owner RPC success using the dual marker/owner guard.
