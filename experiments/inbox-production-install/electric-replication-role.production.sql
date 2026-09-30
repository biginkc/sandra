\set ON_ERROR_STOP on
-- Production Electric packet. Run only through
-- run-electric-replication-role.py. It reads a client-computed
-- SCRAM-SHA-256 verifier from stdin, writes the psql \set directives to the
-- same stdin stream, and includes this file with \i. Never pass a role
-- password in argv, -v, or as plaintext.
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
\if :{?electric_password}
\else
  \echo 'electric_password is required'
  \quit 3
\endif

SELECT set_config('sandra.inbox_project_ref', :'project_ref', false) AS _set_project_ref \gset
SELECT set_config('sandra.inbox_connection_project_ref', :'connection_project_ref', false) AS _set_connection_project_ref \gset
SELECT set_config('sandra.inbox_electric_verifier', :'electric_password', false) AS _set_electric_verifier \gset

DO $$
DECLARE
  supplied_ref text := current_setting('sandra.inbox_project_ref');
  connected_ref text := current_setting('sandra.inbox_connection_project_ref');
  verifier text := current_setting('sandra.inbox_electric_verifier');
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'production Electric packet must run in database postgres';
  END IF;
  IF connected_ref NOT IN ('ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz') THEN
    RAISE EXCEPTION 'connected database has an unapproved project ref';
  END IF;
  IF supplied_ref <> connected_ref THEN
    RAISE EXCEPTION 'operator project ref does not match the connected database';
  END IF;
  IF supplied_ref NOT IN ('ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz') THEN
    RAISE EXCEPTION 'production Electric packet has an unapproved project ref';
  END IF;
  IF verifier !~ '^SCRAM-SHA-256\$[1-9][0-9]{0,9}:[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}:[A-Za-z0-9+/]{43}$' THEN
    RAISE EXCEPTION 'electric_password must be a well-formed SCRAM-SHA-256 verifier';
  END IF;
  IF split_part(split_part(verifier, '$', 2), ':', 1)::bigint < 4096 THEN
    RAISE EXCEPTION 'electric_password SCRAM iteration count is too low';
  END IF;
  IF to_regclass('inbox_bridge.summaries') IS NULL THEN
    RAISE EXCEPTION 'inbox_bridge.summaries is not installed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'inbox_electric_replication'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolcanlogin
           OR rolreplication OR rolbypassrls OR NOT rolinherit
           OR rolconnlimit <> 4)
  ) THEN
    RAISE EXCEPTION 'existing Electric role has unexpected authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member
    WHERE r.rolname = 'inbox_electric_replication'
  ) THEN
    RAISE EXCEPTION 'Electric role must not inherit a role membership';
  END IF;
END $$;

-- Capture this row before the transaction changes replica identity. The
-- operator keeps it with the deployment receipt and supplies the two identity
-- fields to the reviewed teardown packet if restoration is later approved.
SELECT json_build_object(
  'project_ref', current_setting('sandra.inbox_project_ref'),
  'database', current_database(),
  'table', 'inbox_bridge.summaries',
  'prior_replica_identity', c.relreplident,
  'prior_replica_identity_index', identity_index.relname
)::text AS electric_preflight_receipt
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_index replica_index ON replica_index.indrelid = c.oid AND replica_index.indisreplident
LEFT JOIN pg_class identity_index ON identity_index.oid = replica_index.indexrelid
WHERE n.nspname = 'inbox_bridge' AND c.relname = 'summaries';

BEGIN;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_electric_replication') THEN
    CREATE ROLE inbox_electric_replication
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS INHERIT CONNECTION LIMIT 4;
  END IF;
END $$;
ALTER ROLE inbox_electric_replication
  LOGIN REPLICATION BYPASSRLS CONNECTION LIMIT 4;

DO $$
BEGIN
  EXECUTE format(
    'ALTER ROLE inbox_electric_replication PASSWORD %L',
    current_setting('sandra.inbox_electric_verifier')
  );
END $$;

GRANT CONNECT ON DATABASE postgres TO inbox_electric_replication;
GRANT USAGE ON SCHEMA inbox_bridge TO inbox_electric_replication;
GRANT SELECT ON TABLE inbox_bridge.summaries TO inbox_electric_replication;
ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication
    WHERE pubname = 'electric_publication_inbox'
      AND puballtables
  ) THEN
    RAISE EXCEPTION 'Electric publication must not publish all tables';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication
    WHERE pubname = 'electric_publication_inbox'
  ) THEN
    EXECUTE 'CREATE PUBLICATION electric_publication_inbox';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox'
      AND (schemaname <> 'inbox_bridge' OR tablename <> 'summaries')
  ) THEN
    RAISE EXCEPTION 'Electric publication contains a table outside inbox_bridge.summaries';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox'
      AND schemaname = 'inbox_bridge' AND tablename = 'summaries'
  ) THEN
    EXECUTE 'ALTER PUBLICATION electric_publication_inbox ADD TABLE inbox_bridge.summaries';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'inbox_electric_replication'
      AND rolcanlogin AND rolreplication AND rolbypassrls
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND rolinherit AND rolconnlimit = 4
  ) THEN
    RAISE EXCEPTION 'Electric role final authority does not match the production contract';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox'
      AND (schemaname <> 'inbox_bridge' OR tablename <> 'summaries')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox'
      AND schemaname = 'inbox_bridge' AND tablename = 'summaries'
  ) THEN
    RAISE EXCEPTION 'Electric publication final table set is not exact';
  END IF;
END $$;
COMMIT;

SELECT set_config('sandra.inbox_electric_verifier', '', false) AS _clear_electric_verifier \gset
