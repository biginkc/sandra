\set ON_ERROR_STOP on
-- Owned R11 callback-gate fixture packet. Runtime tooling only; never a
-- migration. The marker -> ID mapping lives in the caller's local 0600
-- receipt. This packet never creates a schema object and never discovers a
-- row by a broad marker-only predicate.
--
-- RULING R11-1/R11-2: trigger disable is approved only under the conditions
-- enforced below. The trigger disable is retained because this fixture
-- represents an already-persisted provider_accepted row and removal must
-- delete immutable ledger rows. Each disable/enable pair is inside this one
-- transaction and is restored before COMMIT.
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
\if :{?fixture_org_id}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_requester_id}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_preparation_id}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_operation_id}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_idempotency_key}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_item_a}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_item_b}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_attempt_a}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_attempt_b}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_contact_a}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_contact_b}
\else
  \echo 'fixture receipt IDs are required'
  \quit 3
\endif
\if :{?fixture_reference_a}
\else
  \echo 'fixture receipt references are required'
  \quit 3
\endif
\if :{?fixture_reference_b}
\else
  \echo 'fixture receipt references are required'
  \quit 3
\endif
\if :{?fixture_action}
\else
  \set fixture_action remove
\endif

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';
SELECT set_config('sandra.inbox_fixture_marker', :'fixture_marker', true),
       set_config('sandra.inbox_fixture_action', :'fixture_action', true),
       set_config('sandra.inbox_fixture_org_id', :'fixture_org_id', true),
       set_config('sandra.inbox_fixture_requester_id', :'fixture_requester_id', true),
       set_config('sandra.inbox_fixture_preparation_id', :'fixture_preparation_id', true),
       set_config('sandra.inbox_fixture_operation_id', :'fixture_operation_id', true),
       set_config('sandra.inbox_fixture_idempotency_key', :'fixture_idempotency_key', true),
       set_config('sandra.inbox_fixture_item_a', :'fixture_item_a', true),
       set_config('sandra.inbox_fixture_item_b', :'fixture_item_b', true),
       set_config('sandra.inbox_fixture_attempt_a', :'fixture_attempt_a', true),
       set_config('sandra.inbox_fixture_attempt_b', :'fixture_attempt_b', true),
       set_config('sandra.inbox_fixture_contact_a', :'fixture_contact_a', true),
       set_config('sandra.inbox_fixture_contact_b', :'fixture_contact_b', true),
       set_config('sandra.inbox_fixture_reference_a', :'fixture_reference_a', true),
       set_config('sandra.inbox_fixture_reference_b', :'fixture_reference_b', true)
;

