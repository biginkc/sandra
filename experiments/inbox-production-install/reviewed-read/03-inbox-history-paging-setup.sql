-- Owned canonical fixture candidate; release requires the normal migration path.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(
 SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic'
) THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE TABLE inbox_t2_read.history_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 boundary_id uuid NOT NULL REFERENCES inbox_t2_read.boundaries(id),
 session_id uuid NOT NULL, access_epoch bigint NOT NULL,
 before_at timestamptz NOT NULL, before_id uuid NOT NULL,
 UNIQUE(boundary_id,session_id,access_epoch,before_at,before_id)
);
ALTER TABLE inbox_t2_read.history_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_t2_read.history_cursors FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_t2_read.history_page(o uuid,c uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb; position inbox_t2_read.history_cursors;
 boundary inbox_t2_read.boundaries; last_message jsonb; next_cursor uuid;
BEGIN
 a:=inbox_t2_bridge.authorize(o);
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR UPDATE;
 a:=inbox_t2_bridge.authorize(o);
 IF before_cursor IS NULL THEN
  result:=inbox_t2_read.detail(o,c);
  SELECT * INTO STRICT boundary FROM inbox_t2_read.boundaries WHERE id=(result->>'read_boundary')::uuid;
 ELSE
  SELECT * INTO position FROM inbox_t2_read.history_cursors WHERE id=before_cursor;
  IF NOT FOUND OR position.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR position.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
   RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
  SELECT * INTO boundary FROM inbox_t2_read.boundaries WHERE id=position.boundary_id;
  IF NOT FOUND OR boundary.requester_id IS DISTINCT FROM (a->>'user_id')::uuid OR boundary.org_id IS DISTINCT FROM o OR boundary.conversation_id IS DISTINCT FROM c
   OR boundary.session_id IS DISTINCT FROM (a->>'session_id')::uuid OR boundary.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
   RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
  IF boundary.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
  -- Reuse the canonical measured keyset query. No message update and no new read
  -- boundary: later/backdated arrivals cannot extend the acknowledged snapshot.
  result:=inbox_t2_authenticated_detail.detail_v2(o,c,position.before_at,position.before_id)
    || inbox_t2_read.authoritative_context(o,c);
  result:=result||jsonb_build_object('read_boundary',boundary.id,'boundary_expires_at',boundary.expires_at,
   'capture_generation',boundary.generation,'head_revision',boundary.revision::text);
 END IF;
 IF jsonb_array_length(result->'history')=50 THEN
  last_message:=result->'history'->49;
  INSERT INTO inbox_t2_read.history_cursors(boundary_id,session_id,access_epoch,before_at,before_id)
   VALUES(boundary.id,(a->>'session_id')::uuid,(a->>'access_epoch')::bigint,(last_message->>'created_at_raw')::timestamptz,(last_message->>'id')::uuid)
   ON CONFLICT(boundary_id,session_id,access_epoch,before_at,before_id) DO UPDATE SET boundary_id=EXCLUDED.boundary_id
   RETURNING id INTO next_cursor;
 END IF;
 PERFORM inbox_t2_bridge.authorize(o);
 IF boundary.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 RETURN result||jsonb_build_object('next_cursor',next_cursor);
END $$;
REVOKE ALL ON FUNCTION inbox_t2_read.history_page(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.inbox_history_page(org_id uuid,conversation_id uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_t2_read.history_page(org_id,conversation_id,before_cursor)
$$;
REVOKE ALL ON FUNCTION public.inbox_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_history_page(uuid,uuid,uuid) TO authenticated;
COMMIT;
