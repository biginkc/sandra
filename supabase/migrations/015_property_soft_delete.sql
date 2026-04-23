-- ============================================================================
-- Feature 4 bulk actions — soft-delete on properties (migration 015)
--
-- The /properties Actions dropdown now supports bulk delete. Hard delete
-- is a footgun (VA picks the wrong 500 rows, irrecoverable); soft delete
-- keeps the row in the DB so admins can recover and we preserve the
-- relational integrity for any messages / consent history attached.
--
-- Every working surface (/properties, /leads kanban, kanban card queries)
-- filters `deleted_at is null`. The partial index matches that filter so
-- queries stay fast.
-- ============================================================================

alter table properties add column deleted_at timestamptz;

-- Partial index — every production query for active rows will filter
-- `deleted_at is null`, so this index covers those paths without paying
-- to store the deleted rows (which are rare).
create index idx_properties_active
  on properties (created_at desc)
  where deleted_at is null;
