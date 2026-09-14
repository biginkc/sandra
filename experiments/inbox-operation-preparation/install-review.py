#!/usr/bin/env python3
if not __debug__:raise SystemExit('Optimized Python refused')
import json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'));from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q):return subprocess.check_output(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,timeout=30).strip()
def lit(v):return "'"+v.replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
prior=(P/'public-api.sql').read_text().split('CREATE FUNCTION public.inbox_prepare_action',1)[1].split('AS $$',1)[1].split('$$;',1)[0]
if sql("SELECT prosrc FROM pg_proc WHERE oid='public.inbox_prepare_action(text,uuid)'::regprocedure").strip()!=prior.strip():raise RuntimeError('Prior wrapper mismatch')
guard="DO $$ BEGIN IF (SELECT prosrc FROM pg_proc WHERE oid='public.inbox_prepare_action(text,uuid)'::regprocedure) IS DISTINCT FROM "+lit(prior)+" THEN RAISE EXCEPTION 'Prior wrapper changed';END IF;END $$;"
sql((P/'review.sql').read_text().replace('BEGIN;','BEGIN;'+guard,1))
print('Additive guarded review/assignee/recovery wrappers installed')
