-- Offline fixture only. Deliberately not a production migration or head reset.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' OR
 NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN
 RAISE EXCEPTION 'Owned canonical fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_capture_boundary;
REVOKE ALL ON SCHEMA inbox_t2_capture_boundary FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_capture_boundary.generation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton IS TRUE),
 generation uuid NOT NULL
);
REVOKE ALL ON TABLE inbox_t2_capture_boundary.generation FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE inbox_t2_capture_boundary.generation ENABLE ROW LEVEL SECURITY;
INSERT INTO inbox_t2_capture_boundary.generation(singleton,generation) VALUES(true,gen_random_uuid());
CREATE FUNCTION inbox_t2_capture_boundary.detail(p_org uuid,p_conversation uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; current_generation uuid;
BEGIN
 -- Existing routine performs explicit auth.uid/role + Hugo lifecycle checks.
 -- Both STABLE routines use the caller statement's MVCC snapshot.
 result:=inbox_t2_authenticated_detail.detail_v2(p_org,p_conversation);
 SELECT generation INTO current_generation FROM inbox_t2_capture_boundary.generation WHERE singleton IS TRUE;
 IF current_generation IS NULL THEN
  RAISE EXCEPTION 'INBOX_CAPTURE_METADATA_UNAVAILABLE' USING ERRCODE='55000';
 END IF;
 RETURN result || jsonb_build_object('capture_generation',current_generation);
END $$;
REVOKE ALL ON FUNCTION inbox_t2_capture_boundary.detail(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA inbox_t2_capture_boundary TO authenticated;
GRANT EXECUTE ON FUNCTION inbox_t2_capture_boundary.detail(uuid,uuid) TO authenticated;
COMMIT;
