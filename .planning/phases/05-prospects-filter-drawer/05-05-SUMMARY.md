---
phase: 05-prospects-filter-drawer
plan: 05
subsystem: prospects-filter-drawer
tags: [server-actions, rls, saved-filters, count-action]
requires:
  - filter-schema (Plan 05-01)
  - saved_filters table + RLS policies (Plan 05-02 / migration 055)
  - regenerated supabase types (Plan 05-03)
  - filter-to-supabase translator (Plan 05-04, parallel — shimmed here)
provides:
  - countProspectsForFilter server action
  - createSavedFilter / updateSavedFilter / deleteSavedFilter / togglePinSavedFilter server actions
  - Multi-user RLS isolation integration test (10 tests)
affects:
  - /properties drawer footer "Show N prospects" CTA (Plan 06 wires)
  - /properties Quick Filters bar star toggle (Plan 07/08 wires)
  - "Save as new preset…" flow (Plan 06 wires)
tech-stack:
  added: []
  patterns:
    - Sandra canonical server-action shape (requireOrgMembership → mutation → revalidatePath → Result<T>)
    - vi.hoisted + vi.mock("@/lib/supabase/server") for per-user JWT injection
    - vi.mock("next/cache") to stub revalidatePath outside Next request scope
key-files:
  created:
    - src/app/(dashboard)/properties/_actions/count.ts
    - src/app/(dashboard)/properties/_actions/saved-filters.ts
    - src/app/(dashboard)/properties/_actions/saved-filters.integration.test.ts
    - src/lib/prospects/filter-to-supabase.ts (no-op shim — Plan 05-04 replaces on merge)
  modified: []
decisions:
  - Used Result.data (not .value) — the canonical signature in src/lib/errors/result.ts is { ok: true, data: T }; the plan file's example used .value which would not have compiled.
  - applyFilters shim is sync (returns TBuilder, not Promise<TBuilder>) so awaiting the supabase builder doesn't trigger PromiseLike resolution to the response shape.
  - Update + delete do NOT pass user_id = auth.uid() in WHERE — RLS does the filtering at the DB layer (the canonical Sandra pattern).
  - Inserts hardcode is_base: false and starred: false — only the migration's seed step can create base presets, and starring requires an explicit togglePin call.
metrics:
  duration: ~25 minutes
  completed: 2026-05-08T02:31:09Z
  tasks: 3
  commits: 3
---

# Phase 05 Plan 05: Server Actions Summary

Live result count + saved-filter CRUD server actions wired to Sandra's Stage 1 RLS regime, with a 10-test multi-user RLS isolation integration test green against the live test Supabase project.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | countProspectsForFilter server action + applyFilters shim | `b3a016e` | `count.ts`, `filter-to-supabase.ts` |
| 2 | saved-filters CRUD server actions | `452b490` | `saved-filters.ts` |
| 3 | Multi-user RLS integration test | `e38d47f` | `saved-filters.integration.test.ts` |

## Action Signatures (for downstream client wiring in Plans 06–08)

### `count.ts`

```ts
export type CountResult = { count: number };

export async function countProspectsForFilter(input: {
  orgId: string;
  blocks: BlockStack;
}): Promise<Result<CountResult>>;
```

