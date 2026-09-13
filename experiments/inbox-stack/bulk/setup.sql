DO $$ BEGIN
 IF current_database() <> 'sandra_inbox_t1' OR (SELECT marker FROM inbox_t1.fixture_identity) <> 'sandra-inbox-stack-t1-owned-synthetic' THEN RAISE EXCEPTION 'fixture only'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS inbox_t1.bulk_operations(id uuid PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, request_key text NOT NULL, hash text NOT NULL, command jsonb NOT NULL, state text NOT NULL DEFAULT 'accepted', fault_fired boolean NOT NULL DEFAULT false, created_at timestamptz DEFAULT now(), UNIQUE(org_id,user_id,request_key));
CREATE TABLE IF NOT EXISTS inbox_t1.bulk_targets(operation_id uuid REFERENCES inbox_t1.bulk_operations, property_id uuid, expected_revision bigint NOT NULL, PRIMARY KEY(operation_id,property_id));
CREATE TABLE IF NOT EXISTS inbox_t1.bulk_receipts(operation_id uuid, property_id uuid, step text, state text NOT NULL, revision bigint, PRIMARY KEY(operation_id,property_id,step));
CREATE TABLE IF NOT EXISTS inbox_t1.bulk_events(id uuid PRIMARY KEY, operation_id uuid REFERENCES inbox_t1.bulk_operations, generation int DEFAULT 0, lease_until timestamptz, invocation_id text, delivered boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS inbox_t1.bulk_effects(operation_id uuid,property_id uuid,step text,PRIMARY KEY(operation_id,property_id,step));
