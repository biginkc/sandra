-- Bounded, metadata-only P0 evidence. Run with psql -X -v ON_ERROR_STOP=1.
-- Uses the caller's configured PG connection. Never embed a connection secret.
-- No application RPC, customer row/body, ANALYZE, or EXPLAIN ANALYZE is run.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';

SELECT current_setting('server_version') AS postgres_version,
       current_setting('transaction_read_only') AS read_only;

SELECT relname, n_live_tup AS estimated_rows, n_dead_tup AS estimated_dead_rows,
       last_analyze, last_autoanalyze,
       pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables
WHERE schemaname = 'public'
  AND relname IN ('messages', 'properties', 'contacts', 'lead_events',
                  'ai_disposition_reviews', 'jobs', 'job_items')
ORDER BY relname;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('messages', 'properties', 'contacts',
                    'ai_disposition_reviews', 'jobs', 'job_items')
ORDER BY tablename, indexname;

-- Function body is hashed rather than exported: definitions may contain
-- operational details. Compare hashes with an isolated migrated baseline.
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer, md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname LIKE 'sms_inbox%'
       OR p.proname LIKE '%conversation%org%')
ORDER BY p.proname, arguments;

ROLLBACK;
