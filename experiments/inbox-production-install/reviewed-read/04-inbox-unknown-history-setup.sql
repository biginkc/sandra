-- Owned fixture candidate; production requires the reviewed migration path.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(
 SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic'
) THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE TABLE inbox_t2_read.unknown_history_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,
 sender_group_id uuid NOT NULL,requester_id uuid NOT NULL,session_id uuid NOT NULL,
 access_epoch bigint NOT NULL,expires_at timestamptz NOT NULL,
 before_at timestamptz NOT NULL,before_id uuid NOT NULL
);
ALTER TABLE inbox_t2_read.unknown_history_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_t2_read.unknown_history_cursors FROM PUBLIC,anon,authenticated,service_role;
-- Hash narrows the index only. Exact raw text equality below is authoritative.
-- The release companion must create this index CONCURRENTLY outside its transaction.
CREATE INDEX inbox_unknown_history_page ON public.messages(org_id,md5(from_address),created_at DESC,id DESC) WHERE channel='sms';
CREATE FUNCTION inbox_t2_read.unknown_history_values(o uuid,g uuid,at_time timestamptz,before_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH sender AS MATERIALIZED (
  SELECT raw_sender FROM inbox_t2_message_capture.sender_groups WHERE org_id=o AND sender_group_id=g
 ), eligible AS MATERIALIZED (
  SELECT raw_sender FROM sender WHERE EXISTS(SELECT 1 FROM public.messages m WHERE m.org_id=o AND m.channel='sms'
   AND md5(m.from_address)=md5(sender.raw_sender) AND m.from_address COLLATE "C"=sender.raw_sender COLLATE "C"
   AND m.direction='inbound' AND m.contact_id IS NULL)
 ), page AS MATERIALIZED (
  SELECT m.id,m.created_at,m.body,m.direction,m.dismissed_at FROM public.messages m JOIN eligible s
   ON md5(m.from_address)=md5(s.raw_sender) AND m.from_address COLLATE "C"=s.raw_sender COLLATE "C"
  WHERE m.org_id=o AND m.channel='sms' AND (at_time IS NULL OR (m.created_at,m.id)<(at_time,before_id))
  ORDER BY m.created_at DESC,m.id DESC LIMIT 50
 ) SELECT jsonb_build_object('exists',EXISTS(SELECT 1 FROM eligible),'raw_sender',(SELECT raw_sender FROM eligible),
  'history',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'created_at_raw',created_at::text,'body',body,
   'direction',direction,'dismissed_at_raw',dismissed_at::text) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb))
$$;
CREATE FUNCTION inbox_t2_read.unknown_history_page(o uuid,g uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a jsonb; result jsonb; position inbox_t2_read.unknown_history_cursors;
 expires timestamptz:=clock_timestamp()+interval '5 minutes';last_message jsonb;next_cursor uuid;
BEGIN
 a:=inbox_t2_bridge.authorize(o);
 PERFORM 1 FROM inbox_t2_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR SHARE;
 a:=inbox_t2_bridge.authorize(o);
 IF before_cursor IS NOT NULL THEN
  SELECT * INTO position FROM inbox_t2_read.unknown_history_cursors WHERE id=before_cursor;
  IF NOT FOUND OR position.org_id IS DISTINCT FROM o OR position.sender_group_id IS DISTINCT FROM g
   OR position.requester_id IS DISTINCT FROM (a->>'user_id')::uuid OR position.session_id IS DISTINCT FROM (a->>'session_id')::uuid
   OR position.access_epoch IS DISTINCT FROM (a->>'access_epoch')::bigint THEN
   RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
  expires:=position.expires_at;
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 END IF;
 result:=inbox_t2_read.unknown_history_values(o,g,position.before_at,position.before_id);
 IF result->>'exists' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'INBOX_READ_NOT_FOUND' USING ERRCODE='42501';END IF;
 IF jsonb_array_length(result->'history')=50 THEN
  last_message:=result->'history'->49;
  INSERT INTO inbox_t2_read.unknown_history_cursors(org_id,sender_group_id,requester_id,session_id,access_epoch,expires_at,before_at,before_id)
   VALUES(o,g,(a->>'user_id')::uuid,(a->>'session_id')::uuid,(a->>'access_epoch')::bigint,expires,
    (last_message->>'created_at_raw')::timestamptz,(last_message->>'id')::uuid) RETURNING id INTO next_cursor;
 END IF;
 PERFORM inbox_t2_bridge.authorize(o);
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'INBOX_READ_EXPIRED' USING ERRCODE='55000';END IF;
 RETURN (result-'exists')||jsonb_build_object('requester_id',a->>'user_id','org_id',o,'sender_group_id',g,'next_cursor',next_cursor,'expires_at',expires);
END $$;
REVOKE ALL ON FUNCTION inbox_t2_read.unknown_history_values(uuid,uuid,timestamptz,uuid),inbox_t2_read.unknown_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.inbox_unknown_history_page(org_id uuid,sender_group_id uuid,before_cursor uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_t2_read.unknown_history_page(org_id,sender_group_id,before_cursor) $$;
REVOKE ALL ON FUNCTION public.inbox_unknown_history_page(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_unknown_history_page(uuid,uuid,uuid) TO authenticated;
COMMIT;
