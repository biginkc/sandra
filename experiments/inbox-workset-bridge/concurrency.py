#!/usr/bin/env python3
"""Observe actual actor-row contention and prove concurrent generations remain bounded."""
import runpy,subprocess,time,json
from pathlib import Path
P=Path(__file__).resolve().parent
v=runpy.run_path(str(P/'test.py'));sql=v['sql'];need=v['need'];o=v['o'];u=v['u'];sid=v['sid'];prefix=v['prefix'];D=v['D'];N=v['N']
sql(f"UPDATE inbox_t2_bridge.worksets SET revoked=true,created_at=created_at-interval '2 seconds' WHERE user_id='{u}'")
cmd=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
p1=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
p1.stdin.write(prefix+"SET application_name='inbox-bridge-first';BEGIN;"+f"SELECT inbox_t2_bridge.create_scope('{o}','{{\"view\":\"active\"}}',500);SELECT pg_sleep(4);COMMIT;")
p1.stdin.close()
try:
 for _ in range(40):
  if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='inbox-bridge-first' AND wait_event='PgSleep'")=='1':break
  time.sleep(.05)
 else:raise RuntimeError('First transaction never reached held actor lock')
 p2=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 p2.stdin.write(prefix+"SET application_name='inbox-bridge-second';SET lock_timeout='8s';"+f"SELECT inbox_t2_bridge.create_scope('{o}','{{\"view\":\"active\"}}',500);")
 p2.stdin.close()
 observed=False
 for _ in range(40):
  if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='inbox-bridge-second' AND cardinality(pg_blocking_pids(pid))>0")=='1':observed=True;break
  time.sleep(.05)
 need(observed,'Did not observe real second connection contention')
 p1.wait(timeout=8);p2.wait(timeout=8)
 first_out=p1.stdout.read();first_err=p1.stderr.read();second_err=p2.stderr.read()
 need(p1.returncode==0,first_err)
 # elapsed hold >1s permits the next generation after waiting, still <=2 live bound.
 need(p2.returncode==0 or 'INBOX_GENERATION_RATE' in second_err,second_err)
 count=int(sql(f"SELECT count(*) FROM inbox_t2_bridge.worksets WHERE user_id='{u}' AND NOT revoked AND expires_at>clock_timestamp()"))
 need(1<=count<=2,'Unbounded concurrent generations')
 (P/'concurrency-evidence.json').write_text(json.dumps({'passed':True,'observed_database_blocking':True,'live_generations':count,'claim':'Per-actor creation serialized across actual concurrent connections; at most two live generations','limitations':['No JWT server','No Electric transport in this test']},indent=2)+'\n')
 print('Actual actor-row concurrent generation test passed')
finally:
 if p1.poll() is None:p1.terminate();p1.wait(timeout=5)
 if 'p2' in locals() and p2.poll() is None:p2.terminate();p2.wait(timeout=5)
