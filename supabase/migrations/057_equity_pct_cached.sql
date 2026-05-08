-- ============================================================================
-- Phase 05 — Prospects Filter Drawer: equity_pct generated column
--
-- Adds a stored generated column `properties.equity_pct` so the Equity %
-- filter block (locked SPEC §41-46 v1; powers the High Equity base preset
-- seeded in migration 055) can produce SQL-accurate counts via an indexed
-- `.gte / .lte` predicate, with no JS post-fetch and no broken Active
-- Filters / Quick Filters bar counts.
--
-- This migration is the "Option A2" cascade from Plan 05-04 Task 0:
-- Plan 02's saved_filters migration (055) had already merged + been applied
-- to prod + test by the time Plan 04 started, so amending 055 in place
-- (Option A1) was unavailable. A new follow-up migration is the safe path.
-- The originally proposed 056 slot was claimed by 056_fix_membership_recursion;
-- this lands at 057.
--
-- Derivation:
--   equity_pct = (equity_estimate * 100.0) / NULLIF(arv, 0)
--
--   - properties.equity_estimate is the seller's residual equity in dollars.
--   - properties.arv is the after-repair value used as the percentage base.
--   - NULLIF on arv returns NULL when arv = 0, which propagates to the
--     generated column → Postgres skips the row in the partial index and
--     `.gte / .lte` predicates evaluate to UNKNOWN (correctly excluded).
--   - When equity_estimate is NULL the column is NULL too.
--
-- The High Equity base preset (`{ kind: "equity_pct", range: { min: 50 } }`,
-- seeded in migration 055) requires this column to exist; once 057 lands,
-- that preset returns accurate counts at the SQL layer.
--
-- CI-only: applied by .github/workflows/db-migrate.yml after merge to main.
-- The same workflow runs against both prod (copflsklaefwzipsrjqz) and test
-- (ncsngxlcyxylaeskiteu) Supabase projects.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Stored generated column
-- ----------------------------------------------------------------------------
-- Postgres 12+ supports STORED generated columns. Supabase runs PG 15.x, so
-- the canonical form is fine here — no trigger fallback required.
alter table public.properties
  add column if not exists equity_pct numeric
    generated always as ((equity_estimate * 100.0) / nullif(arv, 0)) stored;

comment on column public.properties.equity_pct is
  'Stored generated column: (equity_estimate * 100.0) / NULLIF(arv, 0). '
  'Powers the Equity % filter block + High Equity base preset (Phase 05). '
  'NULL when equity_estimate is NULL or arv is 0/NULL.';

-- ----------------------------------------------------------------------------
-- 2. Partial index for the filter predicate
-- ----------------------------------------------------------------------------
-- Mirrors `idx_properties_active` (deleted_at IS NULL) so prospect-page
-- queries only scan the live partition. Keeps the index small — only rows
-- with a valid equity_pct AND not soft-deleted live in the index.
create index if not exists idx_properties_equity_pct
  on public.properties (equity_pct)
  where deleted_at is null and equity_pct is not null;

commit;
