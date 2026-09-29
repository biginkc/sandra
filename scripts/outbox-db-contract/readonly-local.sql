CREATE SCHEMA auth;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text);
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE w4r_reader LOGIN PASSWORD 'reader' BYPASSRLS;
GRANT USAGE ON SCHEMA supabase_migrations TO w4r_reader;
GRANT SELECT ON supabase_migrations.schema_migrations TO w4r_reader;
GRANT authenticated TO w4r_reader;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
GRANT USAGE ON SCHEMA auth TO authenticated,w4r_reader;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated,w4r_reader;
CREATE TABLE public.organizations(id uuid PRIMARY KEY);
CREATE TABLE public.memberships(user_id uuid, org_id uuid, access_status text, access_expires_at timestamptz, deletion_prepared_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.properties(id uuid PRIMARY KEY,address text,city text,state text);
CREATE TABLE public.contacts(id uuid PRIMARY KEY,first_name text,last_name text,entity_name text,phone_1 text);
-- Checker-facing columns are verified against migration-derived PRE and POST schemas
-- by outbox-db-contract-readonly.test.mjs. messages has no update timestamp.
CREATE TABLE public.messages(id uuid PRIMARY KEY, org_id uuid, body text, from_address text, to_address text, created_at timestamptz DEFAULT now(), scheduled_for timestamptz, property_id uuid, contact_id uuid, status text);
CREATE INDEX messages_queue_idx ON public.messages(status,org_id,scheduled_for,id);
CREATE INDEX messages_queue_shape_idx ON public.messages(status,scheduled_for,id);
CREATE POLICY messages_org_select ON public.messages FOR SELECT TO authenticated USING (org_id IN (SELECT org_id FROM public.memberships WHERE user_id=auth.uid()));
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.messages,public.memberships,public.organizations,public.properties,public.contacts TO authenticated,w4r_reader;
INSERT INTO public.organizations VALUES ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),('00000000-0000-0000-0000-000000000003');
INSERT INTO public.memberships(user_id,org_id,access_status) VALUES ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','active'),('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000002','active');
INSERT INTO public.memberships(user_id,org_id,access_status,access_expires_at) VALUES ('00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000003','active',now()-interval '1 day');
INSERT INTO public.messages(id,org_id,body,status) VALUES ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','one','queued'),('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000002','two','queued'),('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000003','foreign','queued');
