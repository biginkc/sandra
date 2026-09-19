#!/usr/bin/env python3
"""Continuous bounded projector for the fixed marked full-Auth candidate, never production."""
import argparse,fcntl,json,os,subprocess,sys,time
from pathlib import Path
P=Path(__file__).resolve().parent;INSTALL=P.parent/'inbox-production-install'
sys.path.insert(0,str(INSTALL));from fixture_db import guard,sql
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');ap.add_argument('--interval',type=float,default=2);a=ap.parse_args()
if not a.owned_fixture or not 1<=a.interval<=30:raise SystemExit('Explicit owned fixture and interval 1..30 seconds required')
guard();lock=(P/'runtime.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
(P/'runtime.pid').write_text(str(os.getpid())+'\n')
print(json.dumps({'status':'running','pid':os.getpid(),'database':'sandra_inbox_install_20260913','interval_seconds':a.interval}),flush=True)
try:
 while True:
  if (P/'pause').exists():time.sleep(a.interval);continue
  started=time.monotonic()
  # Each step guards the exact container, database and marker again. It commits
  # durable claims before computation and retains generation/lease publication fences.
  r=subprocess.run([sys.executable,str(INSTALL/'worker-step.py'),'--owned-fixture','--rounds','1'],text=True,capture_output=True)
  if r.returncode:raise RuntimeError('Projector step failed; stopped for investigation: '+r.stderr)
  result=json.loads(r.stdout);result['elapsed_seconds']=round(time.monotonic()-started,3)
  (P/'last-step.json').write_text(json.dumps(result,indent=2)+'\n')
  if any(result['processed'][k] for k in ['backfill','parent','summary','expiry']):print(json.dumps(result),flush=True)
  time.sleep(a.interval)
finally:
 (P/'runtime.pid').unlink(missing_ok=True)
