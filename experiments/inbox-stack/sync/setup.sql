\set ON_ERROR_STOP on
DO $$ BEGIN
 IF current_database()<>'sandra_inbox_t1' THEN RAISE EXCEPTION 'owned fixture only'; END IF;
END $$;
-- Small server-owned membership table avoids a 31KB immutable shape URL.
CREATE TABLE IF NOT EXISTS inbox_t1.sync_workset_members (
 workset_id uuid NOT NULL, org_id uuid NOT NULL, conversation_id uuid NOT NULL,
 PRIMARY KEY(workset_id,org_id,conversation_id)
);
ALTER TABLE inbox_t1.sync_workset_members REPLICA IDENTITY FULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_publication_tables WHERE pubname='electric_publication_inbox_t1' AND tablename='sync_workset_members') THEN
 ALTER PUBLICATION electric_publication_inbox_t1 ADD TABLE inbox_t1.sync_workset_members;
 END IF;
END $$;
