-- Authenticated wrappers carry identity through verified JWT/session authority;
-- callers never supply requester, eligibility or captured version claims.
BEGIN;
CREATE FUNCTION public.inbox_prepare_action(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_action_api.prepare(canonical_input,idempotency_key)
$$;
CREATE FUNCTION public.inbox_accept_action(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_action_api.accept(preparation_id,idempotency_key)
$$;
CREATE FUNCTION public.inbox_operation_status(operation_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
 SELECT inbox_action_api.status(operation_id)
$$;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_operation_status(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_operation_status(uuid) TO authenticated;
COMMIT;
