# Packet 02 — Queue state and assignment episodes

**Depends on:** P01

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_queue_episodes.sql`
- `src/lib/my-leads/types.ts (new contract types; designated type owner)`
- `src/lib/my-leads/episodes.integration.test.ts (new)`
- `src/lib/events/index.ts (bounded event constants only)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Add acquisition_queue_states, acquisition_assignment_episodes and acquisition_launch_cohorts with exact FK targets, version, archive, motivation and signed-event fields from CONTRACTS.
2. Install a narrow assignment observer covering property INSERT and actual assigned_user_id change; unchanged assignment does nothing. Close/open episodes without resetting queue stage.
3. Snapshot eligibility from designation plus rollout gate. Configured prelaunch assignments are recorded ineligible, preserving cutover traceability; unconfigured organizations are untouched.
4. Preserve source assignment/DNC guards. Handle handoff archive suppression, subsequent deliberate acquisition reassignment, and Under Contract archival exactly as CONTRACTS. Add transactional lead audit event constants only as needed.

## Verification

- `npm run typecheck`
- `npm run test:integration -- src/lib/my-leads/episodes.integration.test.ts`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Single/bulk/create assignment paths produce one open episode; no arbitrary status-edit synchronization; same-instant/end and replay constraints hold; old history survives removal/reassignment.

## Boundaries

Own only new trigger/migrations and event constants. No broad rewrite of existing leads/actions, Messages filters, or global status enum. Coordinate event constants with other owners.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.

## Observer acceptance

Use the validated transaction-local handoff marker and archive-first order in CONTRACTS. An unchanged assignee is a no-op; away-and-back generates a distinct episode/revision. Preserve history on membership offboarding, and verify single-column actor FKs participate in Hugo durable-activity detection without cascading deletion. Add the deferred settings/cohort FK here.
