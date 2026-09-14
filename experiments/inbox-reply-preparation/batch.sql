-- Private batch capture and current application quiet-hours policy.
-- Source map SHA256: 7a7780a583099c0bf302589e23e35595de4f133ee4606fd3dfd52869d306f340
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF; END $$;
CREATE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN zone IS NULL OR at_time IS NULL THEN jsonb_build_object('ok',false,'reason','unknown_state')
 ELSE jsonb_build_object('ok',extract(hour FROM timezone(zone,at_time))>=8 AND extract(hour FROM timezone(zone,at_time))<21,'zone',zone,'local_time',to_char(timezone(zone,at_time),'HH24:MI:SS')) END
 FROM (SELECT (SELECT z FROM (VALUES
 ('MO','America/Chicago'),
 ('OH','America/New_York'),
 ('AL','America/Chicago'),
 ('AK','America/Anchorage'),
 ('AZ','America/Phoenix'),
 ('AR','America/Chicago'),
 ('CA','America/Los_Angeles'),
 ('CO','America/Denver'),
 ('CT','America/New_York'),
 ('DE','America/New_York'),
 ('DC','America/New_York'),
 ('FL','America/New_York'),
 ('GA','America/New_York'),
 ('HI','Pacific/Honolulu'),
 ('ID','America/Boise'),
 ('IL','America/Chicago'),
 ('IN','America/Indianapolis'),
 ('IA','America/Chicago'),
 ('KS','America/Chicago'),
 ('KY','America/New_York'),
 ('LA','America/Chicago'),
 ('ME','America/New_York'),
 ('MD','America/New_York'),
 ('MA','America/New_York'),
 ('MI','America/Detroit'),
 ('MN','America/Chicago'),
 ('MS','America/Chicago'),
 ('MT','America/Denver'),
 ('NE','America/Chicago'),
 ('NV','America/Los_Angeles'),
 ('NH','America/New_York'),
 ('NJ','America/New_York'),
 ('NM','America/Denver'),
 ('NY','America/New_York'),
 ('NC','America/New_York'),
 ('ND','America/Chicago'),
 ('OK','America/Chicago'),
 ('OR','America/Los_Angeles'),
 ('PA','America/New_York'),
 ('RI','America/New_York'),
 ('SC','America/New_York'),
 ('SD','America/Chicago'),
 ('TN','America/Chicago'),
 ('TX','America/Chicago'),
 ('UT','America/Denver'),
 ('VT','America/New_York'),
 ('VA','America/New_York'),
 ('WA','America/Los_Angeles'),
 ('WV','America/New_York'),
 ('WI','America/Chicago'),
 ('WY','America/Denver'),
 ('AS','Pacific/Pago_Pago'),
 ('GU','Pacific/Guam'),
 ('MP','Pacific/Saipan'),
 ('PR','America/Puerto_Rico'),
 ('VI','America/St_Thomas')
 ) zones(s,z) WHERE s=upper(btrim(state))) zone) q
$$;
-- No caller-controlled clock on this boundary. The pure policy helper above is
-- private and allows deterministic DST/window tests; every capture uses DB time.
CREATE FUNCTION inbox_reply_preparation.batch(o uuid,ids uuid[]) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE c uuid;item jsonb;items jsonb:='[]';eligible integer;duplicates text[];
BEGIN
 IF o IS NULL OR ids IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 500 OR array_ndims(ids) IS DISTINCT FROM 1 OR EXISTS(SELECT 1 FROM unnest(ids) id WHERE id IS NULL) OR (SELECT count(DISTINCT id) FROM unnest(ids) id)<>cardinality(ids) THEN RAISE EXCEPTION 'Invalid bounded reply targets';END IF;
 FOR c IN SELECT id FROM unnest(ids) id ORDER BY id LOOP
  item:=inbox_reply_preparation.recipient(o,c)||jsonb_build_object('conversation_id',c);
  IF item->>'exclusion' IS NULL THEN item:=item||jsonb_build_object('quiet_hours',inbox_reply_preparation.quiet_hours(item->>'state',clock_timestamp()));END IF;
  items:=items||jsonb_build_array(item);
 END LOOP;
 -- Earlier recipients may expire while later source locks are awaited.
 SELECT jsonb_agg(CASE WHEN value->>'exclusion' IS NULL AND (value->>'valid_until')::timestamptz<=clock_timestamp() THEN value||jsonb_build_object('exclusion','conversation_window_expired') ELSE value END ORDER BY value->>'conversation_id') INTO items FROM jsonb_array_elements(items);
 -- A shared destination is a visible conflict on EVERY affected conversation;
 -- never silently choose the first conversation or issue multiple sends.
 SELECT array_agg(destination) INTO duplicates FROM (SELECT value->>'to' destination FROM jsonb_array_elements(items) WHERE value->>'exclusion' IS NULL GROUP BY value->>'to' HAVING count(*)>1) q;
 SELECT jsonb_agg(value||jsonb_build_object('duplicate_destination',coalesce((value->>'to')=ANY(duplicates),false)) ORDER BY value->>'conversation_id') INTO items FROM jsonb_array_elements(items);
 SELECT count(DISTINCT value->>'to') INTO eligible FROM jsonb_array_elements(items) WHERE value->>'exclusion' IS NULL;
 RETURN jsonb_build_object('items',items,'distinct_recipient_count',eligible,'over_recipient_limit',eligible>50,'has_duplicate_destinations',coalesce(cardinality(duplicates)>0,false));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_preparation FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
