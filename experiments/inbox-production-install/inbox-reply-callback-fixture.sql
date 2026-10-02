\set ON_ERROR_STOP on
-- Owned R11 callback-gate fixture packet. Runtime tooling only; never a
-- migration. It writes the reply ledger directly under one marker, never
-- calls admission or Sendillo, and removes only rows anchored by that marker.
\if :{?fixture_create}
\else
  \echo 'fixture_create is required (true or false)'
  \quit 3
\endif
\if :{?fixture_marker}
\else
  \echo 'fixture_marker is required'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
SELECT set_config('sandra.inbox_fixture_marker', :'fixture_marker', false) AS _set_fixture_marker \gset
SELECT set_config('sandra.inbox_fixture_action', :'fixture_action', false) AS _set_fixture_action \gset

DO $$
BEGIN
  IF current_setting('sandra.inbox_fixture_marker') !~ '^sandra-inbox-r1-callback-gate-[a-z0-9-]+$' THEN
    RAISE EXCEPTION 'fixture marker is not owned by the R1 callback gate';
  END IF;
  IF current_setting('sandra.inbox_fixture_action') NOT IN ('create', 'remove') THEN
    RAISE EXCEPTION 'fixture_action must be create or remove';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS inbox_reply_send;
CREATE TABLE IF NOT EXISTS inbox_reply_send.r1_callback_gate_fixtures(
 marker text PRIMARY KEY CHECK(marker ~ '^sandra-inbox-r1-callback-gate-[a-z0-9-]+$'),
 org_id uuid NOT NULL,
 requester_id uuid NOT NULL,
 preparation_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 item_a uuid NOT NULL,
 item_b uuid NOT NULL,
 contact_a uuid NOT NULL,
 contact_b uuid NOT NULL,
 reference_a text NOT NULL,
 reference_b text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

\if :fixture_create
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker = current_setting('sandra.inbox_fixture_marker')) THEN
      RAISE EXCEPTION 'callback fixture marker already exists';
    END IF;
  END $$;

  INSERT INTO inbox_reply_send.r1_callback_gate_fixtures(
    marker,org_id,requester_id,preparation_id,operation_id,item_a,item_b,contact_a,contact_b,reference_a,reference_b
  ) VALUES (
    :'fixture_marker',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
    gen_random_uuid(),gen_random_uuid(),
    'sandra-r1-callback-a-' || :'fixture_marker',
    'sandra-r1-callback-b-' || :'fixture_marker'
  );

  INSERT INTO inbox_reply_review.preparations(id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at)
  SELECT preparation_id,org_id,requester_id,gen_random_uuid(),
    encode(sha256(convert_to(marker,'utf8')),'hex'), '{}',
    jsonb_build_array(
      jsonb_build_object('id',item_a,'recipient',jsonb_build_object('contactId',contact_a,'from','+18165550001','to','+18165550002','renderedBody','R1 callback gate A'),'validUntil',clock_timestamp()+interval '1 day','state','ready','target',jsonb_build_object('id',gen_random_uuid(),'kind','conversation'),'dependencies',jsonb_build_object('head','1')),
      jsonb_build_object('id',item_b,'recipient',jsonb_build_object('contactId',contact_b,'from','+18165550001','to','+18165550003','renderedBody','R1 callback gate B'),'validUntil',clock_timestamp()+interval '1 day','state','ready','target',jsonb_build_object('id',gen_random_uuid(),'kind','conversation'),'dependencies',jsonb_build_object('head','1'))
    ),clock_timestamp()+interval '1 day'
  FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker=:'fixture_marker';

  INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key)
  SELECT org_id,operation_id,requester_id,preparation_id,gen_random_uuid()
  FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker=:'fixture_marker';

  -- The canonical INSERT guard is deliberately disabled only around these two
  -- owned fixture rows: their provider_accepted state represents the already
  -- persisted post-send boundary required by R11. DDL is transactional and the
  -- guard is restored before commit.
  ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
  INSERT INTO inbox_reply_send.attempts(
    org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state,generation,lease_until,dispatch_started_at,dispatch_token,receipt_version,provider_reference,provider_status,evidence
  )
  SELECT f.org_id,gen_random_uuid(),f.operation_id,f.preparation_id,f.item_a,1,NULL,f.contact_a,'+18165550001','+18165550002',
    encode(sha256(convert_to('R1 callback gate A','utf8')||decode('00','hex')||convert_to('+18165550001','utf8')||decode('00','hex')||convert_to('+18165550002','utf8')),'hex'),
    'provider_accepted',1,NULL,clock_timestamp()-interval '1 minute',gen_random_uuid(),1,f.reference_a,'sent','sandra_r1_callback_gate'
  FROM inbox_reply_send.r1_callback_gate_fixtures f WHERE f.marker=:'fixture_marker';
  INSERT INTO inbox_reply_send.attempts(
    org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state,generation,lease_until,dispatch_started_at,dispatch_token,receipt_version,provider_reference,provider_status,evidence
  )
  SELECT f.org_id,gen_random_uuid(),f.operation_id,f.preparation_id,f.item_b,1,NULL,f.contact_b,'+18165550001','+18165550003',
    encode(sha256(convert_to('R1 callback gate B','utf8')||decode('00','hex')||convert_to('+18165550001','utf8')||decode('00','hex')||convert_to('+18165550003','utf8')),'hex'),
    'provider_accepted',1,NULL,clock_timestamp()-interval '1 minute',gen_random_uuid(),1,f.reference_b,'sent','sandra_r1_callback_gate'
  FROM inbox_reply_send.r1_callback_gate_fixtures f WHERE f.marker=:'fixture_marker';
  ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;

  INSERT INTO inbox_reply_send.unmatched_callbacks(provider,provider_reference,terminal_status,payload)
  SELECT 'sendillo',reference_b,'delivered',jsonb_build_object('__sandra_fixture_marker',marker,'fixture','r1_callback_gate')
  FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker=:'fixture_marker';
\else
  -- Delete only IDs and provider references read from the owned marker row.
  -- Admission, callback processing, and provider tables are not consulted.
  ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
  DELETE FROM inbox_reply_send.unmatched_callbacks u
  USING inbox_reply_send.r1_callback_gate_fixtures f
  WHERE f.marker=:'fixture_marker' AND u.provider='sendillo'
    AND u.provider_reference IN (f.reference_a,f.reference_b)
    AND u.payload->>'__sandra_fixture_marker'=f.marker;
  DELETE FROM inbox_reply_send.attempts a
  USING inbox_reply_send.r1_callback_gate_fixtures f
  WHERE f.marker=:'fixture_marker' AND a.org_id=f.org_id AND a.operation_id=f.operation_id
    AND a.preparation_id=f.preparation_id AND a.item_id IN (f.item_a,f.item_b);
  ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;
  ALTER TABLE inbox_reply_send.operations DISABLE TRIGGER immutable_reply_send_operation;
  DELETE FROM inbox_reply_send.operations o
  USING inbox_reply_send.r1_callback_gate_fixtures f
  WHERE f.marker=:'fixture_marker' AND o.org_id=f.org_id AND o.id=f.operation_id AND o.preparation_id=f.preparation_id;
  ALTER TABLE inbox_reply_send.operations ENABLE TRIGGER immutable_reply_send_operation;
  ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
  DELETE FROM inbox_reply_review.preparations p
  USING inbox_reply_send.r1_callback_gate_fixtures f
  WHERE f.marker=:'fixture_marker' AND p.org_id=f.org_id AND p.id=f.preparation_id;
  ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
  DELETE FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker=:'fixture_marker';
\endif

COMMIT;
