-- Session-scoped wrappers + public SECURITY DEFINER grants, mirroring
-- experiments/inbox-operation-preparation/public-api.sql and the
-- assignees()/authorize(NULL) idiom in review.sql.
BEGIN;
CREATE FUNCTION inbox_saved_actions.create_for_session(name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.create((a->>'org_id')::uuid,(a->>'user_id')::uuid,name,definition); END $$;

CREATE FUNCTION inbox_saved_actions.update_for_session(target_id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.update((a->>'org_id')::uuid,(a->>'user_id')::uuid,target_id,name,definition); END $$;

CREATE FUNCTION inbox_saved_actions.deactivate_for_session(target_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.deactivate((a->>'org_id')::uuid,(a->>'user_id')::uuid,target_id); END $$;

CREATE FUNCTION inbox_saved_actions.list_for_session() RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.list((a->>'org_id')::uuid,(a->>'user_id')::uuid); END $$;

CREATE FUNCTION inbox_saved_actions.get_for_session(target_id uuid,target_version integer) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN a:=inbox_action_api.authorize(NULL); RETURN inbox_saved_actions.get((a->>'org_id')::uuid,(a->>'user_id')::uuid,target_id,target_version); END $$;

CREATE FUNCTION public.inbox_saved_action_create(name text,definition jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_saved_actions.create_for_session(name,definition) $$;
CREATE FUNCTION public.inbox_saved_action_update(id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_saved_actions.update_for_session(id,name,definition) $$;
CREATE FUNCTION public.inbox_saved_action_deactivate(id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_saved_actions.deactivate_for_session(id) $$;
CREATE FUNCTION public.inbox_saved_action_list() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_saved_actions.list_for_session() $$;
CREATE FUNCTION public.inbox_saved_action_get(id uuid,version integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_saved_actions.get_for_session(id,version) $$;

REVOKE ALL ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),
 public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),
 public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer)
 TO authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_saved_actions FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
