# 05-03 SUMMARY — schema-push checkpoint

**Status:** ✅ closed
**Date:** 2026-05-07/08

## What this plan did

Plan 03 was the [BLOCKING] schema-push checkpoint for migration 055 (`saved_filters` + RLS + base preset seed). It coordinated:

1. The Wave 1 PR landing on `main`
2. CI's `db-migrate.yml` applying migration 055 to both Supabase projects
3. Type regeneration so downstream Wave 2+ work compiles against the live schema
4. Verifying the multi-user RLS integration test from Plan 02 goes green

## Verification

| Step | Result |
|------|--------|
| PR #137 merged to main | commit `980e3d2` (squash) |
| `db-migrate.yml` applied 055 to test (`ncsngxlcyxylaeskiteu`) | ✅ ([run #25532269811](https://github.com/biginkc/sandra/actions/runs/25532269811/job/74940867011), 9 sec, all 7 steps green) |
| `db-migrate.yml` applied 055 to prod (`copflsklaefwzipsrjqz`) | ✅ ([run #25532269811](https://github.com/biginkc/sandra/actions/runs/25532269811/job/74940867012), 13 sec, all 7 steps green) |
| Types regenerated via Supabase MCP | ✅ `src/lib/supabase/types.ts` 1999 → 2084 lines; `saved_filters` Row/Insert/Update types present |
| `npm run typecheck` | ✅ exits 0 |
| `npm run test:integration -- --run supabase/migrations/055_saved_filters.integration.test.ts` | ✅ 9/9 green (after the 056 fix, see below) |

## Latent Stage 1 bug surfaced + fixed inline

The first integration test run after migration 055 landed produced 4 passes / 5 fails with `code: 42P17 — infinite recursion detected in policy for relation "memberships"`.

**Root cause:** migration 054 (`memberships_owner_select` + `memberships_owner_write`) used recursive `org_id IN (SELECT m.org_id FROM memberships m WHERE m.user_id = auth.uid() AND m.role = 'owner')` predicates. Postgres handles direct queries against memberships fine (short-circuit), but when ANOTHER table's RLS policy queries memberships in a subquery, evaluation recurses through memberships' own RLS → owner subquery → memberships' RLS → ∞.

This was latent until Plan 02's `saved_filters_read_own_plus_base` policy introduced exactly that pattern. Phase 04's worktree would have hit the same wall the moment it shipped `user_oauth_tokens` + `user_integration_prefs`.

**Fix:** PR #138 (commit landed as `d111d5f`) drops both recursive policies via `056_fix_membership_recursion.sql`. `memberships_self_select` (`user_id = auth.uid()`) remains as the only authenticated-side access. Service role continues to manage memberships via the `inviteUser` action (already RLS-bypass).

After 056 applied via `db-migrate.yml`, the integration test goes 9/9 green.

## What's next

Wave 1 is fully closed. Wave 2 (Plans 04 + 05) unblocks now — they'll run in parallel worktrees.

- Plan 04: filter-to-Supabase translator + back-compat URL shim
- Plan 05: server actions (count + saved-filters CRUD) + multi-user RLS integration test (which uses the same fixture pattern as Plan 02's test, now proven working)

Plan 04 Task 0's `equity_pct` decision will surface mid-Wave-2; default-on-`walk` lands Option A2 (separate migration 057_equity_pct_cached.sql) because 055 has already shipped.

## Files committed (in this worktree, post-checkpoint)

- `src/lib/supabase/types.ts` — regenerated from live prod schema
- `.planning/phases/05-prospects-filter-drawer/05-03-SUMMARY.md` — this file
