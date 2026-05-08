---
phase: 05-prospects-filter-drawer
plan: 02
subsystem: persistence
tags: [migration, rls, supabase, saved-filters, base-presets, integration-test]
requires:
  - migration 054 (memberships + RLS rewrite) — for the `memberships` table the read policy joins to
  - filter-schema.ts (Plan 01) — base presets' filters_json conform to v1 FilterBlock discriminated union
provides:
  - public.saved_filters table (11 columns)
  - 3 indexes (user_starred_name, org_base, base_unique partial)
  - 5 RLS policies (read_own_plus_base, insert_own, update_own, delete_own, service_all)
  - 5 idempotent base preset rows for BMH org (Stacked / Vacant / Engaged / Cold / High Equity)
  - updated_at trigger
  - integration test (9 `it()` cases) covering the full RLS + idempotency surface
affects:
  - src/lib/supabase/types.ts — needs regeneration after CI applies the migration (next plan in the phase will pick this up; until then `as never` casts in the test cover the gap)
tech-stack:
  added: []
  patterns:
    - Postgres RLS membership-scoped policies (mirrors migration 054 verbatim)
    - Partial unique index for ON CONFLICT seed idempotency
    - `@tests/` path alias for integration test imports
key-files:
  created:
    - supabase/migrations/055_saved_filters.sql
    - supabase/migrations/055_saved_filters.integration.test.ts
  modified: []
decisions:
  - "Migration slot: 055 (next free at write-time; 054 was the highest existing)"
  - "equity_pct column NOT added in this migration — deferred to Plan 04 Task 0 per plan gotcha"
  - "filters_json shapes for the 5 base presets are stable string ids (`base-{name}-...-v1`) not random UUIDs, so the SQL is byte-stable across re-runs"
  - "Test casts `.from('saved_filters' as never)` because Supabase types.ts won't include the table until CI regenerates after the migration lands — same pattern migration 054's integration test uses for the freshly-created `memberships` table"
metrics:
  duration: "~3 minutes (executor session — files were already drafted in prior worktree state; this session verified, fixed the typecheck blocker on the test, ran full verify, and committed)"
  completed: "2026-05-08T01:42:19Z"
  tasks: 2
  commits: 2
  files_created: 2
  files_modified: 0
---

# Phase 5 Plan 2: saved_filters migration + RLS + 5 base presets Summary

**One-liner:** Migration 055 ships the `saved_filters` table with 5 RLS policies that mirror the Stage 1 membership pattern verbatim, plus an idempotent ON-CONFLICT seed of the 5 base preset chips (Stacked / Vacant / Engaged / Cold / High Equity) for BMH Group, plus a 9-case integration test that proves multi-user isolation, base visibility, cross-org silence, write/update/delete enforcement, and seed idempotency.

## What shipped

### `supabase/migrations/055_saved_filters.sql` (152 lines)

- **Table** `public.saved_filters` with 11 columns per SPEC R7: `id` (uuid pk default `gen_random_uuid()`), `org_id` (FK organizations, ON DELETE CASCADE), `user_id` (FK auth.users, NULL for base presets, ON DELETE CASCADE), `name`, `filters_json` (jsonb), `starred` (bool default false), `is_base` (bool default false), `last_run_at` (timestamptz), `last_count` (int), `created_at`, `updated_at`.
- **3 indexes:**
  - `idx_saved_filters_user_starred_name` on `(user_id, starred desc, name) WHERE user_id IS NOT NULL` — Quick Filters bar query path.
  - `idx_saved_filters_org_base` on `(org_id, is_base) WHERE is_base = true` — base preset lookup path.
  - `idx_saved_filters_base_unique` partial UNIQUE on `(org_id, name) WHERE is_base = true` — backs the seed `ON CONFLICT` target.
