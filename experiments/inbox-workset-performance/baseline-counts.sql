CREATE FUNCTION inbox_t2_bridge.counts_baseline(org_id uuid,filter jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb;after_access jsonb;f jsonb;result jsonb;
BEGIN
 a:=inbox_t2_bridge.authorize(org_id);f:=inbox_t2_bridge.normalize_filter(filter);
 SELECT jsonb_object_agg(view,total) INTO result FROM (
 SELECT view,(SELECT count(*) FROM inbox_t2_bridge.matching(org_id,(a->>'user_id')::uuid,f||jsonb_build_object('view',view))) total
 FROM unnest(ARRAY['all','mine','unassigned','unread','escalated','dispo','needs_outcome','unknown','dismissed'])view) counts;
 after_access:=inbox_t2_bridge.authorize(org_id);
 IF (after_access->>'user_id',after_access->>'session_id',after_access->>'access_epoch') IS DISTINCT FROM (a->>'user_id',a->>'session_id',a->>'access_epoch') THEN RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('counts',result,'as_of',statement_timestamp(),'access_epoch',a->>'access_epoch');
END $$;
REVOKE ALL ON FUNCTION inbox_t2_bridge.counts_baseline(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
