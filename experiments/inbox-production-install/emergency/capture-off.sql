-- GENERATED FILE. Source: 20261002130000_inbox_control_foundation.sql, 20261002130100_inbox_read_companion.sql, 20261002130200_inbox_backend_operation_reply.sql at 4ee23fcb25d05bad77e2cf74189c24bb1f9ea4c2.
-- Tooling-only emergency packet; never place this file in supabase/migrations.
-- Canonical source-capture trigger inventory is in capture-trigger-inventory.json.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';

DO $$
DECLARE approved_count integer; no_op_count integer; total_count integer; attached_count integer;
BEGIN
  -- EMERGENCY_TARGET_IDENTITY_GUARD_BEGIN
  IF current_setting('inbox.emergency_target_ref', true) = 'copflsklaefwzipsrjqz' THEN
    IF current_setting('inbox.emergency_local_test', true) = 'on' THEN
      RAISE EXCEPTION 'INBOX_EMERGENCY_PRODUCTION_LOCAL_TEST_REFUSED';
    END IF;
    IF current_database() <> 'postgres' THEN
      RAISE EXCEPTION 'INBOX_EMERGENCY_DATABASE_NAME_REFUSED';
    END IF;
  ELSIF current_setting('inbox.emergency_target_ref', true) = 'local-test' THEN
    IF current_setting('inbox.emergency_local_test', true) <> 'on'
       OR current_database() <> 'postgres'
       OR inet_server_addr() IS NULL
       OR inet_server_addr() NOT IN ('127.0.0.1'::inet, '::1'::inet) THEN
      RAISE EXCEPTION 'INBOX_EMERGENCY_LOCAL_TEST_IDENTITY_REFUSED';
    END IF;
  ELSE
    RAISE EXCEPTION 'INBOX_EMERGENCY_TARGET_REF_REQUIRED';
  END IF;
  -- EMERGENCY_TARGET_IDENTITY_GUARD_END
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_ROLE_REQUIRED';
  END IF;
  IF NOT has_table_privilege('postgres', 'auth.sessions', 'SELECT')
     OR NOT has_table_privilege('postgres', 'auth.sessions', 'TRIGGER') THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_AUTH_SESSIONS_PRIVILEGE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='inbox_bridge' AND p.proname='capture_access'
        AND pg_get_userbyid(p.proowner)='postgres') <> 1 THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_AUTH_FUNCTION_OWNER_DRIFT';
  END IF;
  WITH expected(name, approved_md5, no_op_md5) AS (VALUES
      ('inbox_backfill.capture_collision()', '58b44491162a135f0d2e46d73bb6b79c', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_bridge.capture_access()', '8583671b0e8b10f83edff9c7ba961eb2', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_message_capture.capture()', 'c65d454fcef9e87512af5e97e17e599d', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_sms_scope()', '3344af15a68206052158425e4283179e', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_target()', '380bbd13de051c04e6acd3ee90c269db', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_parent()', '94f86879c7985e63cd0ca7b3e4572b56', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_review()', '16c2de2584351a782e356f01db2bbf41', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_ai_disposition_reviews()', '065afb4f2ecf83ca93211c1a89d3f1b0', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_consent_events()', '1b9f5ebd06f62a86e0c2101ef9acbeb9', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_contacts()', '4d99f53f06cb667721c65cb50ea40b10', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_memberships()', '8d83deb6ed81fb0a3023898f225c6d38', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_message_threads()', '07da9ee2e294444a5f86ce4b44bbe3a6', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_properties()', 'bfba50ac7077a0b4c7b56855aca9c6e8', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_sms_phone_suppressions()', 'b16569b969660fa433e8b90550c483f0', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_organization()', '752e3e58dfec918fe6cd5496faef5ac3', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_property()', 'ebe4c89c956aaf51468f09fe067b82ef', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_sender()', '5c7330d97d21c39e0cfe49aa3535f2a9', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.consent_capture()', '80f52a0718eedb03f177516b20ab3c4d', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.suppression_capture()', 'c70a2d52b000a4dad46ccfa137e44680', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.thread_capture()', '0e284768a7315bbbb1adb8730bd42cc2', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('public.inbox_capture_inbound_head()', '06d8dd4070ff5b45032f44033dea0053', '8ab64bae8d78de0c4333d9b2820a4168')
  )
  SELECT count(*) FILTER (WHERE p.oid IS NULL),
         count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.approved_md5),
         count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.no_op_md5),
         count(*)
    INTO total_count, approved_count, no_op_count, attached_count
    FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.name);
  IF total_count <> 0 THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_FUNCTION_MISSING'; END IF;
  IF approved_count <> 21 AND no_op_count <> 21 THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_FUNCTION_BODY_DRIFT';
  END IF;
  WITH expected(identity, function_name, tgtype) AS (VALUES
      ('auth.sessions.zzzzzzz_inbox_access', 'inbox_bridge.capture_access()', 29),
      ('public.ai_disposition_reviews.zzzzz_inbox_parent_review', 'inbox_parent.capture_review()', 29),
      ('public.ai_disposition_reviews.zzzzzz_inbox_policy', 'inbox_policy.capture_ai_disposition_reviews()', 29),
      ('public.ai_disposition_reviews.zzzzzzzz_inbox_operation_target', 'inbox_operation_domain.capture_target()', 29),
      ('public.consent_events.zzzzz_inbox_safety_consent', 'inbox_safety.consent_capture()', 29),
      ('public.consent_events.zzzzzz_inbox_policy', 'inbox_policy.capture_consent_events()', 29),
      ('public.contacts.zzzzz_inbox_parent', 'inbox_parent.capture_parent()', 29),
      ('public.contacts.zzzzzz_inbox_policy', 'inbox_policy.capture_contacts()', 29),
      ('public.memberships.zzzzzz_inbox_policy', 'inbox_policy.capture_memberships()', 29),
      ('public.memberships.zzzzzzz_inbox_access', 'inbox_bridge.capture_access()', 29),
      ('public.message_threads.zzzzz_inbox_backfill_collision', 'inbox_backfill.capture_collision()', 29),
      ('public.message_threads.zzzzz_inbox_safety_thread', 'inbox_safety.thread_capture()', 29),
      ('public.message_threads.zzzzzz_inbox_policy', 'inbox_policy.capture_message_threads()', 29),
      ('public.messages.inbox_capture_inbound_head', 'public.inbox_capture_inbound_head()', 21),
      ('public.messages.zzzzz_inbox_message_direct', 'inbox_message_capture.capture()', 29),
      ('public.messages.zzzzzzzz_inbox_operation_target', 'inbox_operation_domain.capture_target()', 29),
      ('public.organizations.zzzzzzz_inbox_reply_context', 'inbox_reply_context.capture_organization()', 29),
      ('public.properties.zzzzz_inbox_parent', 'inbox_parent.capture_parent()', 29),
      ('public.properties.zzzzzz_inbox_policy', 'inbox_policy.capture_properties()', 29),
      ('public.properties.zzzzzzz_inbox_reply_context', 'inbox_reply_context.capture_property()', 29),
      ('public.properties.zzzzzzzzz_inbox_sms_scope', 'inbox_operation_domain.capture_sms_scope()', 29),
      ('public.provider_sender_numbers.zzzzzzz_inbox_reply_context', 'inbox_reply_context.capture_sender()', 29),
      ('public.sequence_enrollments.zzzzzzzzz_inbox_sms_scope', 'inbox_operation_domain.capture_sms_scope()', 29),
      ('public.sms_phone_suppressions.zzzzz_inbox_safety_suppression', 'inbox_safety.suppression_capture()', 29),
      ('public.sms_phone_suppressions.zzzzzz_inbox_policy', 'inbox_policy.capture_sms_phone_suppressions()', 29)
  )
  SELECT count(*) INTO attached_count
    FROM expected e
    JOIN pg_trigger t ON NOT t.tgisinternal AND t.tgname = split_part(e.identity, '.', 3)
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace cn ON cn.oid=c.relnamespace
      AND cn.nspname||'.'||c.relname = split_part(e.identity, '.', 1)||'.'||split_part(e.identity, '.', 2)
    WHERE t.tgfoid=to_regprocedure(e.function_name) AND t.tgtype=e.tgtype AND t.tgenabled='O';
  IF attached_count <> 25 THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_TRIGGER_CATALOG_DRIFT'; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS inbox_emergency AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_emergency FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS inbox_emergency.capture_off_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('capture_off', 'capture_off_idempotent', 'capture_restore')),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_migration_commit text NOT NULL,
  trigger_count integer NOT NULL,
  function_bodies_md5 jsonb NOT NULL,
  trigger_inventory jsonb NOT NULL
);
ALTER TABLE inbox_emergency.capture_off_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_emergency.capture_off_receipts FROM PUBLIC, anon, authenticated, service_role;

