#!/usr/bin/env python3
if not __debug__:
    raise SystemExit('Refusing optimized Python before fixture access')
import json,subprocess,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'fixture'))
from guards import validate_container,validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(s):
 return subprocess.check_output(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=s,text=True,timeout=20).strip()
validate_cron(sql('SHOW cron.launch_active_jobs;'))
if sql('SELECT marker FROM inbox_t2_fixture.identity;')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture marker')