- **`updated_at` trigger** — `saved_filters_set_updated_at()` plpgsql function + BEFORE UPDATE FOR EACH ROW trigger.
- **5 RLS policies** (matching SPEC R7 line 71-74 verbatim):
  - `saved_filters_read_own_plus_base` (SELECT, authenticated): `user_id = auth.uid() OR (is_base = true AND org_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = auth.uid()))`.
  - `saved_filters_insert_own` (INSERT, authenticated): WITH CHECK `user_id = auth.uid()`.
  - `saved_filters_update_own` (UPDATE, authenticated): USING + WITH CHECK `user_id = auth.uid()`.
  - `saved_filters_delete_own` (DELETE, authenticated): USING `user_id = auth.uid()`.
  - `saved_filters_service_all` (ALL, service_role): `true` / `true` — completes the seed step + admin tooling, mirrors the service-role policy on `skip_trace_cache` and other tables.
- **Idempotent seed** for BMH Group org (`00000000-0000-0000-0000-000000000bbb`):
  ```
  INSERT INTO public.saved_filters (org_id, user_id, name, filters_json, is_base) VALUES
    (..., NULL, 'Stacked',     {v:1, blocks:[{id:'base-stacked-list-count-v1',     kind:'list_count',  range:{min:2,  max:null}}]}, true),
    (..., NULL, 'Vacant',      {v:1, blocks:[{id:'base-vacant-vacancy-v1',         kind:'vacancy',     tri:'yes'}]},                true),
    (..., NULL, 'Engaged',     {v:1, blocks:[{id:'base-engaged-engagement-v1',     kind:'engagement',  combinator:'any', values:['replied','attempted']}]},     true),
    (..., NULL, 'Cold',        {v:1, blocks:[{id:'base-cold-engagement-v1',        kind:'engagement',  combinator:'any', values:['never_contacted']}]},          true),
    (..., NULL, 'High Equity', {v:1, blocks:[{id:'base-highequity-equity-v1',      kind:'equity_pct',  range:{min:50, max:null}}]}, true)
  ON CONFLICT (org_id, name) WHERE is_base = true DO NOTHING;
  ```
  Re-running the migration is a no-op on these rows (the partial unique index forbids duplicates).

### `supabase/migrations/055_saved_filters.integration.test.ts` (297 lines, 9 cases)