DO $$
DECLARE name text;
BEGIN
  IF current_setting('sandra.inbox_fixture_marker') !~ '^sandra-inbox-r1-callback-gate-[a-z0-9-]+$' THEN
    RAISE EXCEPTION 'fixture marker is not owned by the R1 callback gate';
  END IF;
  IF current_setting('sandra.inbox_fixture_action') NOT IN ('create', 'remove') THEN
    RAISE EXCEPTION 'fixture_action must be create or remove';
  END IF;
  FOREACH name IN ARRAY ARRAY[
    'sandra.inbox_fixture_org_id','sandra.inbox_fixture_requester_id',
    'sandra.inbox_fixture_preparation_id','sandra.inbox_fixture_operation_id',
    'sandra.inbox_fixture_idempotency_key','sandra.inbox_fixture_item_a',
    'sandra.inbox_fixture_item_b','sandra.inbox_fixture_attempt_a',
    'sandra.inbox_fixture_attempt_b','sandra.inbox_fixture_contact_a',
    'sandra.inbox_fixture_contact_b'
  ] LOOP
    IF current_setting(name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'fixture receipt contains an invalid UUID: %', name;
    END IF;
  END LOOP;
  IF current_setting('sandra.inbox_fixture_reference_a') !~ '^sandra-r1-callback-a-[a-z0-9-]+$'
     OR current_setting('sandra.inbox_fixture_reference_b') !~ '^sandra-r1-callback-b-[a-z0-9-]+$' THEN
    RAISE EXCEPTION 'fixture receipt contains an invalid provider reference';
  END IF;
END $$;

-- R11-2 precondition: do not create or remove this live-ledger fixture while
-- reply admission is open and a reply worker has a database session. A
-- disabled admission row is sufficient; otherwise every deployed reply
-- worker must be absent. This check is before any trigger disable or fixture
-- write.
DO $$
DECLARE
  admission_enabled boolean;
BEGIN
  SELECT enabled INTO admission_enabled
  FROM inbox_reply_review.admission
  WHERE singleton
  FOR SHARE;
  IF admission_enabled IS NULL THEN
    RAISE EXCEPTION 'R11 admission precondition row is missing';
  END IF;
  IF admission_enabled THEN
    RAISE EXCEPTION 'R11 requires reply admission disabled or reply workers absent';
  END IF;
END $$;

\if :fixture_create
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM inbox_reply_send.attempts
      WHERE org_id=current_setting('sandra.inbox_fixture_org_id')::uuid
         OR id IN (current_setting('sandra.inbox_fixture_attempt_a')::uuid,current_setting('sandra.inbox_fixture_attempt_b')::uuid)
         OR provider_reference IN (current_setting('sandra.inbox_fixture_reference_a'),current_setting('sandra.inbox_fixture_reference_b'))
    ) THEN
      RAISE EXCEPTION 'callback fixture receipt IDs or references already exist';
    END IF;
  END $$;

  INSERT INTO inbox_reply_review.preparations(
    id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at
  ) VALUES (
    current_setting('sandra.inbox_fixture_preparation_id')::uuid,
    current_setting('sandra.inbox_fixture_org_id')::uuid,
    current_setting('sandra.inbox_fixture_requester_id')::uuid,
    current_setting('sandra.inbox_fixture_idempotency_key')::uuid,
    encode(sha256(convert_to(current_setting('sandra.inbox_fixture_marker'),'utf8')),'hex'),
    '{}',
    jsonb_build_array(
      jsonb_build_object(
        'id',current_setting('sandra.inbox_fixture_item_a')::uuid,
        'recipient',jsonb_build_object('contactId',current_setting('sandra.inbox_fixture_contact_a')::uuid,'from','+18165550001','to','+18165550002','renderedBody','R1 callback gate A'),
        'validUntil',clock_timestamp()+interval '1 day','state','ready',
        'target',jsonb_build_object('id',gen_random_uuid(),'kind','conversation'),
        'dependencies',jsonb_build_object('head','1')
      ),
      jsonb_build_object(
        'id',current_setting('sandra.inbox_fixture_item_b')::uuid,
        'recipient',jsonb_build_object('contactId',current_setting('sandra.inbox_fixture_contact_b')::uuid,'from','+18165550001','to','+18165550003','renderedBody','R1 callback gate B'),
        'validUntil',clock_timestamp()+interval '1 day','state','ready',
        'target',jsonb_build_object('id',gen_random_uuid(),'kind','conversation'),
        'dependencies',jsonb_build_object('head','1')
      )
    ),
    clock_timestamp()+interval '1 day'
  );

  INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key)
  VALUES (
    current_setting('sandra.inbox_fixture_org_id')::uuid,
    current_setting('sandra.inbox_fixture_operation_id')::uuid,
    current_setting('sandra.inbox_fixture_requester_id')::uuid,
    current_setting('sandra.inbox_fixture_preparation_id')::uuid,
    current_setting('sandra.inbox_fixture_idempotency_key')::uuid
  );

  -- The canonical INSERT guard is deliberately disabled only around these
  -- two receipt-owned rows: provider_accepted is the already-persisted
  -- post-send boundary required by R11.
  ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
  INSERT INTO inbox_reply_send.attempts(
    org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,
    contact_id,from_e164,to_e164,body_hash,state,generation,lease_until,
    dispatch_started_at,dispatch_token,receipt_version,provider_reference,
    provider_status,evidence
  ) VALUES
  (
    current_setting('sandra.inbox_fixture_org_id')::uuid,
    current_setting('sandra.inbox_fixture_attempt_a')::uuid,
    current_setting('sandra.inbox_fixture_operation_id')::uuid,
    current_setting('sandra.inbox_fixture_preparation_id')::uuid,
    current_setting('sandra.inbox_fixture_item_a')::uuid,1,NULL,
    current_setting('sandra.inbox_fixture_contact_a')::uuid,'+18165550001','+18165550002',
    encode(sha256(convert_to('R1 callback gate A','utf8')||decode('00','hex')||convert_to('+18165550001','utf8')||decode('00','hex')||convert_to('+18165550002','utf8')),'hex'),
    'provider_accepted',1,NULL,clock_timestamp()-interval '1 minute',gen_random_uuid(),1,
    current_setting('sandra.inbox_fixture_reference_a'),'sent','sandra_r1_callback_gate'
  ),
  (
    current_setting('sandra.inbox_fixture_org_id')::uuid,
    current_setting('sandra.inbox_fixture_attempt_b')::uuid,
    current_setting('sandra.inbox_fixture_operation_id')::uuid,
    current_setting('sandra.inbox_fixture_preparation_id')::uuid,
    current_setting('sandra.inbox_fixture_item_b')::uuid,1,NULL,
    current_setting('sandra.inbox_fixture_contact_b')::uuid,'+18165550001','+18165550003',
    encode(sha256(convert_to('R1 callback gate B','utf8')||decode('00','hex')||convert_to('+18165550001','utf8')||decode('00','hex')||convert_to('+18165550003','utf8')),'hex'),
    'provider_accepted',1,NULL,clock_timestamp()-interval '1 minute',gen_random_uuid(),1,
    current_setting('sandra.inbox_fixture_reference_b'),'sent','sandra_r1_callback_gate'
  );
  ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;

  INSERT INTO inbox_reply_send.unmatched_callbacks(provider,provider_reference,terminal_status,payload)
  VALUES (
    'sendillo',current_setting('sandra.inbox_fixture_reference_b'),'delivered',
    jsonb_build_object('__sandra_fixture_marker',current_setting('sandra.inbox_fixture_marker'),'fixture','r1_callback_gate')
  );
