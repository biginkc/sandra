#!/usr/bin/env python3
"""Rehearse coherent organization/epoch pairs while a membership moves repeatedly."""
import runpy,subprocess,json
from pathlib import Path
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P/'test.py'));sql=v['sql'];need=v['need'];o=v['o'];o2=v['o2'];u=v['u'];prefix=v['prefix'];D=v['D'];N=v['N']
base=int(sql(f"SELECT revision FROM inbox_t2_bridge.access_epochs WHERE user_id='{u}'"))
cmd=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
writer=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
writer.stdin.write(''.join(f"BEGIN; DELETE FROM memberships WHERE user_id='{u}'; INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o2 if i%2 else o}','member','active');COMMIT;SELECT pg_sleep(.002);" for i in range(1,101)))
writer.stdin.close()
observed=[]
try:
 for _ in range(40):
  a=json.loads(sql(prefix+'SELECT public.inbox_authorize_sync(null)'))
  revision=int(a['access_epoch'])
  need(a['org_id']==(o2 if ((revision-base)//2)%2 else o),'Mixed membership and access epoch snapshots')
  observed.append(revision)
 writer.wait(timeout=15);need(writer.returncode==0,writer.stderr.read())
 (P/'auth-concurrency-evidence.json').write_text(json.dumps({'passed':True,'reads':len(observed),'distinct_revisions_observed':len(set(observed)),'claim':'Returned org and epoch remain a coherent committed pair during canonical membership changes'},indent=2)+'\n')
finally:
 if writer.poll() is None:writer.terminate();writer.wait(timeout=5)
