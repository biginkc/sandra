-- Precondition query for enabling Inbox serving.
--
-- Asserts all 8 canonical concurrent indexes (concurrent-indexes.sql) exist
-- AND are valid (pg_index.indisvalid = true). A CREATE INDEX CONCURRENTLY
-- that was interrupted mid-build leaves an INVALID index behind instead of
-- failing loudly — Postgres will not error on that index existing, it will
-- just silently not be used by the planner and will block a same-named
-- rebuild. Enablement of inbox_control.rollout.serving_enabled must refuse
-- to proceed unless this query returns exactly 8 rows, all valid=true.
--
-- Usage: run this and confirm `all_valid` = true and `found` = 8 before
-- flipping serving_enabled. This performs no writes.

SELECT
    c.relname AS index_name,
    i.indisvalid AS valid,
    count(*) OVER () AS found,
    bool_and(i.indisvalid) OVER () AS all_valid
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN (
    'inbox_parent_message_property',
    'inbox_parent_message_contact',
    'inbox_parent_review_property',
    'inbox_backfill_messages',
    'inbox_backfill_reviews',
    'inbox_backfill_threads',
    'inbox_backfill_thread_identity',
    'inbox_unknown_history_page'
)
ORDER BY c.relname;

-- Expected result before enabling serving: 8 rows, every `valid` = true,
-- `found` = 8 on every row, `all_valid` = true on every row. Any row
-- missing (fewer than 8 total) or any valid = false means DO NOT enable
-- serving — rebuild the missing/invalid index (DROP INDEX CONCURRENTLY
-- IF EXISTS <name>; then re-run the corresponding CREATE INDEX CONCURRENTLY
-- IF NOT EXISTS statement from concurrent-indexes.sql) and re-check.
