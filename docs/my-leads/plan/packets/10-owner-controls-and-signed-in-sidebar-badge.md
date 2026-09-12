# Packet 10 — Owner controls and signed-in sidebar badge

**Depends on:** P01, P09

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `src/app/(dashboard)/my-leads/access-actions.ts and access-actions.test.ts (new)`
- `src/app/(dashboard)/my-leads/acquisitions-settings.tsx and acquisitions-settings.test.tsx (new)`
- `src/components/dashboard-sidebar.tsx and dashboard-sidebar.test.tsx (existing shared seam)`
- `src/app/(dashboard)/layout.tsx (narrow badge/gate prop seam only)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Create owner-only Manage Acquisitions dialog using authorized same-org roster and P01 settings actions.
2. Add owner-selected Acquisitions member input for queue read; selected member never affects signed-in-user nav badge.
3. Add one My Leads nav item between Leads/Jobs with feature gate and tiny count. Include mobile nav using same shared item list.
4. Preserve shell rendering/provider mounting and permission roles. Sidebar does not query all lead rows or load global auth inventory.

## Verification

- `npm run test -- 'src/app/(dashboard)/my-leads/access-actions.test.ts'`
- `npm run test:rtl -- 'src/app/(dashboard)/my-leads/acquisitions-settings.test.tsx' src/components/dashboard-sidebar.test.tsx`
- `npm run typecheck`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Owner controls work without admin-email access; member denied; selected rep content and own badge remain distinct; existing sidebar/shell preserved.

## Boundaries

Coordinate layout/sidebar ownership before edits. Do not change admin/users or add Acquisitions as a security role.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Designation transition fixture

Follow CONTRACTS: disabling a designation changes future episode eligibility only; preserve current eligible clock, self/owner queue and historical KPI access. Retain former designated members with history in the selector, labeled disabled. Test disable, new assignment and re-enable separately from organization feature gating.