- **Authoritative orgId source:** comes from page render context (Plan 09 wires from `getCurrentMemberships()`). Client passes it through.
- **Debounce:** the client (Plan 06's `useDebouncedFilters` hook) debounces 250 ms before calling. The action runs every call.
- **Pipeline-status block contract:** when a `pipeline_status` block is present in the stack, the default `eq('status','prospect')` predicate is dropped — Plan 05-04's translator emits the appropriate IN/NOT IN clause.

### `saved-filters.ts`

```ts
export async function createSavedFilter(input: {
  orgId: string;
  name: string;
  filtersJson: FilterState;
}): Promise<Result<{ id: string }>>;

export async function updateSavedFilter(input: {
  orgId: string;
  id: string;
  name?: string;
  filtersJson?: FilterState;
}): Promise<Result<void>>;

export async function deleteSavedFilter(input: {
  orgId: string;
  id: string;
}): Promise<Result<void>>;

export async function togglePinSavedFilter(input: {
  orgId: string;
  id: string;
  starred: boolean;
}): Promise<Result<{ starred: boolean }>>;
```

All four follow Sandra's canonical pattern (D-13):

1. `requireOrgMembership(orgId)` first — throws `AuthorizationError` on no-session or non-member; the wrapping try/catch maps to `errFromUnknown`.
2. Mutation through user JWT — no service-role bypass; RLS enforces isolation.
3. `revalidatePath('/properties')` on success.
4. `Result<T>` with kind-specific failure code: `CREATE_FILTER_FAILED` / `UPDATE_FILTER_FAILED` / `DELETE_FILTER_FAILED` / `TOGGLE_PIN_FAILED`.

Inserts hardcode `is_base: false` and `starred: false`. The action ignores any client-provided `user_id` and resolves it from `requireOrgMembership` so the RLS with-check policy `user_id = auth.uid()` is always satisfied.

## RLS Isolation Test Coverage (10 tests)

| Suite | Tests |
|-------|-------|
| `createSavedFilter` | success path; non-member rejected (AuthorizationError); empty name rejected; bad filters_json shape rejected |
| `updateSavedFilter` | user A cannot update user B's preset (RLS USING denial → 0 rows → action error); user can update their own |
| `deleteSavedFilter` | user A cannot delete user B's preset; B's row stays intact |
| `togglePinSavedFilter` | own preset star/unstar round-trip; cannot star a base preset (NULL user_id); cannot star another user's preset |

**Verifications:**

- User A in BMH cannot mutate user B's preset (RLS write_own enforces).
- A user with no membership in BMH gets `AuthorizationError` from `requireOrgMembership` — the action never reaches the DB.
- Base presets (seeded by migration 055, `user_id IS NULL`) cannot be starred-by-user — the write_own RLS policy requires `user_id = auth.uid()` and there's no match against NULL.
- The validation gates (empty name / bad filters_json shape) fire before `requireOrgMembership` so client-side errors are deterministic and don't surface as auth failures.

**Mock pattern:** `vi.mock("@/lib/supabase/server")` swaps the action's `createClient()` for a per-user `clientForUser(jwt)` so `auth.getUser()` inside `requireOrgMembership` returns the correct user for each test. `vi.mock("next/cache")` stubs `revalidatePath` (server actions can't reach Next.js's static-generation store outside a request scope; same pattern as `leads/actions.test.ts`).

## Known Constraint: Base Presets Cannot Be Starred-by-User

The write_own RLS policy on `saved_filters` requires `user_id = auth.uid()`. Base presets (seeded by migration 055) have `user_id = NULL`, so a user-issued UPDATE silently filters them out (zero rows affected → action returns `TOGGLE_PIN_FAILED`).

**This is expected and matches SPEC §5:** base presets always show in the Quick Filters bar regardless of starred state. Per-user star/unstar only applies to the user's own custom presets. The "user cannot star a base preset" test in the integration suite asserts this behavior.

If a future spec wants per-user pinning of base presets, the model would need a separate `user_starred_base_filters` join table — out of scope for v1.

## Authoritative orgId

All five actions take `orgId` as input. The authoritative source for downstream callers:

- **Page render context** (Plan 09): the `/properties` page server component resolves the user's primary org via `getCurrentMemberships()` and passes it down through props/context to client components.
- **Client components** (Plans 06–08): drawer / Quick Filters bar / star toggle receive `orgId` as a prop and pass it into each action call. Never hard-coded; never read from URL or local state.

## Deviations from Plan

### `[Rule 3 - Blocking issue] Created applyFilters shim in src/lib/prospects/filter-to-supabase.ts`

- **Found during:** Task 1
- **Issue:** Plan 04 (which owns `src/lib/prospects/filter-to-supabase.ts` and exports `applyFilters`) is running in a parallel worktree (`/Users/jarradhenry/Sites/Sandra-20260507-212042-05-04-translator`) and has not yet committed. Plan 05's `count.ts` imports `applyFilters` from this module. Without the file, this branch fails typecheck (`Cannot find module '@/lib/prospects/filter-to-supabase'`) and the pre-commit hook blocks every commit.
- **Fix:** Wrote a minimal sync no-op shim (`applyFilters<TBuilder>(builder, _blocks, _sb): TBuilder { return builder; }`) with a NOTICE comment that Plan 05-04 owns the file and replaces it on merge. The sync return shape (rather than `Promise<TBuilder>`) was a deliberate choice: returning a Promise causes TS to infer `TBuilder` as the supabase builder's resolved response shape (PromiseLike await leak), breaking downstream `.eq()` / `.is()` chaining on the count query.
- **Files modified:** `src/lib/prospects/filter-to-supabase.ts` (new file, 47 lines)
- **Commit:** `b3a016e`
- **Merge note for orchestrator:** when Plans 04 and 05 land together, expect a conflict in `src/lib/prospects/filter-to-supabase.ts`. Plan 04's full implementation wins. Plan 05's count action remains correct because `applyFilters` is called the same way regardless of implementation depth; if Plan 04's real `applyFilters` is async, the count action needs `q = await applyFilters(...)`. Confirm at merge time.

### `[Rule 1 - Bug] Result.data vs Result.value`

- **Found during:** Task 2
- **Issue:** The plan file's example code uses `result.value.id` and `value: T` for the success branch of `Result<T>`. The canonical `src/lib/errors/result.ts` exports `{ ok: true, data: T }` (the `data` field, not `value`). Following the plan example would have resulted in a typecheck failure.
- **Fix:** Used `data` throughout the action implementations and the integration test assertions (`result.data.id`, `result.data.starred`, etc.).
- **Files modified:** `saved-filters.ts`, `saved-filters.integration.test.ts`
- **Commit:** `452b490`, `e38d47f`

### `[Rule 3 - Blocking issue] Stub revalidatePath in integration test`

- **Found during:** Task 3 (first test run)
- **Issue:** `revalidatePath('/properties')` throws `Invariant: static generation store missing` when called outside a Next.js request scope (i.e., when invoking server actions directly from vitest). All createSavedFilter calls in the test were failing at that step.
- **Fix:** Added `vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))` — same pattern used by `src/app/(dashboard)/leads/actions.test.ts`.
- **Files modified:** `saved-filters.integration.test.ts`
- **Commit:** `e38d47f`

### `[Rule 1 - Bug] update/delete patch + count handling`

- **Found during:** Task 2 (typecheck)
- **Issue:** The plan example used `.update(patch).select("id", { count: "exact" })` and read `count` to detect 0-row updates (RLS denial). With Sandra's typed supabase client, `Record<string, unknown>` for `patch` is rejected by TypeScript because the typed Update shape uses excess-property checks. Also, `count` from a non-`head: true` select isn't always reliable; the existing pattern in the codebase reads `data.length` instead.
- **Fix:**
  - Typed `patch` as `{ name?: string; filters_json?: FilterState }`.
  - Detected 0-row mutations via `!data || data.length === 0` instead of `count === 0`.
- **Files modified:** `saved-filters.ts`
- **Commit:** `452b490`

## Test Counts

- **Pre-commit (RTL + unit):** 20 test files / 159 tests passed on every commit
- **Integration suite (this plan's only addition):** 10 / 10 passed against live test Supabase
- **Typecheck:** clean across all 3 commits

## Self-Check: PASSED

- `src/app/(dashboard)/properties/_actions/count.ts` — FOUND
- `src/app/(dashboard)/properties/_actions/saved-filters.ts` — FOUND
- `src/app/(dashboard)/properties/_actions/saved-filters.integration.test.ts` — FOUND
- `src/lib/prospects/filter-to-supabase.ts` — FOUND (shim — see deviation note)
- Commit `b3a016e` — FOUND
- Commit `452b490` — FOUND
- Commit `e38d47f` — FOUND
