-- Private worker boundary. No browser grants and no provider calls.
BEGIN;
ALTER TABLE inbox_operations.dispatch_outbox ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX inbox_operations_pending_dispatch ON inbox_operations.dispatch_outbox(created_at,event_id) WHERE acknowledged_at IS NULL;
ALTER TABLE inbox_operations.steps DROP CONSTRAINT steps_state_check;
ALTER TABLE inbox_operations.steps ADD CONSTRAINT steps_state_check CHECK(state IN('pending','running','succeeded','failed','conflicted','cancelled','blocked'));
CREATE OR REPLACE FUNCTION inbox_operations.claim_step(o uuid,op uuid,s uuid,seconds integer DEFAULT 30) RETURNS bigint LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_operations.steps;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND OR row.state NOT IN('pending','running') OR (row.state='running' AND row.lease_until>clock_timestamp()) THEN RETURN NULL;END IF;
 IF row.predecessor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=row.predecessor_id AND state='succeeded') THEN RETURN NULL;END IF;
 UPDATE inbox_operations.steps SET state='running',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND operation_id=op AND id=s RETURNING generation INTO row.generation;
 RETURN row.generation;
END $$;
CREATE FUNCTION inbox_action_api.fail_step(o uuid,op uuid,s uuid,g bigint,terminal_state text,code text) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v bigint;result jsonb;child inbox_operations.steps;
BEGIN
 IF terminal_state NOT IN('failed','conflicted','blocked') OR code IS NULL OR code !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Invalid terminal failure';END IF;
 PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
 result:=jsonb_build_object('status',terminal_state,'code',code,'changed',false);
 UPDATE inbox_operations.steps SET state=terminal_state,lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=s RETURNING receipt_version INTO v;
 INSERT INTO inbox_operations.receipts VALUES(o,op,s,v,g,result,clock_timestamp());
 -- A failed prerequisite permanently blocks its remaining same-effect steps.
 -- They cannot be running: claim_step requires the prerequisite's success.
 FOR child IN SELECT st.* FROM inbox_operations.steps st JOIN inbox_operations.steps failed ON failed.org_id=st.org_id AND failed.operation_id=st.operation_id AND failed.effect_key=st.effect_key WHERE failed.org_id=o AND failed.operation_id=op AND failed.id=s AND st.ordinal>failed.ordinal ORDER BY st.ordinal FOR UPDATE OF st LOOP
  IF child.state<>'pending' THEN RAISE EXCEPTION 'Invalid successor state';END IF;
  UPDATE inbox_operations.steps SET state='blocked',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=child.id RETURNING receipt_version INTO v;
  INSERT INTO inbox_operations.receipts VALUES(o,op,child.id,v,child.generation,jsonb_build_object('status','blocked','code','predecessor_failed','predecessor_id',s,'changed',false),clock_timestamp());
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION inbox_action_api.execute_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE result jsonb;message text;terminal_state text;code text;
BEGIN
 -- Keep the claim lock outside the rollback scope. A caught business failure
 -- rolls back every canonical write, then commits a durable failure receipt.
 PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
 BEGIN
  result:=inbox_operation_domain.apply_property_step(o,op,s,g);
  RETURN result;
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  CASE message
   WHEN 'Requester membership ambiguous or missing' THEN terminal_state:='blocked';code:='requester_access_unavailable';
   WHEN 'Requester access revoked' THEN terminal_state:='blocked';code:='requester_access_revoked';
   WHEN 'Access expired during effect' THEN terminal_state:='blocked';code:='access_expired';
   WHEN 'Assignee unavailable' THEN terminal_state:='conflicted';code:='assignee_unavailable';
   WHEN 'Property ineligible' THEN terminal_state:='conflicted';code:='property_ineligible';
   WHEN 'Target resolution changed' THEN terminal_state:='conflicted';code:='target_changed';
   WHEN 'Target resolution expired' THEN terminal_state:='conflicted';code:='target_expired';
   WHEN 'Canonical target property changed' THEN terminal_state:='conflicted';code:='target_changed';
   WHEN 'Dependency conflict' THEN terminal_state:='conflicted';code:='record_changed';
   WHEN 'SMS policy conflict' THEN terminal_state:='conflicted';code:='sms_policy_changed';
   WHEN 'SMS scope changed or unseeded' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS scope contact changed' THEN terminal_state:='conflicted';code:='sms_contact_changed';
   WHEN 'SMS scope membership changed' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS contact missing' THEN terminal_state:='conflicted';code:='sms_contact_unavailable';
   WHEN 'SMS property scope exceeds bound or changed' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS enrollment scope exceeds bound' THEN terminal_state:='blocked';code:='sms_scope_too_large';
   WHEN 'permanent_dnc_not_enabled' THEN terminal_state:='blocked';code:='permanent_dnc_not_enabled';
   ELSE RAISE; -- Invariant/software faults are not disguised as business denials.
  END CASE;
 END;
 RETURN inbox_action_api.fail_step(o,op,s,g,terminal_state,code);
 -- 40P01/40001 and other infrastructure failures escape the whole RPC. The
 -- durable runner retries/reconciles the same claim; no ambiguous failure receipt.
