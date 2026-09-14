-- Owned candidate only: explicit default-closed RPC admission. No send endpoint.
BEGIN;
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;
CREATE TABLE inbox_reply_review.admission(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false);
INSERT INTO inbox_reply_review.admission(singleton) VALUES(true);
ALTER TABLE inbox_reply_review.admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_reply_review.preparations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_reply_review.admission FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_reply_review.require_admission() RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE admitted boolean;
BEGIN
 SELECT enabled INTO admitted FROM inbox_reply_review.admission WHERE singleton FOR SHARE;
 IF admitted IS DISTINCT FROM true THEN RAISE EXCEPTION 'INBOX_REPLIES_NOT_ENABLED' USING ERRCODE='55000';END IF;
END $$;
CREATE FUNCTION public.inbox_capture_reply_recipients(conversation_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.capture(conversation_ids);
END $$;
CREATE FUNCTION public.inbox_freeze_reply_review(canonical_input text,idempotency_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.freeze(canonical_input,idempotency_key);
END $$;
REVOKE ALL ON FUNCTION inbox_reply_review.require_admission() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid) TO authenticated;
COMMIT;
