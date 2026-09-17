-- Lane 1 PR-E: public SECURITY DEFINER wrappers for accept/recover/status.
-- Mirrors experiments/inbox-reply-review/public-api.sql's idiom exactly:
-- identity (org_id/user_id) is derived from the caller's JWT/session via
-- inbox_action_api.authorize(NULL), never accepted as a caller-supplied
-- parameter. Gated on inbox_reply_review.require_admission() (the SAME
-- switch PR-D's claim()/start_dispatch() already gate on), so accept/
-- recover stay inert while admission is closed — identical to the flag
-- being off entirely.
BEGIN;
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;

CREATE FUNCTION public.inbox_accept_reply(preparation_id uuid,idempotency_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 RETURN inbox_reply_send.accept((a->>'org_id')::uuid,(a->>'user_id')::uuid,idempotency_key,preparation_id);
END $$;

CREATE FUNCTION public.inbox_recover_reply(preparation_id uuid,idempotency_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 RETURN inbox_reply_send.recover((a->>'org_id')::uuid,(a->>'user_id')::uuid,idempotency_key,preparation_id);
END $$;

-- Deliberately NOT admission-gated (matches inbox_operation_status /
-- start_dispatch/persist's own not-gated read/reconcile paths): an
-- operation already accepted must remain readable by its own requester even
-- if admission is later flipped closed, so status never drifts from what
-- accept() already committed.
CREATE FUNCTION public.inbox_reply_operation_status(operation_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 -- Org-scoped (like inbox_operation_status), not requester-scoped: any
 -- currently-authorized member of the operation's own org may read status,
 -- matching the metadata lane's status endpoint. inbox_reply_send.operation_status
 -- itself raises INBOX_REPLY_OPERATION_UNAVAILABLE (42501) for any
 -- operation not in this org.
 RETURN inbox_reply_send.operation_status((a->>'org_id')::uuid,operation_id);
END $$;

REVOKE ALL ON FUNCTION public.inbox_accept_reply(uuid,uuid),public.inbox_recover_reply(uuid,uuid),public.inbox_reply_operation_status(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_accept_reply(uuid,uuid),public.inbox_recover_reply(uuid,uuid),public.inbox_reply_operation_status(uuid) TO authenticated;
COMMIT;
