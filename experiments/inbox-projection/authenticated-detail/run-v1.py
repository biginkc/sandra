#!/usr/bin/env python3
"""Exclusive owned-fixture window required. Claims are simulated, not JWT verification."""
import argparse, hashlib, json, re, select, subprocess, sys, time, uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N='sandra-inbox-projection-t2-db'
PSQL=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(ok,msg):
 if ok is not True:raise RuntimeError(msg)
def sql(s,check=True):
 r=subprocess.run(PSQL,input="SET statement_timeout='20s';SET lock_timeout='2s';\n"+s,text=True,capture_output=True,timeout=30)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def uid():return str(uuid.uuid4())
def lit(v):return "'"+str(v).replace("'","''")+"'"
def stop(p):
 if p is None:return
 if p.poll() is None:
  try:p.stdin.write('ROLLBACK;\n\\q\n');p.stdin.flush()
  except (OSError,BrokenPipeError):pass
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:
   p.terminate()
   try:p.wait(timeout=5)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
 for f in [p.stdin,p.stdout,p.stderr]:
  try:f.close()
  except (OSError,BrokenPipeError):pass
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--continue-installed',action='store_true');args=parser.parse_args()
need(args.run_owned_fixture and not sys.flags.optimize,'Explicit fixture grant and nonoptimized Python required')
container=json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=10))[0];validate_container(container)
boot=json.loads((P.parent/'fixture/bootstrap-result.json').read_text());need(boot.get('complete') is True and boot.get('status')=='ready','Fixture bootstrap incomplete')
validate_cron(sql('SHOW cron.launch_active_jobs;'))
need(sql("SELECT marker FROM inbox_t2_fixture.identity;")=='sandra-inbox-projection-t2-owned-synthetic','Wrong marker')
org,other,conv,zero,user,outsider,keeper=[uid() for _ in range(7)]
def request(tenant=org,conversation=conv,requester=user,role='authenticated',cursor=None):
 claims=json.dumps({'sub':requester,'role':role} if requester else {'role':role})
 extra=','+lit(cursor['created_at_raw'])+'::timestamptz,'+lit(cursor['id'])+'::uuid' if cursor else ''
 return f"BEGIN READ ONLY;SET LOCAL ROLE {role};SET LOCAL request.jwt.claims={lit(claims)};SELECT inbox_t2_authenticated_detail.detail('{tenant}','{conversation}'{extra});ROLLBACK;"
def detail(**kwargs):return json.loads(sql(request(**kwargs)))
def denied(expected='42501',message='INBOX_ACCESS_DENIED',**kwargs):
 r=sql(request(**kwargs),False);need(r.returncode!=0 and 'ERROR:  '+expected+':' in r.stderr and message in r.stderr,'Expected precise denial: '+r.stderr)
def insert(mid,when='2027-01-01'):
 return f"INSERT INTO public.messages(id,org_id,conversation_id,channel,direction,body,created_at) VALUES('{mid}','{org}','{conv}','sms','inbound','held fixture',{lit(when)});"
