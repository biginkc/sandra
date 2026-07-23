-- ============================================================================
-- Stage 1 fix — drop recursive memberships policies
--
-- Migration 054 created two policies on public.memberships whose USING / WITH
-- CHECK clauses query public.memberships themselves:
--
--   memberships_owner_select:
--     using (org_id in (
--       select m.org_id from public.memberships m
--       where m.user_id = auth.uid() and m.role = 'owner'
--     ))
--
--   memberships_owner_write:
--     same recursive subquery in both USING and WITH CHECK
--
-- These policies don't recurse on direct queries (Postgres short-circuits when
-- the subquery is the same table the policy is FOR). They DO recurse when
-- another table's RLS policy queries memberships in a subquery — Postgres
-- engages memberships' RLS, which evaluates the recursive owner subquery,
-- which engages memberships' RLS again, which... ∞.
--
-- This was latent until Phase 05's saved_filters_read_own_plus_base policy
-- introduced `org_id in (select m.org_id from memberships m where ...)`,
-- producing `code: 42P17 — infinite recursion detected in policy for relation
-- "memberships"`.
--
-- Phase 04's user_oauth_tokens and user_integration_prefs will hit the same
-- wall when they ship — they need the same membership-scoped predicate from
-- foreign-table RLS.
--
-- Fix: drop the recursive policies. memberships_self_select (`user_id =
-- auth.uid()`) remains and is sufficient for v1 — there is no admin UI for
-- org-member management yet. Service role (grantUserAccess action) bypasses RLS
-- and continues to manage membership rows. If/when an org-admin UI lands,
-- replace these with SECURITY DEFINER functions, not recursive subqueries.
--
-- CI-only: applied by .github/workflows/db-migrate.yml after merge.
-- ============================================================================

begin;

drop policy if exists memberships_owner_select on public.memberships;
drop policy if exists memberships_owner_write on public.memberships;

-- memberships_self_select stays (created in migration 054):
--   for select to authenticated using (user_id = auth.uid())
-- That's the only authenticated-side access. Service role does the rest.

commit;