END $$;
-- Internal durable runner primitive. Repeated delivery reads the committed
-- receipt; claiming and applying are one transaction, with no browser lifetime.
CREATE FUNCTION inbox_action_api.run_step(o uuid,op uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row inbox_operations.steps;g bigint;result jsonb;
BEGIN
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_WORKER_STEP_UNAVAILABLE';END IF;
 IF row.state NOT IN('pending','running') THEN
  SELECT r.result INTO STRICT result FROM inbox_operations.receipts r WHERE r.org_id=o AND r.operation_id=op AND r.step_id=s;
  RETURN jsonb_build_object('step_id',s,'state',row.state,'receipt',result);
 END IF;
 g:=inbox_operations.claim_step(o,op,s,60);
 IF g IS NULL THEN RAISE EXCEPTION 'INBOX_WORKER_STEP_BUSY' USING ERRCODE='55P03';END IF;
 result:=inbox_action_api.execute_step(o,op,s,g);
 SELECT state INTO STRICT row.state FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s;
 RETURN jsonb_build_object('step_id',s,'state',row.state,'receipt',result);
END $$;
CREATE FUNCTION inbox_action_api.load_operation(o uuid,op uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('org_id',p.org_id,'operation_id',p.id,'steps',(SELECT jsonb_agg(s.id ORDER BY s.effect_key,s.ordinal) FROM inbox_operations.steps s WHERE s.org_id=p.org_id AND s.operation_id=p.id)) FROM inbox_operations.operations p WHERE p.org_id=o AND p.id=op
$$;
-- The outbox event ID is the durable-engine idempotency key. A dispatcher only
-- acknowledges after the engine accepts the invocation durably. Lost responses
-- leave the lease to expire and redeliver the same immutable event identity.
CREATE FUNCTION inbox_action_api.claim_dispatch_batch(batch_size integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid dispatch bound';END IF;
 WITH candidates AS(SELECT d.org_id,d.operation_id FROM inbox_operations.dispatch_outbox d WHERE d.acknowledged_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp()) ORDER BY d.created_at,d.event_id LIMIT batch_size FOR UPDATE SKIP LOCKED), claimed AS(
  UPDATE inbox_operations.dispatch_outbox d SET generation=d.generation+1,lease_until=clock_timestamp()+interval '30 seconds' FROM candidates c WHERE d.org_id=c.org_id AND d.operation_id=c.operation_id RETURNING d.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('org_id',org_id,'operation_id',operation_id,'event_id',event_id,'generation',generation::text) ORDER BY event_id),'[]') INTO result FROM claimed;
 RETURN result;
END $$;
CREATE FUNCTION inbox_action_api.ack_dispatch(o uuid,op uuid,g bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_operations.ack_dispatch(o,op,g) $$;
CREATE FUNCTION inbox_action_api.worker_readiness() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ready boolean;
BEGIN
 IF to_regclass('inbox_control.baseline_progress') IS NULL THEN RETURN false;END IF;
 EXECUTE 'SELECT coalesce(bool_and(stage=''done''),false) FROM inbox_control.baseline_progress' INTO ready;
 RETURN ready;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
