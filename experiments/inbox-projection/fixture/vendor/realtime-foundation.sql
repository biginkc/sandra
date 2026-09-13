-- SQL translation of pinned vendor Ecto migration; only required authorization foundation.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE IF NOT EXISTS realtime.messages (id bigserial PRIMARY KEY,topic text NOT NULL,extension text NOT NULL,inserted_at timestamp NOT NULL,updated_at timestamp NOT NULL);
CREATE INDEX IF NOT EXISTS messages_topic_index ON realtime.messages(topic);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO postgres,anon,authenticated,service_role;
GRANT SELECT,UPDATE,INSERT ON realtime.messages TO postgres,anon,authenticated,service_role;
GRANT USAGE ON SEQUENCE realtime.messages_id_seq TO postgres,anon,authenticated,service_role;
ALTER TABLE realtime.messages OWNER TO supabase_realtime_admin;
CREATE OR REPLACE FUNCTION realtime.topic() RETURNS text AS $$ SELECT nullif(current_setting('realtime.topic',true),'')::text; $$ LANGUAGE sql STABLE;
ALTER FUNCTION realtime.topic() OWNER TO supabase_realtime_admin;
