
    DO
    $do$
    BEGIN
       IF EXISTS (
          SELECT FROM pg_catalog.pg_roles
          WHERE  rolname = 'supabase_realtime_admin') THEN

          RAISE NOTICE 'Role "supabase_realtime_admin" already exists. Skipping.';
       ELSE
          CREATE ROLE supabase_realtime_admin WITH NOINHERIT NOLOGIN NOREPLICATION;
       END IF;
    END
    $do$;
    
GRANT ALL PRIVILEGES ON SCHEMA realtime TO supabase_realtime_admin;
GRANT supabase_realtime_admin TO postgres;
