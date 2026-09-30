\set ON_ERROR_STOP on
-- Reviewed production teardown/restore packet. Stop Electric first and supply
-- the exact inactive slot named in its provenance receipt. This packet drops
-- only that slot, the one-table publication, and the reviewed role authority.
\if :{?project_ref}
\else
  \echo 'project_ref is required'
  \quit 3
\endif
\if :{?connection_project_ref}
\else
  \echo 'connection_project_ref is required'
  \quit 3
\endif
\if :{?prior_replica_identity}
\else
  \echo 'prior_replica_identity is required'
  \quit 3
\endif
\if :{?prior_replica_identity_index}
\else
  \echo 'prior_replica_identity_index is required; pass an empty value when the receipt has no index'
  \quit 3
\endif
\if :{?replication_slot_name}
\else
  \echo 'replication_slot_name is required'
  \quit 3
\endif

SELECT set_config('sandra.inbox_project_ref', :'project_ref', false) AS _set_project_ref \gset
SELECT set_config('sandra.inbox_connection_project_ref', :'connection_project_ref', false) AS _set_connection_project_ref \gset
SELECT set_config('sandra.inbox_prior_replica_identity', :'prior_replica_identity', false) AS _set_prior_replica_identity \gset
SELECT set_config('sandra.inbox_prior_replica_identity_index', :'prior_replica_identity_index', false) AS _set_prior_replica_identity_index \gset
SELECT set_config('sandra.inbox_replication_slot_name', :'replication_slot_name', false) AS _set_replication_slot_name \gset

DO $$
DECLARE
  supplied_ref text := current_setting('sandra.inbox_project_ref');
  connected_ref text := current_setting('sandra.inbox_connection_project_ref');
  prior_identity text := current_setting('sandra.inbox_prior_replica_identity');
  prior_index text := coalesce(nullif(current_setting('sandra.inbox_prior_replica_identity_index'), ''), '');
  requested_slot_name text := current_setting('sandra.inbox_replication_slot_name');
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'production Electric teardown must run in database postgres';
  END IF;
  IF connected_ref NOT IN ('ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz') THEN
    RAISE EXCEPTION 'connected database has an unapproved project ref';
  END IF;
  IF supplied_ref <> connected_ref THEN
    RAISE EXCEPTION 'operator project ref does not match the connected database';
  END IF;
  IF supplied_ref NOT IN ('ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz') THEN
    RAISE EXCEPTION 'production Electric teardown has an unapproved project ref';
  END IF;
  IF prior_identity NOT IN ('d', 'n', 'f', 'i') THEN
    RAISE EXCEPTION 'replica identity receipt is invalid';
  END IF;
  IF requested_slot_name !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'replication slot receipt is invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_replication_slots AS replication_slot
    WHERE replication_slot.slot_name = requested_slot_name
  ) THEN
    RAISE EXCEPTION 'expected Electric replication slot is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_replication_slots AS replication_slot
    WHERE replication_slot.slot_name = requested_slot_name AND replication_slot.active
  ) THEN
    RAISE EXCEPTION 'Electric replication slot is active; stop Electric before teardown';
  END IF;
  IF prior_identity = 'i' AND NOT EXISTS (
    SELECT 1
    FROM pg_class table_class
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_index restored_index ON restored_index.indrelid = table_class.oid
    JOIN pg_class index_class ON index_class.oid = restored_index.indexrelid
    WHERE table_namespace.nspname = 'inbox_bridge'
      AND table_class.relname = 'summaries'
      AND restored_index.indisunique
      AND restored_index.indpred IS NULL
      AND restored_index.indexprs IS NULL
      AND index_class.relname = prior_index
  ) THEN
    RAISE EXCEPTION 'replica identity index receipt does not match inbox_bridge.summaries';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_inbox') THEN
    RAISE EXCEPTION 'expected Electric publication is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox'
      AND (schemaname <> 'inbox_bridge' OR tablename <> 'summaries')
  ) THEN
    RAISE EXCEPTION 'refusing to drop a publication with an unexpected table';
  END IF;
END $$;

BEGIN;
SELECT pg_drop_replication_slot(current_setting('sandra.inbox_replication_slot_name'));
DROP PUBLICATION electric_publication_inbox;
ALTER ROLE inbox_electric_replication NOLOGIN NOREPLICATION NOBYPASSRLS;
DO $$
DECLARE
  prior_identity text := current_setting('sandra.inbox_prior_replica_identity');
  prior_index text := current_setting('sandra.inbox_prior_replica_identity_index');
BEGIN
  IF prior_identity = 'd' THEN
    ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY DEFAULT;
  ELSIF prior_identity = 'n' THEN
    ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY NOTHING;
  ELSIF prior_identity = 'f' THEN
    ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;
  ELSIF prior_identity = 'i' THEN
    EXECUTE format('ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX %I', prior_index);
  ELSE
    RAISE EXCEPTION 'unsupported replica identity receipt';
  END IF;
END $$;
COMMIT;

SELECT json_build_object(
  'project_ref', current_setting('sandra.inbox_project_ref'),
  'database', current_database(),
  'replication_slot_dropped', true,
  'publication_dropped', true,
  'role_login', false,
  'restored_replica_identity', current_setting('sandra.inbox_prior_replica_identity'),
  'restored_replica_identity_index', nullif(current_setting('sandra.inbox_prior_replica_identity_index'), '')
)::text AS electric_teardown_receipt;
