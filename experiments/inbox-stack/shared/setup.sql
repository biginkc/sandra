\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'sandra_inbox_t1' THEN
    RAISE EXCEPTION 'Only disposable sandra_inbox_t1 is allowed';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS inbox_t1;
CREATE TABLE inbox_t1.fixture_identity(marker text PRIMARY KEY);
INSERT INTO inbox_t1.fixture_identity VALUES ('sandra-inbox-stack-t1-owned-synthetic');
CREATE TABLE inbox_t1.memberships (
  org_id uuid NOT NULL, user_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
  access_epoch bigint NOT NULL DEFAULT 1, PRIMARY KEY (org_id,user_id)
);
INSERT INTO inbox_t1.memberships VALUES
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,1),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true,1);
CREATE TABLE inbox_t1.properties (
  org_id uuid NOT NULL, id uuid NOT NULL, outcome text, assigned_user_id uuid,
  revision bigint NOT NULL DEFAULT 1, PRIMARY KEY (org_id,id)
);
CREATE TABLE inbox_t1.conversation_summaries (
  org_id uuid NOT NULL, conversation_id uuid NOT NULL, property_id uuid NOT NULL,
  last_preview text NOT NULL, latest_message_at timestamptz NOT NULL,
  outcome text, assigned_user_id uuid, revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (org_id,conversation_id)
);
CREATE INDEX ON inbox_t1.conversation_summaries(org_id,latest_message_at DESC,conversation_id DESC);
ALTER TABLE inbox_t1.conversation_summaries REPLICA IDENTITY FULL;
INSERT INTO inbox_t1.properties(org_id,id)
SELECT '11111111-1111-4111-8111-111111111111', md5('inbox-t1-property-'||n)::uuid
FROM generate_series(1,500) n;
INSERT INTO inbox_t1.conversation_summaries(org_id,conversation_id,property_id,last_preview,latest_message_at)
SELECT '11111111-1111-4111-8111-111111111111', md5('inbox-t1-conversation-'||n)::uuid,
 md5('inbox-t1-property-'||CASE WHEN n=500 THEN 1 ELSE n END)::uuid,
 'Synthetic conversation '||n, '2026-09-13 00:00:00+00'::timestamptz - n * interval '1 second'
FROM generate_series(1,500) n;
INSERT INTO inbox_t1.properties(org_id,id) VALUES
 ('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO inbox_t1.conversation_summaries VALUES
 ('22222222-2222-4222-8222-222222222222','dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc',
 'Other tenant synthetic row','2026-09-13 00:00:00+00',null,null,1);
CREATE FUNCTION inbox_t1.bump_property_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.outcome,NEW.assigned_user_id) IS DISTINCT FROM (OLD.outcome,OLD.assigned_user_id) THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bump_property_revision BEFORE UPDATE ON inbox_t1.properties
FOR EACH ROW EXECUTE FUNCTION inbox_t1.bump_property_revision();
CREATE FUNCTION inbox_t1.project_property() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inbox_t1.conversation_summaries SET outcome=NEW.outcome,
    assigned_user_id=NEW.assigned_user_id, revision=NEW.revision
  WHERE org_id=NEW.org_id AND property_id=NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER project_property AFTER UPDATE ON inbox_t1.properties
FOR EACH ROW EXECUTE FUNCTION inbox_t1.project_property();
CREATE TABLE inbox_t1.property_write_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL, property_id uuid NOT NULL,
  old_revision bigint NOT NULL, new_revision bigint NOT NULL,
  written_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION inbox_t1.audit_property_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO inbox_t1.property_write_audit(org_id,property_id,old_revision,new_revision)
  VALUES(NEW.org_id,NEW.id,OLD.revision,NEW.revision);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_property_write AFTER UPDATE ON inbox_t1.properties
FOR EACH ROW EXECUTE FUNCTION inbox_t1.audit_property_write();
-- This deliberately small fixture does not certify production writer capture.
