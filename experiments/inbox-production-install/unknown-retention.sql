CREATE INDEX unknown_history_retention ON inbox_read.unknown_history_cursors(expires_at,id);
CREATE FUNCTION inbox_read.prune_expired_unknown_cursors(p_row_budget integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE removed integer;cutoff timestamptz:=clock_timestamp()-interval '7 days';
BEGIN
 IF p_row_budget IS NULL OR p_row_budget<1 OR p_row_budget>1000 THEN RAISE EXCEPTION 'Invalid unknown retention budget';END IF;
 WITH candidates AS (SELECT id FROM inbox_read.unknown_history_cursors WHERE expires_at<cutoff ORDER BY expires_at,id LIMIT p_row_budget FOR UPDATE SKIP LOCKED)
 DELETE FROM inbox_read.unknown_history_cursors c USING candidates d WHERE c.id=d.id;
 GET DIAGNOSTICS removed=ROW_COUNT;RETURN removed;
END $$;
REVOKE ALL ON FUNCTION inbox_read.prune_expired_unknown_cursors(integer) FROM PUBLIC,anon,authenticated,service_role;
