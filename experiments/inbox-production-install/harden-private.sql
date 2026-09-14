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