WITH expected(name, no_op_md5) AS (VALUES
      ('inbox_backfill.capture_collision()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_bridge.capture_access()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_message_capture.capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_sms_scope()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_target()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_parent()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_review()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_ai_disposition_reviews()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_consent_events()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_contacts()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_memberships()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_message_threads()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_properties()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_sms_phone_suppressions()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_organization()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_property()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_sender()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.consent_capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.suppression_capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.thread_capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('public.inbox_capture_inbound_head()', '8ab64bae8d78de0c4333d9b2820a4168')
  )
INSERT INTO inbox_emergency.capture_off_receipts(action, approved_migration_commit, trigger_count, function_bodies_md5, trigger_inventory)
SELECT CASE WHEN count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.no_op_md5) = 21
            THEN 'capture_off_idempotent' ELSE 'capture_off' END,
       '4ee23fcb25d05bad77e2cf74189c24bb1f9ea4c2', 25, '{"inbox_backfill.capture_collision":"8ab64bae8d78de0c4333d9b2820a4168","inbox_bridge.capture_access":"8ab64bae8d78de0c4333d9b2820a4168","inbox_message_capture.capture":"8ab64bae8d78de0c4333d9b2820a4168","inbox_operation_domain.capture_sms_scope":"8ab64bae8d78de0c4333d9b2820a4168","inbox_operation_domain.capture_target":"8ab64bae8d78de0c4333d9b2820a4168","inbox_parent.capture_parent":"8ab64bae8d78de0c4333d9b2820a4168","inbox_parent.capture_review":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_ai_disposition_reviews":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_consent_events":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_contacts":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_memberships":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_message_threads":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_properties":"8ab64bae8d78de0c4333d9b2820a4168","inbox_policy.capture_sms_phone_suppressions":"8ab64bae8d78de0c4333d9b2820a4168","inbox_reply_context.capture_organization":"8ab64bae8d78de0c4333d9b2820a4168","inbox_reply_context.capture_property":"8ab64bae8d78de0c4333d9b2820a4168","inbox_reply_context.capture_sender":"8ab64bae8d78de0c4333d9b2820a4168","inbox_safety.consent_capture":"8ab64bae8d78de0c4333d9b2820a4168","inbox_safety.suppression_capture":"8ab64bae8d78de0c4333d9b2820a4168","inbox_safety.thread_capture":"8ab64bae8d78de0c4333d9b2820a4168","public.inbox_capture_inbound_head":"8ab64bae8d78de0c4333d9b2820a4168"}'::jsonb, '[{"identity":"auth.sessions.zzzzzzz_inbox_access","function":"inbox_bridge.capture_access"},{"identity":"public.ai_disposition_reviews.zzzzz_inbox_parent_review","function":"inbox_parent.capture_review"},{"identity":"public.ai_disposition_reviews.zzzzzz_inbox_policy","function":"inbox_policy.capture_ai_disposition_reviews"},{"identity":"public.ai_disposition_reviews.zzzzzzzz_inbox_operation_target","function":"inbox_operation_domain.capture_target"},{"identity":"public.consent_events.zzzzz_inbox_safety_consent","function":"inbox_safety.consent_capture"},{"identity":"public.consent_events.zzzzzz_inbox_policy","function":"inbox_policy.capture_consent_events"},{"identity":"public.contacts.zzzzz_inbox_parent","function":"inbox_parent.capture_parent"},{"identity":"public.contacts.zzzzzz_inbox_policy","function":"inbox_policy.capture_contacts"},{"identity":"public.memberships.zzzzzz_inbox_policy","function":"inbox_policy.capture_memberships"},{"identity":"public.memberships.zzzzzzz_inbox_access","function":"inbox_bridge.capture_access"},{"identity":"public.message_threads.zzzzz_inbox_backfill_collision","function":"inbox_backfill.capture_collision"},{"identity":"public.message_threads.zzzzz_inbox_safety_thread","function":"inbox_safety.thread_capture"},{"identity":"public.message_threads.zzzzzz_inbox_policy","function":"inbox_policy.capture_message_threads"},{"identity":"public.messages.inbox_capture_inbound_head","function":"public.inbox_capture_inbound_head"},{"identity":"public.messages.zzzzz_inbox_message_direct","function":"inbox_message_capture.capture"},{"identity":"public.messages.zzzzzzzz_inbox_operation_target","function":"inbox_operation_domain.capture_target"},{"identity":"public.organizations.zzzzzzz_inbox_reply_context","function":"inbox_reply_context.capture_organization"},{"identity":"public.properties.zzzzz_inbox_parent","function":"inbox_parent.capture_parent"},{"identity":"public.properties.zzzzzz_inbox_policy","function":"inbox_policy.capture_properties"},{"identity":"public.properties.zzzzzzz_inbox_reply_context","function":"inbox_reply_context.capture_property"},{"identity":"public.properties.zzzzzzzzz_inbox_sms_scope","function":"inbox_operation_domain.capture_sms_scope"},{"identity":"public.provider_sender_numbers.zzzzzzz_inbox_reply_context","function":"inbox_reply_context.capture_sender"},{"identity":"public.sequence_enrollments.zzzzzzzzz_inbox_sms_scope","function":"inbox_operation_domain.capture_sms_scope"},{"identity":"public.sms_phone_suppressions.zzzzz_inbox_safety_suppression","function":"inbox_safety.suppression_capture"},{"identity":"public.sms_phone_suppressions.zzzzzz_inbox_policy","function":"inbox_policy.capture_sms_phone_suppressions"}]'::jsonb
  FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.name);