checks=[];holder=None
try:
 if args.continue_installed:
  installed=json.loads(sql("SELECT jsonb_build_object('body',prosrc,'owner',pg_get_userbyid(proowner),'stable',provolatile='s','definer',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='inbox_t2_authenticated_detail.detail(uuid,uuid,timestamptz,uuid)'::regprocedure;"))
  expected=re.search(r'CREATE FUNCTION.*?AS \$\$(.*?)\$\$;', (P/'setup.sql').read_text(), re.S).group(1)
  need(installed['body'].strip()==expected.strip() and installed['owner']=='postgres' and installed['stable'] is True and installed['definer'] is True and installed['config']==['search_path=""'],'Installed candidate mismatch')
 else:sql((P/'setup.sql').read_text())
 sql(f"INSERT INTO public.organizations(id,name) VALUES('{org}','Authenticated detail {org}'),('{other}','Authenticated detail {other}');INSERT INTO auth.users(id,email) VALUES('{user}','{user}@example.invalid'),('{outsider}','{outsider}@example.invalid'),('{keeper}','{keeper}@example.invalid');INSERT INTO public.memberships(user_id,org_id,role,access_status) VALUES('{keeper}','{org}','owner','active'),('{keeper}','{other}','owner','active');INSERT INTO public.memberships(user_id,org_id,role,access_status) VALUES('{user}','{org}','member','active'),('{outsider}','{other}','member','active');INSERT INTO public.messages(org_id,conversation_id,channel,direction,body,created_at) SELECT '{org}','{conv}','sms','inbound','detail '||n,'2026-09-01'::timestamptz+(n/10)*interval '0.000001 second' FROM generate_series(1,74)n;INSERT INTO public.messages(org_id,conversation_id,channel,direction,body) VALUES('{org}','{zero}','sms','outbound','zero head');")
 expected=json.loads(sql(f"SELECT jsonb_agg(id ORDER BY created_at DESC,id DESC) FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}';"))
 first=detail();need(first['head_revision']=='74' and [m['id'] for m in first['history']]==expected[:50],'First snapshot mismatch')
 second=detail(cursor=first['history'][-1]);need([m['id'] for m in first['history']+second['history']]==expected,'Raw timestamp tied cursor mismatch')
 need(detail(cursor=second['history'][-1])['history']==[],'Valid exhausted cursor did not return empty history')
 z=detail(conversation=zero);need(z['head_revision']=='0' and len(z['history'])==1,'Outbound-only conversation lacks valid zero head')
 checks.append({'name':'authorized exact head/history, raw microsecond tie cursor, empty page and zero head','passed':True})
 denied(requester=outsider);denied(tenant=other);denied(conversation=uid());denied(requester=None,message='INBOX_AUTH_REQUIRED');denied(role='anon',requester=None,message='permission denied for schema');denied(role='service_role',message='permission denied for schema')
 checks.append({'name':'other requester/org, unknown conversation, missing auth, anon and service ACL denied precisely','passed':True})
 for change,restore in [("access_expires_at=statement_timestamp()-interval '1 second'","access_expires_at=NULL"),("access_status='revoked'","access_status='active'"),("access_status='suspended'","access_status='active'"),("deletion_prepared_at=statement_timestamp()","deletion_prepared_at=NULL")]:
  sql(f"UPDATE public.memberships SET {change} WHERE user_id='{user}' AND org_id='{org}';")
  try:denied()
  finally:sql(f"UPDATE public.memberships SET {restore} WHERE user_id='{user}' AND org_id='{org}';")
 checks.append({'name':'actual Hugo expiry, revocation, suspension and deletion-prepared lifecycle denied','passed':True})
 held=uid();holder=subprocess.Popen(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write("SET statement_timeout='10s';SET idle_in_transaction_session_timeout='15s';BEGIN;"+insert(held)+"\n\\echo ready\n");holder.stdin.flush()
 ready,_,_=select.select([holder.stdout],[],[],12);need(bool(ready) and holder.stdout.readline().strip()=='ready','Held arrival barrier failed')
 before=detail();need(before['head_revision']=='74' and held not in [m['id'] for m in before['history']],'Uncommitted arrival/head leaked')
 holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,'Held arrival failed commit');stop(holder);holder=None
 after=detail();need(after['head_revision']=='75' and after['history'][0]['id']==held and after['history'][0]['inbound_revision']=='75','Committed head/history not coherent')
 checks.append({'name':'held arrival excludes both row/head then committed snapshot includes both','passed':True})
 # A visible conversation UUID in another active org remains ambiguous even
 # when the caller names an org explicitly. Old contactless rows count too.
 sql(f"INSERT INTO public.memberships(user_id,org_id,role,access_status) VALUES('{user}','{other}','member','active');INSERT INTO public.messages(org_id,conversation_id,channel,direction,body,created_at) VALUES('{other}','{conv}','sms','outbound','old ambiguous','1990-01-01');")
 denied(expected='P0001',message='SMS_CONVERSATION_ORG_AMBIGUOUS')
 sql(f"UPDATE public.memberships SET access_status='revoked' WHERE user_id='{user}' AND org_id='{other}';")
 need(detail()['org_id']==org,'Revoked other-org membership incorrectly makes scope ambiguous')
 checks.append({'name':'cross-org visible ambiguity preserved; inaccessible other org excluded','passed':True})
 # No candidate function body writes; read-only transactions additionally
 # enforce that a future accidental write fails instead of silently marking read.
 need(sql(f"SELECT count(*) FROM public.messages WHERE org_id='{org}' AND conversation_id='{conv}' AND read_at IS NOT NULL;")=='0','Detail marked source read')
 evidence={'status':'PASS','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,'org':org,'container_id':container['Id'],'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'harness_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Simulated trusted request.jwt.claims; no JWT signature, HTTP, PostgREST, token, receipt or browser proof','Tiny fixture conversations; no internal RPC query-plan/performance guarantee','Membership authorization follows caller statement snapshot; revocation committed during statement needs gateway recheck before response','Unknown/no-message conversations denied: canonical schema has no conversation identity registry','Private candidate schema and synthetic fixtures retained; no public API/migration installed']}
 (P/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
except Exception as e:
 (P/('failure-'+time.strftime('%Y%m%dT%H%M%S',time.gmtime())+'.json')).write_text(json.dumps({'error':str(e),'checks':checks},indent=2)+'\n');raise
finally:stop(holder)
