#!/usr/bin/env python3
import json,subprocess,sys,re
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
q="""BEGIN;SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='2s';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM inbox_t2_fixture.identity WHERE marker='sandra-inbox-projection-t2-owned-synthetic') THEN RAISE EXCEPTION 'Wrong fixture';END IF;END $$;
ALTER TABLE inbox_t2_bridge.worksets ADD COLUMN handles jsonb;
UPDATE inbox_t2_bridge.worksets SET handles=(SELECT jsonb_agg(CASE WHEN i=1 THEN handle ELSE null END) FROM generate_series(1,greatest(1,(jsonb_array_length(targets)+99)/100))i);
ALTER TABLE inbox_t2_bridge.worksets ALTER COLUMN handles SET NOT NULL;
ALTER TABLE inbox_t2_bridge.worksets ADD CHECK(jsonb_typeof(handles)='array' AND jsonb_array_length(handles)=greatest(1,(jsonb_array_length(targets)+99)/100));
DROP FUNCTION public.inbox_bind_sync_handle(uuid,text,text);
DROP FUNCTION inbox_t2_bridge.bind_handle(uuid,text,text);
"""
for f in ['auth.sql','worksets.sql','public-api.sql']:
 for fn in re.findall(r'CREATE FUNCTION .*?\$\$;', (P/f).read_text(), re.S):q+=fn.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)+'\n'
q+='''ALTER TABLE inbox_t2_bridge.worksets DROP COLUMN handle;
REVOKE ALL ON FUNCTION inbox_t2_bridge.bind_handle(uuid,integer,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_bind_sync_handle(uuid,integer,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_bind_sync_handle(uuid,integer,text,text) TO authenticated;COMMIT;'''
r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=30)
if r.returncode:raise RuntimeError(r.stderr)
print('Reviewed fixture function fixes and handle partition upgrade applied')
