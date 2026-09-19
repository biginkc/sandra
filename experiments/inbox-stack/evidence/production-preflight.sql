-- Catalog/aggregate evidence only. Does not install, migrate, create, or scan customer rows.
-- Run with an already authorized connection; output must be reviewed before sharing.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '500ms';
SET LOCAL idle_in_transaction_session_timeout = '15s';
WITH wanted(name) AS (
 VALUES ('messages'),('properties'),('contacts'),('message_threads'),
 ('ai_disposition_reviews'),('consent_events'),('sms_phone_suppressions'),
 ('global_phone_dnc_registry'),('memberships'),
 ('inbox_conversation_summaries'),('inbox_unknown_summaries'),('inbox_projection_dirty'),
 ('inbox_entity_versions'),('inbox_operations'),('inbox_operation_items'),
 ('inbox_dispatch_outbox'),('inbox_send_attempts'),('inbox_saved_actions')
), relations AS (
 SELECT c.oid,c.relname,n.nspname,c.reltuples,c.relpages,c.relrowsecurity,c.relforcerowsecurity,c.relkind
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN wanted w ON w.name=c.relname
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
), relevant_roles AS (
 SELECT * FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','postgres',current_user)
 OR rolname LIKE 'electric%' OR rolname LIKE 'restate%'
), snapshot AS (
 SELECT clock_timestamp() AS sampled_at,pg_is_in_recovery() AS in_recovery,
 CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END AS wal_lsn
)
SELECT jsonb_build_object(
 'format','sandra-inbox-preflight-v1',
 'sample',jsonb_build_object('sampled_at',s.sampled_at,'database',current_database(),'reader',current_user,
   'server_version',current_setting('server_version'),'server_version_num',current_setting('server_version_num'),
   'in_recovery',s.in_recovery,'read_only',current_setting('transaction_read_only')),
 'settings',(SELECT jsonb_object_agg(name,setting) FROM pg_settings WHERE name IN
   ('wal_level','max_connections','superuser_reserved_connections','reserved_connections',
    'max_replication_slots','max_wal_senders','max_slot_wal_keep_size','wal_keep_size',
    'max_worker_processes','max_logical_replication_workers','shared_buffers','work_mem')),
 'connections',(SELECT jsonb_build_object('total_visible',count(*),'active_visible',count(*) FILTER(WHERE state='active'),
    'idle_visible',count(*) FILTER(WHERE state='idle'),'idle_in_transaction_visible',count(*) FILTER(WHERE state='idle in transaction'),
    'walsenders_visible',count(*) FILTER(WHERE backend_type='walsender')) FROM pg_stat_activity),
 'replication_slots',(SELECT coalesce(jsonb_agg(jsonb_build_object('slot_name',slot_name,'slot_type',slot_type,
    'plugin',plugin,'database',database,'active',active,'temporary',temporary,'wal_status',wal_status,
    'retained_bytes',CASE WHEN restart_lsn IS NOT NULL AND s.wal_lsn IS NOT NULL THEN pg_wal_lsn_diff(s.wal_lsn,restart_lsn) END,
    'unconfirmed_bytes',CASE WHEN confirmed_flush_lsn IS NOT NULL AND s.wal_lsn IS NOT NULL THEN pg_wal_lsn_diff(s.wal_lsn,confirmed_flush_lsn) END
    )),'[]'::jsonb) FROM pg_replication_slots),
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',r.nspname,'table',r.relname,'kind',r.relkind,
    'estimated_rows',r.reltuples,'estimated_pages',r.relpages,'total_bytes',pg_total_relation_size(r.oid),
    'heap_bytes',pg_relation_size(r.oid),'index_bytes',pg_indexes_size(r.oid),
    'rls_enabled',r.relrowsecurity,'rls_forced',r.relforcerowsecurity,
    'reader_can_select',has_table_privilege(r.oid,'SELECT'))),'[]'::jsonb) FROM relations r),
 'absent_expected_tables',(SELECT coalesce(jsonb_agg(w.name),'[]'::jsonb) FROM wanted w WHERE NOT EXISTS(SELECT 1 FROM relations r WHERE r.relname=w.name)),
 'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',r.nspname,'table',r.relname,'name',ic.relname,
    'valid',i.indisvalid,'ready',i.indisready,'unique',i.indisunique,'primary',i.indisprimary,'method',am.amname,
    'definition_hash_md5',md5(pg_get_indexdef(i.indexrelid)),
    'definition_when_no_expressions_or_predicate',CASE WHEN i.indexprs IS NULL AND i.indpred IS NULL THEN pg_get_indexdef(i.indexrelid) ELSE NULL END,
    'expression_hash_md5',CASE WHEN i.indexprs IS NOT NULL THEN md5(pg_get_expr(i.indexprs,i.indrelid)) END,
    'predicate_hash_md5',CASE WHEN i.indpred IS NOT NULL THEN md5(pg_get_expr(i.indpred,i.indrelid)) END
    )),'[]'::jsonb) FROM relations r JOIN pg_index i ON i.indrelid=r.oid JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',r.nspname,'table',r.relname,'name',t.tgname,
    'enabled_code',t.tgenabled,'internal',t.tgisinternal,'function_schema',pn.nspname,'function_name',p.proname,
    'function_identity_hash_md5',md5(pg_get_function_identity_arguments(p.oid)),
    'function_definition_hash_md5',md5(pg_get_functiondef(p.oid)),
    'trigger_definition_hash_md5',md5(pg_get_triggerdef(t.oid)),
    'security_definer',p.prosecdef)),'[]'::jsonb)
    FROM relations r JOIN pg_trigger t ON t.tgrelid=r.oid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace),
 'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',r.nspname,'table',r.relname,'name',p.polname,
    'command',p.polcmd,'permissive',p.polpermissive,
    'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END) FROM unnest(p.polroles) role_oid),
    'using_hash_md5',CASE WHEN p.polqual IS NOT NULL THEN md5(pg_get_expr(p.polqual,p.polrelid)) END,
    'check_hash_md5',CASE WHEN p.polwithcheck IS NOT NULL THEN md5(pg_get_expr(p.polwithcheck,p.polrelid)) END
    )),'[]'::jsonb) FROM relations r JOIN pg_policy p ON p.polrelid=r.oid),
 'roles',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'superuser',rolsuper,
    'replication',rolreplication,'bypass_rls',rolbypassrls,'connection_limit',rolconnlimit)),'[]'::jsonb) FROM relevant_roles),
 'role_memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),'admin_option',m.admin_option)),'[]'::jsonb)
    FROM pg_auth_members m WHERE m.roleid IN(SELECT oid FROM relevant_roles) OR m.member IN(SELECT oid FROM relevant_roles)),
 'publications',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.pubname,'all_tables',p.puballtables,
    'insert',p.pubinsert,'update',p.pubupdate,'delete',p.pubdelete,'truncate',p.pubtruncate,
    'relevant_tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',pt.schemaname,'table',pt.tablename)),'[]'::jsonb)
       FROM pg_publication_tables pt JOIN relations r ON r.nspname=pt.schemaname AND r.relname=pt.tablename WHERE pt.pubname=p.pubname))), '[]'::jsonb)
    FROM pg_publication p),
 'database_cumulative_stats',(SELECT jsonb_build_object('stats_reset',d.stats_reset,'transactions_committed',d.xact_commit,
    'transactions_rolled_back',d.xact_rollback,'tuples_inserted',d.tup_inserted,'tuples_updated',d.tup_updated,'tuples_deleted',d.tup_deleted,
    'temp_bytes',d.temp_bytes,'deadlocks',d.deadlocks,'blocks_read',d.blks_read,'blocks_hit',d.blks_hit) FROM pg_stat_database d WHERE d.datname=current_database()),
 'table_cumulative_stats',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',r.nspname,'table',r.relname,
    'inserts',t.n_tup_ins,'updates',t.n_tup_upd,'deletes',t.n_tup_del,'seq_scans',t.seq_scan,'index_scans',t.idx_scan,
    'estimated_live_rows',t.n_live_tup,'estimated_dead_rows',t.n_dead_tup,'last_analyze',t.last_analyze,'last_autoanalyze',t.last_autoanalyze,
    'last_vacuum',t.last_vacuum,'last_autovacuum',t.last_autovacuum)),'[]'::jsonb)
    FROM relations r JOIN pg_stat_user_tables t ON t.relid=r.oid),
 'interpretation','Catalog estimates and cumulative counters only. Missing/hidden values are not zero. Two independently committed samples plus unchanged reset markers are required for observed interval rates; no peak-per-second claim.'
) AS preflight
FROM snapshot s;
ROLLBACK;
