-- Isolated fixture candidate only; not a production migration.
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
DO $$ BEGIN
 IF current_user <> 'postgres' OR current_database()<>'postgres' OR
 NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN
 RAISE EXCEPTION 'Owned canonical fixture required'; END IF;
END $$;
CREATE SCHEMA inbox_t2_authenticated_detail AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_authenticated_detail FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA inbox_t2_authenticated_detail TO authenticated;
CREATE FUNCTION inbox_t2_authenticated_detail.detail(p_org uuid,p_conversation uuid,p_before timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE visible_orgs uuid[]; requester uuid:=auth.uid(); result jsonb;
BEGIN
 IF requester IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
  RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF p_org IS NULL OR p_conversation IS NULL OR ((p_before IS NULL) <> (p_before_id IS NULL)) THEN
  RAISE EXCEPTION 'INBOX_INVALID_ARGUMENT' USING ERRCODE='22023';
 END IF;
 -- Do not invoke resolve_sms_conversation_org from a postgres definer: its
 -- current_user branch would bypass the requester check. Match visible-org
 -- ambiguity semantics with explicit actual Hugo lifecycle predicates.
 SELECT array_agg(m.org_id ORDER BY m.org_id) INTO visible_orgs
 FROM public.memberships m
 WHERE m.user_id=requester AND m.access_status='active'
 AND m.deletion_prepared_at IS NULL
 AND (m.access_expires_at IS NULL OR m.access_expires_at>statement_timestamp())
 AND EXISTS(SELECT 1 FROM public.messages x WHERE x.org_id=m.org_id
  AND x.conversation_id=p_conversation AND x.channel='sms');
 IF coalesce(cardinality(visible_orgs),0)>1 THEN
  RAISE EXCEPTION 'SMS_CONVERSATION_ORG_AMBIGUOUS' USING ERRCODE='P0001';
 END IF;
 IF coalesce(cardinality(visible_orgs),0)<>1 OR visible_orgs[1] IS DISTINCT FROM p_org THEN
  RAISE EXCEPTION 'INBOX_ACCESS_DENIED' USING ERRCODE='42501';
 END IF;
 -- A STABLE routine uses its caller statement's snapshot for internal reads.
 -- Head, covered keys, primary-key bodies and ordered JSON are also explicitly
 -- composed in one statement. No read acknowledgment or source writes occur.
 WITH head AS MATERIALIZED (
  SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads
   WHERE org_id=p_org AND conversation_id=p_conversation),0)::text AS revision
 ), page AS MATERIALIZED (
  SELECT id,created_at FROM public.messages WHERE org_id=p_org
  AND conversation_id=p_conversation AND channel='sms'
  AND (p_before IS NULL OR (created_at,id)<(p_before,p_before_id))
  ORDER BY created_at DESC,id DESC LIMIT 50
 ), bodies AS (
  SELECT m.id,p.created_at,m.body,m.direction,m.read_at,m.inbox_inbound_revision
  FROM page p JOIN public.messages m ON m.id=p.id AND m.org_id=p_org
   AND m.conversation_id=p_conversation AND m.channel='sms'
 ) SELECT jsonb_build_object('requester_id',requester,'org_id',p_org,
  'conversation_id',p_conversation,'head_revision',(SELECT revision FROM head),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',b.id,
   'created_at_raw',b.created_at::text,'body',b.body,'direction',b.direction,
   'read_at_raw',b.read_at::text,'inbound_revision',b.inbox_inbound_revision::text)
   ORDER BY b.created_at DESC,b.id DESC) FROM bodies b),'[]'::jsonb)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_authenticated_detail FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION inbox_t2_authenticated_detail.detail(uuid,uuid,timestamptz,uuid) TO authenticated;
COMMIT;
