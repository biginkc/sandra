-- Narrow correction of application objects created by the initial bootstrap attempt.
-- Only NEW disposable DB public/bus objects owned by supabase_admin, excluding extension members.
BEGIN;
DO $$ DECLARE x record; BEGIN
 FOR x IN SELECT c.oid,n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','bus') AND c.relowner='supabase_admin'::regrole AND c.relkind IN ('r','p','v','m','S')
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
 ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END,c.oid LOOP
 EXECUTE format('ALTER %s %I.%I OWNER TO postgres',CASE x.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,x.nspname,x.relname);
 END LOOP;
 FOR x IN SELECT p.oid::regprocedure AS signature,p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','bus') AND p.proowner='supabase_admin'::regrole AND p.prokind IN ('f','p')
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') LOOP
 EXECUTE format('ALTER %s %s OWNER TO postgres',CASE WHEN x.prokind='p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,x.signature);
 END LOOP;
 FOR x IN SELECT t.oid::regtype AS type FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname IN ('public','bus') AND t.typowner='supabase_admin'::regrole AND t.typtype IN ('e','d')
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e') LOOP
 EXECUTE format('ALTER TYPE %s OWNER TO postgres',x.type);
 END LOOP;
END $$;
COMMIT;
