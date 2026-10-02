\set ON_ERROR_STOP on
-- Runtime-only LOGIN packet. This is deliberately not a migration. Run it
-- through run-runtime-worker-logins.py so the three SCRAM verifiers arrive on
-- stdin at apply time and never live in this repository, argv, or a temp file.
\if :{?action_verifier}
\else
  \echo 'action_verifier is required'
  \quit 3
\endif
\if :{?reply_verifier}
\else
  \echo 'reply_verifier is required'
  \quit 3
\endif
\if :{?projection_verifier}
\else
  \echo 'projection_verifier is required'
  \quit 3
\endif

SELECT set_config('sandra.inbox_action_verifier', :'action_verifier', false) AS _set_action_verifier \gset
SELECT set_config('sandra.inbox_reply_verifier', :'reply_verifier', false) AS _set_reply_verifier \gset
SELECT set_config('sandra.inbox_projection_verifier', :'projection_verifier', false) AS _set_projection_verifier \gset

DO $$
DECLARE
  verifier text;
  role_name text;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'runtime worker LOGIN packet must run in database postgres';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'runtime worker LOGIN packet must run as postgres';
  END IF;
  IF current_setting('server_version_num')::int < 170000 THEN
    RAISE EXCEPTION 'runtime worker LOGIN packet requires PostgreSQL 17 or newer';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['inbox_action_worker', 'inbox_reply_send_worker', 'inbox_projection_worker'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'candidate role % must exist before LOGIN provisioning', role_name;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('inbox_action_worker', 'inbox_reply_send_worker', 'inbox_projection_worker')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit = false)
  ) THEN
    RAISE EXCEPTION 'candidate worker role has unexpected authority';
  END IF;
  FOREACH verifier IN ARRAY ARRAY[
    current_setting('sandra.inbox_action_verifier'),
    current_setting('sandra.inbox_reply_verifier'),
    current_setting('sandra.inbox_projection_verifier')
  ] LOOP
    IF verifier !~ '^SCRAM-SHA-256\$[1-9][0-9]{0,9}:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
       OR split_part(split_part(verifier, '$', 2), ':', 1)::bigint < 4096 THEN
      RAISE EXCEPTION 'worker LOGIN verifier must be a well-formed SCRAM-SHA-256 verifier';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member
    WHERE r.rolname IN ('inbox_action_worker', 'inbox_reply_send_worker', 'inbox_projection_worker')
  ) THEN
    RAISE EXCEPTION 'NOLOGIN worker roles must not inherit another role';
  END IF;
END $$;

-- The projection process connects as a separate LOGIN member and immediately
-- SET ROLE inbox_projection_worker. It must have one membership, no admin
-- option, and a limit for one pool per process across two generations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_projection_login') THEN
    CREATE ROLE inbox_projection_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'inbox_projection_login'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit = false)
  ) THEN
    RAISE EXCEPTION 'projection LOGIN role has unexpected authority';
  END IF;
END $$;

ALTER ROLE inbox_action_worker LOGIN CONNECTION LIMIT 4 PASSWORD :'action_verifier';
ALTER ROLE inbox_reply_send_worker LOGIN CONNECTION LIMIT 4 PASSWORD :'reply_verifier';
ALTER ROLE inbox_projection_login LOGIN CONNECTION LIMIT 2 PASSWORD :'projection_verifier';
GRANT inbox_projection_worker TO inbox_projection_login;

DO $$
DECLARE
  projection_login oid;
  projection_role oid;
BEGIN
  SELECT oid INTO projection_login FROM pg_roles WHERE rolname = 'inbox_projection_login';
  SELECT oid INTO projection_role FROM pg_roles WHERE rolname = 'inbox_projection_worker';
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE oid = projection_role AND NOT rolcanlogin AND rolconnlimit = -1
  ) THEN
    RAISE EXCEPTION 'projection worker must remain NOLOGIN';
  END IF;
  IF (SELECT rolcanlogin FROM pg_roles WHERE oid = projection_login) IS DISTINCT FROM true
     OR (SELECT rolconnlimit FROM pg_roles WHERE oid = projection_login) IS DISTINCT FROM 2
     OR (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE oid = projection_login) THEN
    RAISE EXCEPTION 'projection LOGIN role has unsafe LOGIN attributes';
  END IF;
  IF (SELECT count(*) FROM pg_auth_members WHERE member = projection_login) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_auth_members
       WHERE member = projection_login AND roleid = projection_role AND NOT admin_option
     ) THEN
    RAISE EXCEPTION 'projection LOGIN role must have exactly one non-admin projection membership';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member = projection_login AND admin_option
  ) THEN
    RAISE EXCEPTION 'projection LOGIN role must not administer its NOLOGIN role';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_action_worker' AND (NOT rolcanlogin OR rolconnlimit <> 4))
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_reply_send_worker' AND (NOT rolcanlogin OR rolconnlimit <> 4)) THEN
    RAISE EXCEPTION 'worker LOGIN roles must have connection limit 4';
  END IF;
END $$;
