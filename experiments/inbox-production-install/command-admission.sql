-- Compiler-owned admission contract for command RPCs.
--
-- This packet deliberately has no application grants and no production
-- enablement.  An authenticated command must pass both the normal
-- session/membership authority and this independent family/cohort gate.  The
-- actor is always derived from the verified request context; there is no
-- caller-supplied user id to trust.
CREATE TABLE inbox_control.command_admission(
 command_family text PRIMARY KEY CHECK(command_family IN (
  'action_prepare','action_accept','action_saved_read','action_saved_write',
  'reply_prepare','reply_accept'
 )),
 enabled boolean NOT NULL DEFAULT false,
 cohort_mode text NOT NULL DEFAULT 'pilot' CHECK(cohort_mode IN ('pilot','all')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO inbox_control.command_admission(command_family)
VALUES ('action_prepare'),('action_accept'),('action_saved_read'),
       ('action_saved_write'),('reply_prepare'),('reply_accept');
ALTER TABLE inbox_control.command_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_control.command_admission FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE inbox_control.command_cohort(
 command_family text NOT NULL REFERENCES inbox_control.command_admission(command_family),
 org_id uuid NOT NULL,
 user_id uuid NOT NULL,
 enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(command_family,org_id,user_id)
);
ALTER TABLE inbox_control.command_cohort ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_control.command_cohort FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION inbox_control.admit_command(command_family text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2s' SET lock_timeout='2s' AS $$
DECLARE a jsonb;actor uuid;org uuid;enabled boolean;mode text;
BEGIN
 IF command_family IS NULL OR command_family NOT IN (
  'action_prepare','action_accept','action_saved_read','action_saved_write',
  'reply_prepare','reply_accept') THEN
  RAISE EXCEPTION 'INBOX_COMMAND_UNKNOWN' USING ERRCODE='22023';
 END IF;
 -- authorize() verifies role, session, expiry and exactly one active
 -- membership.  The returned org/user are therefore server-derived and
 -- cannot be replaced by a JSON/request argument.
 a:=inbox_bridge.authorize(NULL);
 actor:=auth.uid();org:=(a->>'org_id')::uuid;
 IF actor IS NULL OR actor IS DISTINCT FROM (a->>'user_id')::uuid OR org IS NULL THEN
  RAISE EXCEPTION 'INBOX_AUTH_REQUIRED' USING ERRCODE='42501';
 END IF;
 SELECT c.enabled,c.cohort_mode INTO enabled,mode
 FROM inbox_control.command_admission c
 WHERE c.command_family=admit_command.command_family;
 IF NOT FOUND OR NOT enabled THEN
  RAISE EXCEPTION 'INBOX_COMMAND_DISABLED' USING ERRCODE='55000';
 END IF;
 IF mode='all' OR EXISTS(
  SELECT 1 FROM inbox_control.command_cohort c
  WHERE c.command_family=admit_command.command_family
    AND c.org_id=org AND c.user_id=actor
 ) THEN
  -- Preserve every verified authority field while adding the admission
  -- decision.  Callers can compare user/org/session/epoch to authorize().
  RETURN a||jsonb_build_object('command_family',command_family,'cohort_mode',mode);
 END IF;
 RAISE EXCEPTION 'INBOX_COMMAND_NOT_IN_COHORT' USING ERRCODE='42501';
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
