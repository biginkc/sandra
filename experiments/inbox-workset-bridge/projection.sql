-- Owned fixture only. Narrow DTO projection; no publication is modified here.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Owned fixture required';END IF;END $$;
CREATE SCHEMA inbox_t2_bridge AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_t2_bridge.summaries(
 org_id uuid NOT NULL,target_kind text NOT NULL CHECK(target_kind IN ('known_conversation','unknown_sender')),target_id uuid NOT NULL,
 projection_revision bigint NOT NULL,source_generation bigint NOT NULL,
 name text NOT NULL,context text NOT NULL,preview text NOT NULL,time_label text NOT NULL,outcome_label text NOT NULL,assigned_label text NOT NULL,unread boolean,
 latest_at timestamptz,visible_active boolean NOT NULL,visible_dismissed boolean NOT NULL,visible_review boolean NOT NULL,visible_unread boolean NOT NULL,
 PRIMARY KEY(org_id,target_kind,target_id),CHECK(length(name)<=2000 AND length(context)<=2000 AND length(preview)<=2000)
);
CREATE INDEX summary_order ON inbox_t2_bridge.summaries(org_id,latest_at DESC,target_kind,target_id);
CREATE FUNCTION inbox_t2_bridge.project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s jsonb:=NEW.summary;unknown boolean:=NEW.target_kind='unknown_sender';
BEGIN
 IF s IS NULL OR (s->>'exists')::boolean IS DISTINCT FROM true THEN DELETE FROM inbox_t2_bridge.summaries WHERE org_id=NEW.org_id AND target_kind=NEW.target_kind AND target_id=NEW.target_id;RETURN NULL;END IF;
 INSERT INTO inbox_t2_bridge.summaries VALUES(NEW.org_id,NEW.target_kind,NEW.target_id,NEW.revision,NEW.source_generation,
 left(CASE WHEN unknown THEN coalesce(s->>'raw_sender_key','Unknown sender') ELSE coalesce(nullif(s->>'contact_name',''),s->>'thread_customer_phone','Unknown contact') END,2000),
 left(CASE WHEN unknown THEN 'Unknown sender' ELSE coalesce(s->>'property_address','No property linked') END,2000),
 left(coalesce(CASE WHEN unknown THEN s->>'latest_preview' ELSE s->>'last_message_preview' END,''),2000),
 coalesce(CASE WHEN unknown THEN s->>'latest_at' ELSE s->>'last_message_at' END,''),
 CASE WHEN unknown THEN CASE WHEN (s->>'is_dismissed')::boolean THEN 'Dismissed' ELSE 'Unknown sender' END ELSE coalesce(s->>'outreach_dispo','No outcome') END,
 CASE WHEN s->>'assigned_user_id' IS NULL THEN 'Unassigned' ELSE 'Assigned' END,
 CASE WHEN unknown THEN NULL ELSE coalesce((s->>'unread_count')::bigint,0)>0 END,
 (CASE WHEN unknown THEN s->>'latest_at' ELSE s->>'last_message_at' END)::timestamptz,
 CASE WHEN unknown THEN coalesce((s->>'visible_unknown')::boolean,false) ELSE coalesce((s->>'visible_all_hide_noise')::boolean,false) END,
 unknown AND coalesce((s->>'visible_dismissed')::boolean,false),NOT unknown AND coalesce((s->>'visible_review')::boolean,false),NOT unknown AND coalesce((s->>'visible_unread_hide_noise')::boolean,false))
 ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET projection_revision=excluded.projection_revision,source_generation=excluded.source_generation,name=excluded.name,context=excluded.context,preview=excluded.preview,time_label=excluded.time_label,outcome_label=excluded.outcome_label,assigned_label=excluded.assigned_label,unread=excluded.unread,latest_at=excluded.latest_at,visible_active=excluded.visible_active,visible_dismissed=excluded.visible_dismissed,visible_review=excluded.visible_review,visible_unread=excluded.visible_unread WHERE inbox_t2_bridge.summaries.projection_revision<excluded.projection_revision;
 RETURN NULL;
END $$;
CREATE TRIGGER bridge_projection AFTER INSERT OR UPDATE OF summary,revision ON inbox_t2_maintained.rows FOR EACH ROW EXECUTE FUNCTION inbox_t2_bridge.project();
ALTER TABLE inbox_t2_bridge.summaries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_bridge FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
