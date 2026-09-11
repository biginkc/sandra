# Packet 09 — Scoped queue pages, details and KPI queries

**Depends on:** P03, P04

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `supabase/migrations/<new>_acquisition_read_model.sql`
- `src/lib/my-leads/queries.ts and queries.test.ts (new)`
- `src/lib/my-leads/queries.integration.test.ts (new)`
- `src/lib/my-leads/appointment-attribution.ts and appointment-attribution.test.ts (new adapter if needed)`
- `supabase/migrations/<new>_acquisition_query_cursors.sql`
- `supabase/migrations/<new>_acquisition_appointment_attribution.sql (conditional sidecar and task INSERT capture; no lifecycle rewrite)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Implement queue/KPI/detail/badge/roster RPCs from CONTRACTS. Enforce selected-rep access in database and server wrapper, no direct browser table access.
2. Return per-stage bounded pages/cursors, counts, server snapshot and next-warning times. Detail histories paginated. Use SQL-issued server-held UUID cursor records with five-minute expiry and shared initial timestamp as frozen in CONTRACTS; reject cross-viewer/member/stage/filter use.
3. Calculate KPI by original actor/time and episode; stale current distinct queue count independent of range. Use canonical future task appointments for callback indicator and canonical held outcome.
4. Map appointment accountability to appointment assignee at booking for both due and held, never booker/completer/property current assignee. Audit immutable evidence; otherwise add the frozen attribution sidecar and task INSERT trigger from CONTRACTS. Test owner-booked/owner-completed appointments for Maria and later property/task reassignment. Historical ambiguous rows are unavailable, not attributed by guessing.
5. Verify hand-SQL fixture totals, warning ordering/pagination ties, search-vs-KPI semantics, owner equality, and no initial full transcripts/notes.

## Verification

- `npm run test -- src/lib/my-leads/queries.test.ts src/lib/my-leads/appointment-attribution.test.ts`
- `npm run test:integration -- src/lib/my-leads/queries.integration.test.ts`
- `npm run typecheck`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Each stage visible despite large early section; counts use full eligible set; no cross-tenant/member read; elapsed and working-time semantics correct; bounded detail query.

## Boundaries

No performance refactor of Leads/Messages or mandatory Realtime. Sidecar attribution extension, if necessary, must be documented and reviewed before adding beyond source audit.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
