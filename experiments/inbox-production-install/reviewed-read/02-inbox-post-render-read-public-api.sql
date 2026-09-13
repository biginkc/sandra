-- Owned fixture only. Apply through the established migration workflow for release.
BEGIN;
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(
 SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic'
) THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE FUNCTION public.inbox_read_detail(org_id uuid,conversation_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_t2_read.detail(org_id,conversation_id)
$$;
CREATE FUNCTION public.inbox_acknowledge_read(boundary_id uuid,batch_number integer) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_t2_read.acknowledge(boundary_id,batch_number)
$$;
REVOKE ALL ON FUNCTION public.inbox_read_detail(uuid,uuid),public.inbox_acknowledge_read(uuid,integer)
 FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_read_detail(uuid,uuid),public.inbox_acknowledge_read(uuid,integer) TO authenticated;
COMMIT;
