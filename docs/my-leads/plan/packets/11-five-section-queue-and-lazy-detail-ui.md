# Packet 11 — Five-section queue and lazy detail UI

**Depends on:** P09

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `src/app/(dashboard)/my-leads/page.tsx, loading.tsx, error.tsx (new)`
- `src/app/(dashboard)/my-leads/queue.tsx, queue-row.tsx, detail-panel.tsx (new)`
- `src/app/(dashboard)/my-leads/queue.test.tsx and detail-panel.test.tsx (new)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Build initial server snapshot and narrow client controls for five PRD sections, period/range/search, section counts and independent load-more.
2. Render existing motivation temperature and explicit response separately, honest launch timing, warning reasons, offer details and Under Contract archival state.
3. Fetch expanded detail only when needed; expand-all loads currently loaded rows with bounded concurrency, not the entire database.
4. Clear old selected member state/cursors on selection; discard stale responses. Refresh from server on focus/mutation and nearest warning boundary, no client clock authority.
5. Follow static visual language while applying revised labels and interactions; do not rebuild global nav/header or block on mockup rewrite.

## Verification

- `npm run test:rtl -- 'src/app/(dashboard)/my-leads/queue.test.tsx' 'src/app/(dashboard)/my-leads/detail-panel.test.tsx'`
- `npm run typecheck`

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

All stages visible, accessible collapse/expand/search/period behavior, loading/error isolation, original-vs-viewer identity clear, no eager transcript load.

## Boundaries

Own only new page files; shared milestone/write logic comes from RPCs. No new dashboard performance work.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