\else
  -- Remove only IDs, references, and marker payloads from the receipt. The
  -- receipt itself is never written to the database and is deleted by the
  -- caller after this command succeeds.
  DELETE FROM inbox_reply_send.callback_receipts
  WHERE provider='sendillo'
    AND event_type IN ('inbox_reply_status_delivered','inbox_reply_status_delivery_failed')
    AND external_id IN (current_setting('sandra.inbox_fixture_reference_a'),current_setting('sandra.inbox_fixture_reference_b'))
    AND org_id=current_setting('sandra.inbox_fixture_org_id')::uuid;
  DELETE FROM inbox_reply_send.unmatched_callbacks
  WHERE provider='sendillo'
    AND provider_reference=current_setting('sandra.inbox_fixture_reference_b')
    AND payload->>'__sandra_fixture_marker'=current_setting('sandra.inbox_fixture_marker');

  ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
  DELETE FROM inbox_reply_send.attempts
  WHERE org_id=current_setting('sandra.inbox_fixture_org_id')::uuid
    AND id IN (current_setting('sandra.inbox_fixture_attempt_a')::uuid,current_setting('sandra.inbox_fixture_attempt_b')::uuid)
    AND operation_id=current_setting('sandra.inbox_fixture_operation_id')::uuid
    AND preparation_id=current_setting('sandra.inbox_fixture_preparation_id')::uuid;
  ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;

  ALTER TABLE inbox_reply_send.operations DISABLE TRIGGER immutable_reply_send_operation;
  DELETE FROM inbox_reply_send.operations
  WHERE org_id=current_setting('sandra.inbox_fixture_org_id')::uuid
    AND id=current_setting('sandra.inbox_fixture_operation_id')::uuid
    AND preparation_id=current_setting('sandra.inbox_fixture_preparation_id')::uuid;
  ALTER TABLE inbox_reply_send.operations ENABLE TRIGGER immutable_reply_send_operation;

  ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
  DELETE FROM inbox_reply_review.preparations
  WHERE org_id=current_setting('sandra.inbox_fixture_org_id')::uuid
    AND id=current_setting('sandra.inbox_fixture_preparation_id')::uuid;
  ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
\endif

COMMIT;