CREATE OR REPLACE FUNCTION inbox_backfill.capture_collision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_bridge.capture_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_message_capture.capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_operation_domain.capture_sms_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_operation_domain.capture_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_parent.capture_parent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_parent.capture_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_ai_disposition_reviews() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_consent_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_contacts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_memberships() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_message_threads() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_properties() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_policy.capture_sms_phone_suppressions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_reply_context.capture_organization() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_reply_context.capture_property() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_reply_context.capture_sender() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_safety.consent_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_safety.suppression_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION inbox_safety.thread_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.inbox_capture_inbound_head()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NULL;
END
$$;

DO $$
DECLARE bad text;
BEGIN
  WITH expected(name, expected_md5) AS (VALUES
      ('inbox_backfill.capture_collision()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_bridge.capture_access()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_message_capture.capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_sms_scope()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_operation_domain.capture_target()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_parent()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_parent.capture_review()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_ai_disposition_reviews()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_consent_events()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_contacts()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_memberships()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_message_threads()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_properties()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_policy.capture_sms_phone_suppressions()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_organization()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_property()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_reply_context.capture_sender()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.consent_capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.suppression_capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('inbox_safety.thread_capture()', '8ab64bae8d78de0c4333d9b2820a4168'),
      ('public.inbox_capture_inbound_head()', '8ab64bae8d78de0c4333d9b2820a4168')
  )
  SELECT e.name INTO bad FROM expected e JOIN pg_proc p ON p.oid=to_regprocedure(e.name) WHERE md5(p.prosrc)<>e.expected_md5 LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_POSTCONDITION_FAILED: %', bad; END IF;
END $$;
COMMIT;
