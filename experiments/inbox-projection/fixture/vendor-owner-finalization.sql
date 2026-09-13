-- Exact owner correction for added vendor objects; old owned catalog confirms these identities.
ALTER TABLE auth.identities OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.jwt() OWNER TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.jwt() TO postgres, dashboard_user;
-- Storage install_roles=false preserves image role hierarchy; restore expected API object grants.
GRANT USAGE ON SCHEMA storage TO postgres,anon,authenticated,service_role;
GRANT ALL ON storage.buckets,storage.objects TO anon,authenticated,service_role;
