-- Read-only counters: no customer content, credentials, query literals, or writes.
-- Compare deltas only when stats_since and all statement identity fields match.
select jsonb_build_object(
  'captured_at', clock_timestamp(),
  'server_version', current_setting('server_version'),
  'work_mem', current_setting('work_mem'),
  'io_timing_enabled', current_setting('track_io_timing'),
  'inbox_statements', (
    select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
    from (
      select dbid::text, userid::text, queryid::text, toplevel, stats_since,
        calls, total_exec_time, mean_exec_time, max_exec_time,
        shared_blks_hit, shared_blks_read, temp_blks_read, temp_blks_written
      from extensions.pg_stat_statements
      where query like 'WITH pgrst_source AS%'
        and query like '%sms_inbox_thread_page_snapshot%'
    ) s
  ),
  'tables', (
    select jsonb_agg(to_jsonb(t)) from (
      select relname, n_live_tup, n_dead_tup, n_mod_since_analyze,
        last_autoanalyze, last_analyze, last_autovacuum, last_vacuum
      from pg_stat_user_tables
      where schemaname = 'public' and relname in (
        'messages', 'message_threads', 'contacts', 'properties',
        'consent_events', 'sms_phone_suppressions'
      )
    ) t
  ),
  'connection_states', (
    select jsonb_agg(to_jsonb(a)) from (
      select state, wait_event_type, count(*) as connections
      from pg_stat_activity where datname = current_database()
      group by state, wait_event_type
    ) a
  )
) as latency_snapshot;
