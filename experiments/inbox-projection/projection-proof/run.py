#!/usr/bin/env python3
"""Actual-schema private projection rehearsal. Root must grant the fixture window first."""
import argparse, hashlib, json, re, select, subprocess, sys, time, uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container, validate_cron
HOST='unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
CONTAINER='sandra-inbox-projection-t2-db'
D=['docker','--host',HOST]
PSQL=D+['exec','-i',CONTAINER,'psql','-X','-qAt','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(condition,message):
 if not condition: raise RuntimeError(message)
def sql(source,check=True):
 r=subprocess.run(PSQL,input="SET ROLE postgres;SET statement_timeout='20s';SET lock_timeout='2s';\n"+source,text=True,capture_output=True,timeout=30)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def uid():return str(uuid.uuid4())
def snap(org,conv):return json.loads(sql(f"SELECT inbox_t2_projection_proof.snapshot('{org}','{conv}');"))
def commit(candidate):
 encoded=json.dumps(candidate).replace("'","''")
 return sql("SELECT inbox_t2_projection_proof.commit_candidate('"+encoded+"'::jsonb);")
def state(org,conv):return json.loads(sql(f"SELECT jsonb_build_object('generation',d.generation,'ack',d.acknowledged_generation,'revision',p.revision,'source_generation',p.source_generation,'count',p.message_count,'unread',p.unread_count,'preview',p.latest_preview,'stamp',p.latest_inbound_revision) FROM inbox_t2_projection_proof.dirty d LEFT JOIN inbox_t2_projection_proof.projections p USING(org_id,conversation_id) WHERE d.org_id='{org}' AND d.conversation_id='{conv}';"))
def message(org,conv,mid,body,when='2026-09-13 12:00:00+00'):
 return f"INSERT INTO public.messages(id,org_id,conversation_id,channel,direction,body,created_at) VALUES('{mid}','{org}','{conv}','sms','inbound','{body}','{when}');"
checks=[]
def passed(name,**details):checks.append(dict(name=name,passed=True,**details));print('PASS '+name)
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--continue-installed',action='store_true');args=parser.parse_args()
need(args.run_owned_fixture,'Explicit --run-owned-fixture required after root grants database window')
need(not sys.flags.optimize,'Refusing -O: evidence must never depend on disabled checks')
container=json.loads(subprocess.check_output(D+['inspect',CONTAINER],text=True,timeout=10))[0]
bootstrap=json.loads((P.parent/'fixture/bootstrap-result.json').read_text())
need(container['Id']==bootstrap['containerId'],'Container ID differs from owned bootstrap receipt')
validate_container(container)
need(bootstrap.get('status')=='ready' and bootstrap.get('complete') is True,'Bootstrap must be complete and ready')
validate_cron(sql('SHOW cron.launch_active_jobs;'))
need(sql("SELECT marker FROM inbox_t2_fixture.identity;")=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture marker')
need(sql("SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.inbox_capture_inbound_head()'::regprocedure;")=='postgres','Head allocator ownership differs')
setup=P/'setup.sql'
try:
 if args.continue_installed:
  old=json.loads((P/'evidence.json').read_text())
  need(old.get('status')=='PASS' and old.get('setup_sha256')==hashlib.sha256(setup.read_bytes()).hexdigest(),'Existing successful setup receipt must match exact unchanged SQL')
  # Compare actual installed function bodies and security settings, not only saved receipt.
  installed=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('name',p.proname,'body',p.prosrc,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'config',p.proconfig)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='inbox_t2_projection_proof';"))
  expected=dict(re.findall(r'CREATE FUNCTION inbox_t2_projection_proof\.(\w+)\(.*?AS \$\$(.*?)\$\$;',setup.read_text(),re.S))
  need(len(installed)==len(expected)==3,'Installed function inventory mismatch')
  for f in installed:
   need(f['name'] in expected and f['body'].strip()==expected[f['name']].strip(),'Installed function body mismatch')
   need(f['owner']=='postgres' and f['definer'] is True and f['config']==['search_path=""'],'Installed function security mismatch')
  need(sql("SELECT count(*) FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='zzzz_inbox_t2_projection_dirty' AND tgfoid='inbox_t2_projection_proof.capture_dirty()'::regprocedure AND tgenabled='O' AND tgtype=29;")=='1','Installed dirty trigger mismatch')
  need(sql("SELECT count(*) FROM pg_constraint WHERE connamespace='inbox_t2_projection_proof'::regnamespace AND contype='f';")=='0','Unexpected FK in private commit path')
 else:
  sql(setup.read_text())
 org,conv,dest,mid,second=uid(),uid(),uid(),uid(),uid()
 sql(f"INSERT INTO public.organizations(id,name) VALUES('{org}','T2 private projection proof {org}');")
 sql(message(org,conv,mid,'first'))
 a=snap(org,conv);need(int(a['generation'])==1,'Revision-only nested update duplicated dirty capture');need(int(a['latest_inbound_revision'])>0,'Snapshot did not see finalized AFTER stamp')
 passed('nested head self-update yields one dirty generation and snapshot sees final positive stamp',generation=a['generation'],stamp=a['latest_inbound_revision'])
 sql(f"UPDATE public.messages SET body='newer' WHERE id='{mid}';")
 b=snap(org,conv);need(commit(b)=='applied','Newer candidate failed');before=state(org,conv)
 need(commit(a) in ('invalid_generation','projection_conflict'),'Old candidate was accepted');need(state(org,conv)==before,'Old candidate overwrote newer projection')
 passed('delayed older snapshot cannot overwrite newer projected generation')
 sql(f"UPDATE public.messages SET body='intermediate' WHERE id='{mid}';")
 c=snap(org,conv);sql(message(org,conv,second,'later','2026-09-13 12:00:01+00'))
 need(commit(c)=='applied','Valid older generation progress was starved');partial=state(org,conv)
 need(partial['generation']>partial['ack']==int(c['generation']) and partial['count']==1,'New dirty work lost while committing older candidate')
 passed('older valid snapshot may commit while newer dirty generation stays pending',state=partial)
 d=snap(org,conv);d2=dict(d);need(commit(d)=='applied','Latest candidate failed');need(commit(d2)=='projection_conflict','Projection CAS missed duplicate snapshot')
 complete=state(org,conv);need(complete['count']==2 and complete['generation']==complete['ack'],'Latest projection incomplete')
 passed('projection revision CAS rejects equal-generation stale worker')
 bad=dict(d);bad['expected_revision']=None;need(commit(bad)=='invalid_candidate','NULL expected revision bypassed CAS');bad=dict(d);bad['generation']=None;need(commit(bad)=='invalid_candidate','NULL generation bypassed validation');passed('NULL candidate revisions fail closed before lock/commit')
 prior=complete['generation'];sql(f"UPDATE public.messages SET conversation_id='{dest}' WHERE id='{second}';")
 old_snap,new_snap=snap(org,conv),snap(org,dest)
 need(int(old_snap['generation'])==prior+1 and int(new_snap['generation'])==1,'Move did not dirty old and destination exactly once')
 need(old_snap['message_count']=='1' and new_snap['message_count']=='1','Move snapshots disagree with canonical membership')
 need(commit(old_snap)=='applied' and commit(new_snap)=='applied','Move projections failed')
 passed('identity move dirties old and new keys despite nested destination revision stamp')
 def arrival_state():
  return json.loads(sql(f"SELECT jsonb_build_object('head',h.revision::text,'stamp',m.inbox_inbound_revision::text) FROM public.messages m JOIN public.inbox_inbound_heads h USING(org_id,conversation_id) WHERE m.id='{second}';"))
 arrival_before=arrival_state();need(int(arrival_before['head'])>0 and int(arrival_before['stamp'])>0,'Missing pre-read head/stamp')
 sql(f"UPDATE public.messages SET read_at=now() WHERE id='{second}';")
 arrival_after=arrival_state();need(arrival_after==arrival_before,'Read allocated a new arrival head or stamp')
 read=snap(org,dest);need(read['unread_count']=='0' and commit(read)=='applied','Read state did not dirty projection')
 passed('read mutation updates unread projection without new arrival allocation',before=arrival_before,after=arrival_after)
 sql(f"DELETE FROM public.messages WHERE id='{second}';")
 empty=snap(org,dest);need(empty['message_count']=='0' and empty['latest_message_id'] is None,'Empty destination snapshot retained message');need(commit(empty)=='applied','Empty projection failed')
 passed('deletion leaves persistent empty projection and dirty counter')
 before=state(org,conv);sql('BEGIN;'+message(org,conv,uid(),'rollback')+'ROLLBACK;');need(state(org,conv)==before,'Rollback leaked dirty/projection state')
 passed('source rollback also rolls back dirty generation')
 # A commit against a precomputed candidate must not wait on canonical row locks.
 sql(f"UPDATE public.messages SET body='lock-test' WHERE id='{mid}';")
 candidate=snap(org,conv)
 holder=None
 try:
  holder=subprocess.Popen(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
  # Server idle timeout also bounds a transaction if the Docker exec client dies.
  holder.stdin.write(f"SET ROLE postgres;SET statement_timeout='10s';SET idle_in_transaction_session_timeout='15s';BEGIN;DO $$ BEGIN PERFORM id FROM public.messages WHERE id='{mid}' FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Missing lock target';END IF;END $$;\n\\echo locked\n");holder.stdin.flush()
  ready,_,_=select.select([holder.stdout],[],[],12)
  need(bool(ready),'Source lock barrier timed out')
  need(holder.stdout.readline().strip()=='locked','Source lock barrier failed')
  encoded=json.dumps(candidate).replace("'","''")
  r=sql("BEGIN;SET LOCAL lock_timeout='300ms';SELECT inbox_t2_projection_proof.commit_candidate('"+encoded+"'::jsonb);COMMIT;")
  need(r=='applied','Private commit blocked on canonical source lock')
 finally:
  if holder is not None:
   if holder.poll() is None:
    try: holder.stdin.write('ROLLBACK;\n\\q\n');holder.stdin.flush()
    except (BrokenPipeError,OSError): pass
    try: holder.wait(timeout=5)
    except subprocess.TimeoutExpired:
     holder.terminate()
     try: holder.wait(timeout=5)
     except subprocess.TimeoutExpired: holder.kill();holder.wait(timeout=5)
   for stream in [holder.stdin,holder.stdout,holder.stderr]:
    if stream: stream.close()
 passed('private commit completes while canonical message row is independently locked')
 for role in ['authenticated','service_role']:
  r=sql(f"SET ROLE {role};SELECT * FROM inbox_t2_projection_proof.projections;",False);need(r.returncode!=0 and re.search(r'ERROR:\s+42501:',r.stderr) is not None and 'permission denied for schema inbox_t2_projection_proof' in r.stderr,role+' did not fail with expected schema permission denial: '+r.stderr)
 passed('ordinary and service roles cannot directly access private rehearsal projection')
 evidence=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),status='PASS',container_id=container['Id'],source_revision=bootstrap['source_revision'],setup_sha256=hashlib.sha256(setup.read_bytes()).hexdigest(),harness_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),mode='continue-installed' if args.continue_installed else 'fresh-install',fixture_org_id=org,checks=checks,limits=['Minimal SMS message-derived projection only; no contact/property/consent fanout, authorization reader, worker service or production performance proof','No canonical FK in private commit tables; future triggers/FKs require fresh lock review','Capture does not certify TRUNCATE, trigger-disabled imports or privileged bypass coverage','Snapshot message counts scan the one fixture conversation; no large-history query budget claim'])
 (P/'evidence-hardened.json').write_text(json.dumps(evidence,indent=2)+'\n')
except Exception as e:
 (P/'evidence-hardened.json').write_text(json.dumps(dict(status='FAIL',at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),checks=checks,error=str(e)),indent=2)+'\n');raise
