-- 043_counties_add_fips_and_drop_market_check.sql
--
-- Phase 02 — Market Vocabulary Refactor (per CONTEXT.md D-01, D-04, D-05).
--
-- 1. Drop the CHECK constraints on counties.market AND properties.market that
--    lock both columns to the four legacy city names. Per D-01, the counties
--    table becomes the single source of truth for valid markets — no DB-level
--    enum is reintroduced. Validation moves to the application layer.
-- 2. Add counties.fips_code text column + partial unique index so migration 045
--    can JOIN properties.fips_code → counties.fips_code → counties.id.
-- 3. Add csv_imports.county_id uuid FK so the import worker can recover the
--    selected county_id from the persisted import row inside processIngestChunk
--    (per D-04, properties.market + properties.county_id are written together
--    at every write site, including the async CSV import path). The job-create
--    server action sets this column; the worker reads it from the csv_imports
--    row rather than threading it through the workflow payload.
--
-- Per project memory feedback_migrations_only_via_ci.md: applied via
-- .github/workflows/db-migrate.yml on merge to main, to BOTH
--   - prod (copflsklaefwzipsrjqz)
--   - test (ncsngxlcyxylaeskiteu)
-- Never run `supabase db push` locally against prod, never use MCP apply_migration.

begin;

-- 1. Drop the CHECK constraint on counties.market.
--    Constraint name follows the Postgres auto-name convention
--    {table}_{column}_check (matches every other CHECK in this codebase, e.g.
--    properties_source_check in migration 030, properties_status_check in 004,
--    job_items_error_class_check in 029).
--    Use `if exists` so the migration is idempotent against either DB regardless
--    of whether 043 has previously partially landed.
alter table counties
  drop constraint if exists counties_market_check;

-- 2. Drop the CHECK constraint on properties.market.
--    This is the constraint that would otherwise reject the 045 backfill UPDATE
--    when it sets properties.market to county-shaped strings.
alter table properties
  drop constraint if exists properties_market_check;

-- 3. Add counties.fips_code text column (nullable; populated by 044 seed).
--    No CHECK constraint per D-01 — counties is now the source of truth.
alter table counties
  add column if not exists fips_code text;

-- 4. Partial unique index on counties.fips_code where not null.
--    Ensures the 045 UPDATE...FROM JOIN sees at-most-one county per fips_code.
--    Pattern: 001_initial.sql:65-67 (contacts_phone_1_key).
create unique index if not exists counties_fips_code_unique
  on counties (fips_code)
  where fips_code is not null;

-- 5. Add csv_imports.county_id uuid column with FK to counties(id).
--    ON DELETE SET NULL: deleting a county must not cascade-delete a historical
--    import audit row. The market text cache on csv_imports is preserved either
--    way; only the FK pointer is nulled.
--
--    The job-create server action (src/app/(dashboard)/import/actions.ts ::
--    createImportJob) writes this column at the same time it writes the
--    csv_imports row. The async worker (src/lib/csv/ingest.ts ::
--    processIngestChunk → ingestRow) reads it back from the row before
--    inserting into properties, so properties.market + properties.county_id
--    land together on every CSV-imported row.
alter table csv_imports
  add column if not exists county_id uuid
  references counties(id) on delete set null;

commit;
