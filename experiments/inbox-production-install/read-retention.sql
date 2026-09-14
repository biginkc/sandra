-- Separate read companion addition. Never deletes operation or safety receipts.
CREATE INDEX read_boundary_retention ON inbox_read.boundaries((greatest(expires_at,execution_deadline)),id);
CREATE FUNCTION inbox_read.prune_expired_boundaries(p_row_budget integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b record;remaining integer:=p_row_budget;removed integer;children integer:=0;parents integer:=0;
 cutoff timestamptz:=clock_timestamp()-interval '7 days';
BEGIN
 IF p_row_budget IS NULL OR p_row_budget<1 OR p_row_budget>1000 THEN RAISE EXCEPTION 'Invalid read retention budget';END IF;
 -- Same parent-before-receipt order as acknowledgment. No epoch, generation or
 -- canonical row locks are acquired here, so no reverse dependency is introduced.
 -- Active calls holding a boundary lock are skipped. A worker statement timeout
 -- must bound execution in addition to this physical deletion budget.
 FOR b IN SELECT id FROM inbox_read.boundaries
  WHERE greatest(expires_at,execution_deadline)<cutoff
  ORDER BY greatest(expires_at,execution_deadline),id LIMIT least(p_row_budget,500)
  FOR UPDATE SKIP LOCKED LOOP
  WITH candidates AS (SELECT id FROM inbox_read.history_cursors WHERE boundary_id=b.id LIMIT remaining)
  DELETE FROM inbox_read.history_cursors c USING candidates d WHERE c.id=d.id;
  GET DIAGNOSTICS removed=ROW_COUNT;remaining:=remaining-removed;children:=children+removed;
  IF remaining=0 THEN EXIT;END IF;
  WITH candidates AS (SELECT boundary_id,batch FROM inbox_read.receipts WHERE boundary_id=b.id LIMIT remaining)
  DELETE FROM inbox_read.receipts c USING candidates d WHERE c.boundary_id=d.boundary_id AND c.batch=d.batch;
  GET DIAGNOSTICS removed=ROW_COUNT;remaining:=remaining-removed;children:=children+removed;
  IF remaining=0 THEN EXIT;END IF;
  IF NOT EXISTS(SELECT 1 FROM inbox_read.history_cursors WHERE boundary_id=b.id)
   AND NOT EXISTS(SELECT 1 FROM inbox_read.receipts WHERE boundary_id=b.id) THEN
   DELETE FROM inbox_read.boundaries WHERE id=b.id;parents:=parents+1;remaining:=remaining-1;
  END IF;
  IF remaining=0 THEN EXIT;END IF;
 END LOOP;
 RETURN jsonb_build_object('deleted_boundaries',parents,'deleted_children',children,'deleted_rows',p_row_budget-remaining,'row_budget',p_row_budget);
END $$;
REVOKE ALL ON FUNCTION inbox_read.prune_expired_boundaries(integer) FROM PUBLIC,anon,authenticated,service_role;
