#!/usr/bin/env python3
"""Owned maintained-row scale corpus; synthetic ingestion, never production load."""
import argparse,hashlib,json,math,re,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
ap=argparse.ArgumentParser();ap.add_argument('--run-owned-fixture',action='store_true');ap.add_argument('--seed',action='store_true');ap.add_argument('--variant',default='baseline');ap.add_argument('--size',type=int,choices=[120000,360000],default=120000);args=ap.parse_args()
if not args.run_owned_fixture:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q,timeout=65):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input="SET statement_timeout='60s';SET lock_timeout='2s';"+q,text=True,capture_output=True,timeout=timeout)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
state=P/'corpus.json'
if args.seed:
 corpora=json.loads(state.read_text()) if state.exists() else []
 if any(c['size']==args.size for c in corpora):raise RuntimeError('Requested corpus exists; refuse duplicate seed')
 for size in [args.size]:
  o,u,sid=[str(uuid.uuid4()) for _ in range(3)]
  sql(f"INSERT INTO organizations(id,name) VALUES('{o}','Inbox scale {o}');INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.test');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o}','owner','active');INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sid}','{u}',clock_timestamp()+interval '12 hours');")
  started=time.monotonic()
  for start in range(1,size+1,1000):
   sql(f"""INSERT INTO inbox_t2_maintained.rows(org_id,target_kind,target_id,revision,source_generation,summary)
SELECT '{o}',CASE WHEN i%10=0 THEN 'unknown_sender' ELSE 'known_conversation' END,md5('{o}'||i)::uuid,1,1,
jsonb_build_object('exists',true,'contact_name','Synthetic scale','raw_sender_key','scale-'||i,'last_message_at',t,'latest_at',t,'last_message_preview','Synthetic incoming message','latest_preview','Unknown incoming','has_recent',i%13<>0,'is_noise',i%17=0,'is_test_traffic',false,'property_status',CASE WHEN i%7=0 THEN 'prospect' ELSE 'new_lead' END,'assigned_user_id',CASE WHEN i%3=0 THEN '{u}' ELSE null END,'unread_count',CASE WHEN i%11=0 THEN 1 ELSE 0 END,'ai_responder_status',CASE WHEN i%31=0 THEN 'escalated' ELSE null END,'needs_outcome',i%19=0,'ai_disposition_review_id',CASE WHEN i%41=0 THEN md5('{o}-review-'||i)::uuid ELSE null END,'visible_unknown',i%20=0,'visible_dismissed',i%20<>0,'visible_all_hide_noise',i%13<>0 AND i%17<>0)
FROM (SELECT i,'2026-09-13T00:00:00Z'::timestamptz-(i*interval '1 second')t FROM generate_series({start},{min(start+999,size)})i)s;""")
  counts={k:0 for k in ['all','mine','unassigned','unread','escalated','dispo','needs_outcome','unknown','dismissed']}
  for i in range(1,size+1):
   if i%10==0:counts['unknown' if i%20==0 else 'dismissed']+=1;continue
   if i%41==0:counts['dispo']+=1
   if i%13==0 or i%17==0:continue
   counts['all']+=1
   if i%7!=0:counts['mine' if i%3==0 else 'unassigned']+=1
   for k,d in [('unread',11),('escalated',31),('needs_outcome',19)]:counts[k]+=i%d==0
  corpora.append({'size':size,'known':size-size//10,'org':o,'user':u,'session':sid,'seed_seconds':time.monotonic()-started,'expected_counts':counts})
  print(f'Seeded {size} bounded rows',flush=True)
  sql('ANALYZE inbox_t2_maintained.rows;ANALYZE inbox_t2_bridge.filter_rows')
 state.write_text(json.dumps(corpora,indent=2)+'\n')
corpora=[c for c in json.loads(state.read_text()) if c['size']==args.size];results=[]
for corpus in corpora:
 o,u,sid=[corpus[k] for k in ['org','user','session']]
 claims=json.dumps({'sub':u,'role':'authenticated','session_id':sid,'exp':4102444800})
 prefix=f"SET request.jwt.claims='{claims}';"
 counts=json.loads(sql(prefix+f"SELECT inbox_t2_bridge.counts_baseline('{o}','{{\"view\":\"all\"}}')"))['counts'] if args.variant=='baseline' else json.loads(sql(prefix+f"SELECT inbox_t2_bridge.counts_typed('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"all\"}}'))"))
 if counts!=corpus['expected_counts']:raise RuntimeError('Independent count oracle mismatch')
 for name,q in [('counts',f"SELECT inbox_t2_bridge.counts_baseline('{o}','{{\"view\":\"all\"}}')")]+[(view,f"SELECT * FROM inbox_t2_bridge.matching('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"{view}\"}}')) ORDER BY latest_at DESC NULLS LAST,target_kind,target_id LIMIT 100") for view in ['all','mine','unread','escalated','unknown']]:
  if args.variant!='baseline':
   if name=='counts':q=f"SELECT inbox_t2_bridge.counts_typed('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"all\"}}'))"
   else:
    baseline_ids=json.loads(sql("SELECT jsonb_agg(to_jsonb(x)) FROM ("+q+") x"))
    q=f"SELECT * FROM inbox_t2_bridge.page('{o}','{u}',inbox_t2_bridge.normalize_filter('{{\"view\":\"{name}\"}}'),NULL,NULL,NULL,false,100)"
    typed_ids=json.loads(sql("SELECT jsonb_agg(to_jsonb(x)) FROM ("+q+") x"))
    if baseline_ids!=typed_ids:raise RuntimeError('Typed ordered parity mismatch: '+name)
  times=[];plans=[]
  for sample in range(10):
   plan=json.loads(sql(prefix+'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) '+q))[0];times.append(plan['Execution Time']);plans.append(plan)
  result={'size':corpus['size'],'query':name,'p50_ms':sorted(times)[4],'p95_ms':sorted(times)[9],'times_ms':times,'plans':plans}
  results.append(result);print(f"{args.variant} {corpus['size']} {name}: p95 {result['p95_ms']}ms",flush=True)
  (P/(args.variant+'-'+str(args.size)+'-evidence.json')).write_text(json.dumps({'results':results,'environment':'Owned512MiB1CPUfixture; no production claim','corpus_sha256':hashlib.sha256(state.read_bytes()).hexdigest()},indent=2)+'\n')
