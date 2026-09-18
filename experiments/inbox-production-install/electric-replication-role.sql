\set ON_ERROR_STOP on
-- Release-only Electric provisioning template.  Invoke with an explicit
-- psql -v electric_password=... value from the hosting secret store.  This
-- file deliberately contains no password and refuses every other database.
DO $$
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'release Electric packet must run in database postgres';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM install_fixture.identity
    WHERE marker = 'sandra-inbox-http-owned-synthetic-20260917'
  ) THEN
    RAISE EXCEPTION 'release HTTP fixture marker is missing';
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

BEGIN;
-- Create the named principal in a harmless NOLOGIN state first.  The next
-- ALTER ROLE is the only statement that consumes the caller-provided secret.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_electric_replication') THEN
    CREATE ROLE inbox_electric_replication
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      NOBYPASSRLS INHERIT CONNECTION LIMIT 4;
  END IF;
END $$;
ALTER ROLE inbox_electric_replication
  LOGIN REPLICATION BYPASSRLS CONNECTION LIMIT 4 PASSWORD :'electric_password';

GRANT CONNECT ON DATABASE postgres TO inbox_electric_replication;
GRANT USAGE ON SCHEMA inbox_bridge TO inbox_electric_replication;
GRANT SELECT ON TABLE inbox_bridge.summaries TO inbox_electric_replication;
ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;

-- Electric runs with manual table publication.  The publication is created
-- by the reviewed database login so the runtime role never needs DDL rights.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication
    WHERE pubname = 'electric_publication_inbox_release_20260917'
      AND puballtables
  ) THEN
    RAISE EXCEPTION 'Electric publication must not publish all tables';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication
    WHERE pubname = 'electric_publication_inbox_release_20260917'
  ) THEN
    EXECUTE 'CREATE PUBLICATION electric_publication_inbox_release_20260917';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox_release_20260917'
      AND (schemaname <> 'inbox_bridge' OR tablename <> 'summaries')
  ) THEN
    RAISE EXCEPTION 'Electric publication contains a table outside inbox_bridge.summaries';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox_release_20260917'
      AND schemaname = 'inbox_bridge' AND tablename = 'summaries'
  ) THEN
    EXECUTE 'ALTER PUBLICATION electric_publication_inbox_release_20260917 ADD TABLE inbox_bridge.summaries';
  END IF;
END $$;

-- Final catalog assertions make an accidental broad grant/publication fail
-- before Electric can create a slot or consume any data.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'inbox_electric_replication'
      AND rolcanlogin AND rolreplication AND rolbypassrls
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND rolinherit AND rolconnlimit = 4
  ) THEN
    RAISE EXCEPTION 'Electric role final authority does not match the release contract';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox_release_20260917'
      AND (schemaname <> 'inbox_bridge' OR tablename <> 'summaries')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'electric_publication_inbox_release_20260917'
      AND schemaname = 'inbox_bridge' AND tablename = 'summaries'
  ) THEN
    RAISE EXCEPTION 'Electric publication final table set is not exact';
  END IF;
END $$;
COMMIT;
