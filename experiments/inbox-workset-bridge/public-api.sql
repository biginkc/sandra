-- Owned fixture only; production application requires reviewed migration installation.
BEGIN;
DO $$ BEGIN IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE FUNCTION public.inbox_authorize_sync(org_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_t2_bridge.authorize(org_id) $$;
CREATE FUNCTION public.inbox_create_workset(org_id uuid,filter jsonb,"limit" integer,replaces_scope_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_t2_bridge.create_scope(org_id,filter,"limit",replaces_scope_id) $$;
CREATE FUNCTION public.inbox_get_sync_scope(scope_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_t2_bridge.get_scope(scope_id) $$;
CREATE FUNCTION public.inbox_bind_sync_handle(scope_id uuid,partition_index integer,expected_handle text,next_handle text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_t2_bridge.bind_handle(scope_id,partition_index,expected_handle,next_handle) $$;
REVOKE ALL ON FUNCTION public.inbox_authorize_sync(uuid),public.inbox_create_workset(uuid,jsonb,integer,uuid),public.inbox_get_sync_scope(uuid),public.inbox_bind_sync_handle(uuid,integer,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_authorize_sync(uuid),public.inbox_create_workset(uuid,jsonb,integer,uuid),public.inbox_get_sync_scope(uuid),public.inbox_bind_sync_handle(uuid,integer,text,text) TO authenticated;
COMMIT;
