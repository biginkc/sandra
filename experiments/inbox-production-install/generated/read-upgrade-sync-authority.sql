BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'sandra_inbox_release_20260917' OR NOT EXISTS(
  SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-release-owned-synthetic'
 ) THEN RAISE EXCEPTION 'Owned release-db fixture required'; END IF;
END $$;
-- Additive candidate RPCs. Public RPC callers supply no actor authority.

SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';

CREATE OR REPLACE FUNCTION inbox_bridge.authorized_scope(scope_id uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;w inbox_bridge.worksets;
BEGIN
 a:=inbox_bridge.authorize_serving(NULL);
 SELECT * INTO w FROM inbox_bridge.worksets WHERE id=scope_id;
 IF NOT FOUND OR w.revoked OR w.expires_at<=clock_timestamp() OR w.org_id<>(a->>'org_id')::uuid OR w.user_id<>(a->>'user_id')::uuid OR w.session_id<>(a->>'session_id')::uuid OR w.access_epoch<>(a->>'access_epoch')::bigint THEN RETURN NULL;END IF;
 IF (a->>'expires_at')::timestamptz<=clock_timestamp() THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('authority',a,'scope',inbox_bridge.scope_json(w));
END $$;
CREATE OR REPLACE FUNCTION inbox_bridge.finalize_scope(scope_id uuid,expected_scope jsonb,partition_index integer,expected_handle text,next_handle text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;w inbox_bridge.worksets;actual jsonb;
BEGIN
 IF expected_scope IS NULL OR jsonb_typeof(expected_scope)<>'object' OR partition_index IS NULL OR partition_index<0 OR partition_index>4 OR (next_handle IS NOT NULL AND (length(next_handle)<1 OR length(next_handle)>256)) OR (expected_handle IS NOT NULL AND length(expected_handle)>256) THEN RETURN NULL;END IF;
 -- Same lock order as workset creation and access-capture writers. A revocation
 -- committed before this lock is acquired must be observed by the fresh check.
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=auth.uid() FOR UPDATE;
 a:=inbox_bridge.authorize_serving(NULL);
 SELECT * INTO w FROM inbox_bridge.worksets WHERE id=scope_id FOR UPDATE;
 IF NOT FOUND OR w.revoked OR w.org_id<>(a->>'org_id')::uuid OR w.user_id<>(a->>'user_id')::uuid OR w.session_id<>(a->>'session_id')::uuid OR w.access_epoch<>(a->>'access_epoch')::bigint OR partition_index>=jsonb_array_length(w.handles) THEN RETURN NULL;END IF;
 actual:=inbox_bridge.scope_json(w);
 IF (actual-'handles') IS DISTINCT FROM (expected_scope-'handles') THEN RETURN NULL;END IF;
 IF (w.handles->>partition_index) IS DISTINCT FROM expected_handle THEN RETURN jsonb_build_object('conflict',true);END IF;
 IF w.expires_at<=clock_timestamp() OR (a->>'expires_at')::timestamptz<=clock_timestamp() THEN RETURN NULL;END IF;
 -- Quiet polls with an unchanged handle perform no row update/WAL write.
 IF next_handle IS NOT NULL AND next_handle IS DISTINCT FROM expected_handle THEN
  UPDATE inbox_bridge.worksets SET handles=jsonb_set(handles,ARRAY[partition_index::text],to_jsonb(next_handle)) WHERE id=scope_id AND NOT revoked AND expires_at>clock_timestamp() RETURNING * INTO w;
  IF NOT FOUND THEN RETURN NULL;END IF;
 END IF;
 IF w.expires_at<=clock_timestamp() OR (a->>'expires_at')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_SESSION_EXPIRED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('authority',a,'scope',inbox_bridge.scope_json(w));
END $$;
CREATE OR REPLACE FUNCTION public.inbox_sync_snapshot_v1(scope_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT inbox_bridge.authorized_scope(scope_id)$$;
CREATE OR REPLACE FUNCTION public.inbox_sync_finalize_v1(scope_id uuid,expected_scope jsonb,partition_index integer,expected_handle text,next_handle text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT inbox_bridge.finalize_scope(scope_id,expected_scope,partition_index,expected_handle,next_handle)$$;
REVOKE ALL ON FUNCTION inbox_bridge.authorized_scope(uuid),inbox_bridge.finalize_scope(uuid,jsonb,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_sync_snapshot_v1(uuid),public.inbox_sync_finalize_v1(uuid,jsonb,integer,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_sync_snapshot_v1(uuid),public.inbox_sync_finalize_v1(uuid,jsonb,integer,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';

-- Production candidate has only explicitly reviewed public API entry points.
-- SECURITY DEFINER internal calls retain owner access; dedicated worker grants are separate.
DO $$ DECLARE n text; BEGIN
 -- Exact reviewed bundle inventory; never touch unrelated Inbox schemas.
 FOREACH n IN ARRAY ARRAY['inbox_control','inbox_summary_contract','inbox_unknown_summary','inbox_authenticated_detail','inbox_capture_boundary','inbox_message_capture','inbox_maintained','inbox_parent','inbox_safety','inbox_backfill','inbox_policy','inbox_bridge','inbox_read'] LOOP
  IF to_regnamespace(n) IS NULL THEN CONTINUE;END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',n);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP;
END $$;
COMMIT;