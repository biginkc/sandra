#!/usr/bin/env python3
"""Install candidate and backfill only owned corpus rows with source-row fencing."""
import json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='30s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=40)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
q="""BEGIN;
CREATE SCHEMA inbox_auth_privilege_probe AUTHORIZATION postgres;
CREATE TABLE inbox_auth_privilege_probe.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL);
ALTER TABLE inbox_auth_privilege_probe.sessions OWNER TO supabase_auth_admin;
ALTER TABLE inbox_auth_privilege_probe.sessions ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA inbox_auth_privilege_probe TO supabase_auth_admin;
GRANT ALL ON inbox_auth_privilege_probe.sessions TO postgres;
SET LOCAL ROLE postgres;
CREATE TABLE inbox_auth_privilege_probe.captured(id uuid PRIMARY KEY);
REVOKE ALL ON inbox_auth_privilege_probe.captured FROM PUBLIC,supabase_auth_admin;
CREATE FUNCTION inbox_auth_privilege_probe.capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $body$
BEGIN INSERT INTO inbox_auth_privilege_probe.captured VALUES(NEW.id);RETURN NEW;END $body$;
REVOKE ALL ON FUNCTION inbox_auth_privilege_probe.capture() FROM PUBLIC,supabase_auth_admin;
CREATE TRIGGER capture AFTER INSERT ON inbox_auth_privilege_probe.sessions FOR EACH ROW EXECUTE FUNCTION inbox_auth_privilege_probe.capture();
SET LOCAL ROLE supabase_auth_admin;
INSERT INTO inbox_auth_privilege_probe.sessions VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
SET LOCAL ROLE postgres;
DO $body$ BEGIN
 IF (SELECT count(*) FROM inbox_auth_privilege_probe.captured)<>1 THEN RAISE EXCEPTION 'Trigger did not fire';END IF;
 BEGIN DROP TRIGGER capture ON inbox_auth_privilege_probe.sessions;RAISE EXCEPTION 'Unexpected ownership privilege';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $body$;
DROP FUNCTION inbox_auth_privilege_probe.capture() CASCADE;
DO $body$ BEGIN IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inbox_auth_privilege_probe.sessions'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'Trigger rollback failed';END IF;END $body$;
ROLLBACK;
"""
r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='20s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=30)
if r.returncode:raise RuntimeError(r.stderr)
if sql("SELECT to_regnamespace('inbox_auth_privilege_probe') IS NULL")!='t':raise RuntimeError('Probe schema remains')
(P/'auth-privilege-fixture-evidence.json').write_text(json.dumps({'passed':True,'checks':['postgres nonowner trigger creation','auth owner insert triggers postgres definer private write','postgres DROP TRIGGER denied','owned function DROP CASCADE removes trigger','transaction rollback leaves no schema'],'limitation':'Equivalent fixture privileges, not production DDL execution'},indent=2)+'\n')
print('Equivalent Auth privilege install/fire/rollback checks passed')