Imports via the `@tests/` path alias (per migration 054's precedent — Sandra never uses relative `../../tests/` for the integration fixtures). Spawns 3 users via the multi-user fixture: `userA` + `userB` in BMH; `userC` in TEST_ORG_B. `afterAll` cleans up custom presets (base presets are migration-owned and stay) then deletes the auth users.

**Base preset seed assertions (3 cases):**
1. `seeds exactly 5 base presets for the BMH org` — names sort to `[Cold, Engaged, High Equity, Stacked, Vacant]`.
2. `base preset seed is idempotent (count stays at 5)` — `count(*) = 5`.
3. `base presets carry the v1 FilterBlock schema in filters_json` — every row has `v=1` and at least one block.

**RLS isolation assertions (6 cases):**
4. `user A cannot read user B's custom preset (read_own_plus_base scopes by user_id)` — A's `.select().eq('name', preset)` returns `[]` after B inserts.
5. `both users in the BMH org see the same 5 base presets` — A and B's queries both return the canonical 5 names.
6. `a user with no membership in BMH cannot read BMH base presets` — userC's `.select().eq('org_id', BMH).eq('is_base', true)` returns `[]`.
7. `user A cannot update user B's preset (write_own enforced)` — A's update affects 0 rows; B's view of the preset is intact.
8. `user A cannot delete user B's preset (write_own delete enforced)` — A's delete affects 0 rows; B's view of the preset is intact.
9. `user A cannot insert a preset with user_id pointing at user B (with check)` — explicit RLS error matching `/row-level security|violates row-level/i`.

## Decisions

- **Migration slot 055** — chosen because the highest existing migration was `054_memberships_and_rls_rewrite.sql` at write-time and Phase 04's parallel worktree had not committed any migrations yet. If both worktrees end up colliding at merge time, it's an easy renumber to 056 in a follow-up commit; the SQL is content-stable.
- **`equity_pct` column NOT included in this migration** — Plan 04 Task 0 owns the decision (Option A1 = add to 055; Option A2 = ship a separate 056). The High Equity preset's `filters_json` references the column name (`kind: "equity_pct"`), but the application-side translator (Plan 04) is what reads that block — the migration only persists the JSON literal. Plan 04 Task 0 will commit the column DDL once the user picks A1 vs A2.
- **`as never` cast for `.from("saved_filters")` in the test** — same precedent migration 054's integration test uses for the freshly-created `memberships` table. `src/lib/supabase/types.ts` is regenerated from the prod schema by the Supabase CLI; until CI applies migration 055 to test+prod and someone regenerates types.ts, `saved_filters` isn't in the `Database` type. Casting through `as never` keeps `npm run typecheck` green now and the cast is removable once types regenerate.
- **Stable string block ids in the seed** — `base-stacked-list-count-v1` etc., not `gen_random_uuid()`. Re-running the migration produces byte-identical JSON. ON CONFLICT key is `(org_id, name)` so the block ids only matter for client-side deep-equality preset detection (Plan's D-17), but stability also aids debugging in the DB shell.

## Five base preset filters_json values (for Plan 04 translator unit tests)

| Name        | filters_json                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| Stacked     | `{"v":1,"blocks":[{"id":"base-stacked-list-count-v1","kind":"list_count","range":{"min":2,"max":null}}]}`            |
| Vacant      | `{"v":1,"blocks":[{"id":"base-vacant-vacancy-v1","kind":"vacancy","tri":"yes"}]}`                                    |
| Engaged     | `{"v":1,"blocks":[{"id":"base-engaged-engagement-v1","kind":"engagement","combinator":"any","values":["replied","attempted"]}]}` |
| Cold        | `{"v":1,"blocks":[{"id":"base-cold-engagement-v1","kind":"engagement","combinator":"any","values":["never_contacted"]}]}` |
| High Equity | `{"v":1,"blocks":[{"id":"base-highequity-equity-v1","kind":"equity_pct","range":{"min":50,"max":null}}]}`            |

When Plan 04 writes the unit tests for `applyBlock` per kind, these five JSONs are the load-bearing fixtures: the translator must produce a non-error query for each.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npm run typecheck` failed because `saved_filters` is not in the generated `Database` type yet.**

- **Found during:** Task 2 verify (the pre-commit verify hook would have failed without this fix).
- **Issue:** `src/lib/supabase/types.ts` is regenerated from prod schema; the table is created BY this migration so it isn't in types until CI applies + types regenerate. Every `.from("saved_filters")` call produced a TS2769 "no overload matches" error.
- **Fix:** Cast each `.from("saved_filters")` through `as never` (same pattern migration 054's integration test uses for the freshly-created `memberships` table — see `054_memberships_and_rls_rewrite.integration.test.ts:233-249`). Also widened result types via `as Array<{ name: string }>` etc. so chained operations stay typed where they matter.
- **Files modified:** `supabase/migrations/055_saved_filters.integration.test.ts`.
- **Commit:** `970ba0a` (the same commit that created the test file — fix was applied before initial commit, not as a follow-up).

The cast pattern is removable in a follow-up plan once `npm run db:types` regenerates `src/lib/supabase/types.ts` after CI applies migration 055.

## Authentication gates

None — this plan is pure SQL DDL + a colocated TS integration test. No external service calls, no auth flows, no manual steps.

## Could not run

- **Integration test (`npm run test:integration`)** — was deliberately skipped per the plan: the test is RED until Plan 03's BLOCKING checkpoint clears CI's `db-migrate.yml` apply step against the test Supabase project. Running it now would produce false-RED noise. The pre-commit hook's `npm run verify` (typecheck + 727 unit tests + 159 RTL tests) was the strongest available local signal — all green.

## Test counts

| Suite                  | Count       | Status |
| ---------------------- | ----------- | ------ |
| typecheck              | full repo   | green  |
| unit (`vitest run`)    | 727 / 727   | green  |
| RTL (`vitest --rtl`)   | 159 / 159   | green  |
| integration (mig 055)  | 9 cases     | RED until CI applies (per plan) |
| Playwright e2e         | not in scope for this plan | n/a |

## Acceptance criteria checklist (from PLAN.md)

### Task 1 — Migration SQL (`supabase/migrations/055_saved_filters.sql`)

- [x] File exists at slot 055 (next free at write-time).
- [x] `create table if not exists public.saved_filters` × 1.
- [x] `create policy saved_filters_read_own_plus_base` × 1.
- [x] `create policy saved_filters_insert_own` × 1.
- [x] `create policy saved_filters_update_own` × 1.
- [x] `create policy saved_filters_delete_own` × 1.
- [x] `create policy saved_filters_service_all` × 1.
- [x] `idx_saved_filters_user_starred_name` × 1.
- [x] `idx_saved_filters_org_base` × 1.
- [x] `idx_saved_filters_base_unique` × 1 (partial unique).
- [x] `on conflict (org_id, name)` × 1.
- [x] All 5 preset names present: Stacked, Vacant, Engaged, Cold, High Equity.
- [x] BMH org id `00000000-0000-0000-0000-000000000bbb` × 5 (one per seed row).
- [N/A] `equity_pct` column DDL — Plan 04 Task 0 owns this decision; not in scope here.

### Task 2 — Integration test (`supabase/migrations/055_saved_filters.integration.test.ts`)

- [x] File exists.
- [x] Imports via `@tests/integration/fixtures/multi-user` alias.
- [x] Imports via `@tests/integration/client` alias.
- [x] Does NOT use relative `../../tests/...` for the fixture (0 occurrences).
- [x] `BMH_ORG_ID` referenced ≥ 3 times (13 occurrences).
- [x] `TEST_ORG_B_ID` referenced ≥ 1 time (2 occurrences).
- [x] `auth.admin.deleteUser` ≥ 1 (cleanup).
- [x] Test for base seed count.
- [x] Test for idempotency.
- [x] Test for "A cannot read B".
- [x] Test for "both users see base".
- [x] Test for "non-member sees zero".
- [x] Test for "A cannot update B".
- [x] (Bonus) Test for "A cannot delete B".
- [x] (Bonus) Test for "A cannot insert with user_id = B" (RLS with-check).
- [x] Test file is RED at this point — expected; clears after Plan 03 BLOCKING checkpoint.

## Known stubs

None. The migration is the persistence substrate; the application code that reads from it ships in later plans (the Quick Filters bar, the Filter Drawer, the count action). This plan does not ship UI or rendered components, so there's no risk of empty-data-flowing-to-UI stubs to flag.

## Threat flags

None. No new network endpoints, no new auth paths, no schema changes outside the locked-and-reviewed `saved_filters` surface. The RLS policies are line-for-line consistent with migration 054's pattern, which has its own threat-modeled review on `main`.

## Self-Check: PASSED

- [x] `supabase/migrations/055_saved_filters.sql` — exists (verified via `git ls-files`).
- [x] `supabase/migrations/055_saved_filters.integration.test.ts` — exists (verified via `git ls-files`).
- [x] Commit `ef78374` (Task 1 — migration .sql) — present in `git log`.
- [x] Commit `970ba0a` (Task 2 — integration test) — present in `git log`.
- [x] All 14 acceptance grep checks for Task 1 — pass.
- [x] All 9 acceptance criteria for Task 2 — pass (alias usage, ≥ 3 BMH refs, no relative path, etc.).
- [x] Pre-commit verify hook for the Task 2 commit — green (typecheck + 727 unit + 159 RTL).
- [x] No accidental file deletions in the Task 2 commit (`git diff --diff-filter=D HEAD~1 HEAD` returned empty).
