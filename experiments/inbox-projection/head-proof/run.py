#!/usr/bin/env python3
"""Offline canonical-schema proof. Refuses any container except the owned T2 fixture."""
if not __debug__:
    raise SystemExit("Refusing optimized Python: proof assertions must remain enabled")
import hashlib, json, os, subprocess, time, uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'fixture'))
from guards import validate_container, validate_cron
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
HOST='unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
CONTAINER='sandra-inbox-projection-t2-db'
MARKER='sandra-inbox-projection-t2-owned-synthetic'
DOCKER=['docker','--host',HOST]
PSQL=DOCKER+['exec','-i',CONTAINER,'psql','-X','-qAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def sql(text,check=True):
 p=subprocess.run(PSQL,input=text,text=True,capture_output=True,timeout=180)
 if check and p.returncode:raise RuntimeError(p.stderr)
 return p.stdout.strip() if check else p

def scalar(text):return sql(text).splitlines()[-1]
def uid():return str(uuid.uuid4())
def message(mid,conv,org=None,extra=''):
 return f"INSERT INTO public.messages(id,org_id,conversation_id,channel,direction,body{', '+extra.split('=',1)[0] if extra else ''}) VALUES ('{mid}','{org or ORG}','{conv}','sms','inbound','T2 synthetic'{', '+extra.split('=',1)[1] if extra else ''});"
def revision(mid):return int(scalar(f"SELECT inbox_inbound_revision FROM public.messages WHERE id='{mid}';"))
def head(conv,org=None):return int(scalar(f"SELECT coalesce((SELECT revision FROM public.inbox_inbound_heads WHERE org_id='{org or ORG}' AND conversation_id='{conv}'),0);"))
import select
processes=[]
def spawn(*args,**kwargs):
 p=subprocess.Popen(*args,**kwargs);processes.append(p);return p
def ready_line(process,timeout=10):
 readable,_,_=select.select([process.stdout],[],[],timeout)
 if not readable:raise RuntimeError('Timed out waiting for holder readiness')
 return process.stdout.readline().strip()
def close_processes():
 for process in processes:
  if process.stdin and not process.stdin.closed:
   try:process.stdin.close()
   except (BrokenPipeError,OSError):pass
  if process.poll() is None:
   process.terminate()
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:
    process.kill();process.wait(timeout=5)

checks=[]
def passed(name,**evidence):checks.append(dict(name=name,passed=True,**evidence))
c=json.loads(subprocess.check_output(DOCKER+['inspect',CONTAINER],text=True,timeout=15))[0]
if c['HostConfig']['NetworkMode']!='none' or c['HostConfig'].get('PortBindings') or not c['State']['Running']:raise RuntimeError('Refusing networked/stopped fixture')
# Container ownership additionally checked by immutable ID receipt written by bootstrap.
bootstrap=json.loads((ROOT/'experiments/inbox-projection/fixture/bootstrap-result.json').read_text())
if bootstrap.get('container')!=CONTAINER or not bootstrap.get('complete'):
 raise RuntimeError('Source bootstrap is not recorded READY; coordinate before proof')
if bootstrap.get('containerId')!=c['Id']:raise RuntimeError('Wrong immutable fixture container')
validate_container(c)
validate_cron(sql('SHOW cron.launch_active_jobs;'))
if scalar('SELECT marker FROM inbox_t2_fixture.identity;')!=MARKER:raise RuntimeError('Wrong fixture marker')
if scalar("SELECT count(*) FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname IN ('trg_messages_fill_sms_conversation_id','guard_training_messages','messages_reject_dnc_locked_read');")!='3':raise RuntimeError('Canonical stamping/guards missing')
if scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='inbox_inbound_revision';")!='0' or scalar("SELECT to_regclass('public.inbox_inbound_heads') IS NULL;")!='t':raise RuntimeError('Candidate already installed; refusing before any fixture writes')
ORG=uid();ORG2=uid();CONTACT=uid();sql(f"INSERT INTO public.organizations(id,name) VALUES('{ORG}','T2 synthetic head proof'),('{ORG2}','T2 synthetic head proof second');INSERT INTO public.contacts(id,org_id,first_name) VALUES('{CONTACT}','{ORG}','T2 synthetic');")
pre=uid();preconv=uid();sql(message(pre,preconv))
# Client elapsed includes docker/psql overhead, same shape before/after capture.
def batch(count):
 conv=uid();start=time.perf_counter();sql(f"INSERT INTO public.messages(org_id,conversation_id,channel,direction,body) SELECT '{ORG}','{conv}','sms','inbound','T2 batch' FROM generate_series(1,{count});");return (time.perf_counter()-start)*1000
baseline_ms=[batch(100) for _ in range(3)]
candidate=HERE.parent/'sql/001-inbound-heads.sql'
# A held canonical writer must make candidate installation fail atomically.
try:
 install_holder=spawn(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 install_holder.stdin.write('BEGIN;'+message(uid(),uid())+"\n\\echo install_holder_ready\n");install_holder.stdin.flush();assert ready_line(install_holder)=='install_holder_ready'
 failed_install=sql(candidate.read_text(),False);assert failed_install.returncode!=0 and 'lock timeout' in failed_install.stderr
 install_holder.stdin.write('ROLLBACK;\n\\q\n');install_holder.stdin.flush();install_holder.wait(timeout=10)
 assert scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='inbox_inbound_revision';")=='0'
 assert scalar("SELECT to_regclass('public.inbox_inbound_heads') IS NULL;")=='t';passed('held source writer causes bounded install failure with no partial column/head schema')
 before_node=scalar("SELECT pg_relation_filenode('public.messages'::regclass);");install_start=time.perf_counter();sql(candidate.read_text());install_ms=(time.perf_counter()-install_start)*1000;after_node=scalar("SELECT pg_relation_filenode('public.messages'::regclass);");assert before_node==after_node;assert scalar("SELECT convalidated FROM pg_constraint WHERE conrelid='public.messages'::regclass AND conname='messages_inbox_inbound_revision_nonnegative';")=='f';passed('constant default installation preserves heap filenode and defers check validation',install_client_ms=install_ms);assert revision(pre)==0 and head(preconv)==0;passed('existing inbound baseline zero installed with capture',baseline_message=pre)
 # Actual legacy BEFORE trigger creates the identity; AFTER must capture its result.
 stamped=uid();sql(f"INSERT INTO public.messages(id,org_id,contact_id,channel,direction,body) VALUES('{stamped}','{ORG}','{CONTACT}','sms','inbound','T2 stamped');")
 stampedconv=scalar(f"SELECT conversation_id FROM public.messages WHERE id='{stamped}';");assert stampedconv and revision(stamped)==head(stampedconv)==1;passed('canonical BEFORE identity stamping captured by AFTER allocator')
 returning_id=uid();returning_conv=uid();returned=scalar(message(returning_id,returning_conv).rstrip(';')+' RETURNING inbox_inbound_revision;');assert returned=='0' and revision(returning_id)==1;passed('AFTER stamp is absent from INSERT RETURNING but present in following snapshot',returning_revision=returned,final_revision_text=str(revision(returning_id)))
 # Same-conversation inserts serialize, a rollback cannot leak a head revision.
 conv=uid();holderid=uid();waiterid=uid();holder=spawn(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write('BEGIN;'+message(holderid,conv)+"\n\\echo holder_ready\n");holder.stdin.flush()
 assert ready_line(holder)=='holder_ready'
 waitstart=time.perf_counter();waiter=spawn(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);waiter.stdin.write(message(waiterid,conv));waiter.stdin.close()
 for _ in range(50):
  if scalar("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%"+waiterid+"%';")!='0':break
  time.sleep(.02)
 else:raise AssertionError('waiter never observed blocked')
 assert waiter.poll() is None and head(conv)==0
 holder.stdin.write('ROLLBACK;\n\\q\n');holder.stdin.flush();holder.wait(timeout=10);waiter.wait(timeout=10)
 assert waiter.returncode==0 and revision(waiterid)==head(conv)==1
 passed('same-conversation waiter blocks and rollback does not allocate committed revision',observed_wait_ms=round((time.perf_counter()-waitstart)*1000,3))
 # Commit ordering, same transaction multiple inserts, destination re-entry, delete/reinsert.
 ids=[uid() for _ in range(3)];sql('BEGIN;'+''.join(message(mid,conv) for mid in ids)+'COMMIT;');assert [revision(mid) for mid in ids]==[2,3,4];passed('multiple inserts in one transaction receive ordered revisions')
 mid=ids[0];other=uid();sql(f"UPDATE public.messages SET conversation_id='{other}' WHERE id='{mid}';");assert revision(mid)==1 and head(other)==1
 sql(f"UPDATE public.messages SET conversation_id='{conv}' WHERE id='{mid}';");assert revision(mid)==5
 sql(f"UPDATE public.messages SET channel='email' WHERE id='{mid}';UPDATE public.messages SET channel='sms' WHERE id='{mid}';");assert revision(mid)==6
 sql(f"UPDATE public.messages SET direction='outbound' WHERE id='{mid}';UPDATE public.messages SET direction='inbound' WHERE id='{mid}';");assert revision(mid)==7
 sql(f"UPDATE public.messages SET org_id='{ORG2}' WHERE id='{mid}';UPDATE public.messages SET org_id='{ORG}' WHERE id='{mid}';");assert revision(mid)==8
 sql(f"DELETE FROM public.messages WHERE id='{mid}';"+message(mid,conv));assert revision(mid)==9;passed('organization/conversation/channel/direction re-entry and delete/reinsert allocate fresh destination revisions')
 old=head(conv);sql(f"UPDATE public.messages SET read_at=now() WHERE id='{mid}';UPDATE public.messages SET body='T2 corrected',from_address='+15550000111' WHERE id='{mid}';UPDATE public.messages SET inbox_inbound_revision=inbox_inbound_revision WHERE id='{mid}';");assert revision(mid)==old and head(conv)==old;passed('read/body/route/no-op revision updates do not create arrivals or recurse')
 # Row-before-head locking can deadlock legacy multi-statement writers. Prove it,
 # then retry the full aborted transaction; never retry only its last statement.
 deadconv=uid();dm1=uid();dm2=uid();sql((message(dm1,deadconv)+message(dm2,deadconv)).replace("'sms','inbound'","'sms','outbound'"))
 t1=spawn(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 t1.stdin.write(f"BEGIN;UPDATE public.messages SET direction='inbound' WHERE id='{dm1}';\n\\echo deadlock_holder_ready\n");t1.stdin.flush();assert ready_line(t1)=='deadlock_holder_ready'
 t2=spawn(PSQL,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);t2.stdin.write(f"BEGIN;UPDATE public.messages SET direction='inbound' WHERE id='{dm2}';COMMIT;\n");t2.stdin.close()
 for _ in range(80):
  if scalar("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%"+dm2+"%';")!='0':break
  time.sleep(.02)
 else:raise AssertionError('deadlock contender did not block')
 t1.stdin.write(f"UPDATE public.messages SET direction='inbound' WHERE id='{dm2}';COMMIT;\n\\q\n");t1.stdin.flush();t1.wait(timeout=10);t2.wait(timeout=10)
 stderr1=t1.stderr.read();stderr2=t2.stderr.read();assert (t1.returncode!=0) != (t2.returncode!=0);assert 'deadlock detected' in stderr1+stderr2
 if t1.returncode:sql(f"BEGIN;UPDATE public.messages SET direction='inbound' WHERE id='{dm1}';UPDATE public.messages SET direction='inbound' WHERE id='{dm2}';COMMIT;")
 else:sql(f"BEGIN;UPDATE public.messages SET direction='inbound' WHERE id='{dm2}';COMMIT;")
 assert head(deadconv)==2 and sorted([revision(dm1),revision(dm2)])==[1,2];passed('canonical row-before-head deadlock aborts one transaction; whole-transaction retry preserves exact stamps',deadlock_observed=True)
 # PostgreSQL bigint travels as text: no JavaScript Number conversion is used.
 bigconv=uid();bigmid=uid();sql(f"INSERT INTO public.inbox_inbound_heads VALUES('{ORG}','{bigconv}',9007199254740992);"+message(bigmid,bigconv));bigtext=scalar(f"SELECT inbox_inbound_revision::text FROM public.messages WHERE id='{bigmid}';");assert bigtext=='9007199254740993';passed('revision above2^53 survives explicit text transport',revision_text=bigtext)
 for role in ['authenticated','service_role']:
  result=sql(f"SET ROLE {role};SELECT * FROM public.inbox_inbound_heads;",False);assert result.returncode!=0 and '42501' in result.stderr and 'permission denied' in result.stderr;passed(role+' cannot directly read heads')
 # Service role bypasses RLS but must not forge the canonical stamp.
 for statement in [f"UPDATE public.messages SET inbox_inbound_revision=999999 WHERE id='{mid}';",message(uid(),conv,extra='inbox_inbound_revision=999999')]:
  result=sql('SET ROLE service_role;'+statement,False);assert result.returncode!=0 and 'INBOX_REVISION_SERVER_OWNED' in result.stderr;passed('service-role direct revision forgery denied')
 result=sql('SET ROLE authenticated;'+message(uid(),conv,extra='inbox_inbound_revision=999999'),False);assert result.returncode!=0 and 'INBOX_REVISION_SERVER_OWNED' in result.stderr;passed('authenticated direct INSERT revision forgery denied')
 result=sql("SET ROLE service_role;UPDATE public.inbox_inbound_heads SET revision=999999;",False);assert result.returncode!=0 and '42501' in result.stderr and 'permission denied' in result.stderr;passed('service_role direct head UPDATE denied despite BYPASSRLS')
 post_ms=[batch(100) for _ in range(3)]
 owner=scalar("SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='public.inbox_capture_inbound_head()'::regprocedure;")
 privileged_readers=json.loads(scalar("SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (SELECT p.oid::regprocedure::text AS function, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('authenticated',p.oid,'execute') AS authenticated_execute, has_function_privilege('service_role',p.oid,'execute') AS service_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.prosrc ILIKE '%messages%' ORDER BY 1) x;"))
 role_bypass=json.loads(scalar("SELECT json_build_object('authenticated_can_assume_allocator_owner',pg_has_role('authenticated','"+owner+"','MEMBER'),'service_role_can_assume_allocator_owner',pg_has_role('service_role','"+owner+"','MEMBER'));"))
 assert not any(role_bypass.values());passed('ordinary roles cannot assume allocator owner',**role_bypass)
 evidence=dict(at=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),source_revision=bootstrap.get('source_revision'),container_id=c['Id'],candidate_sha256=hashlib.sha256(candidate.read_bytes()).hexdigest(),checks=checks,measurements={'baseline_100_insert_client_ms':baseline_ms,'capture_100_insert_client_ms':post_ms},allocator_owner=owner,privileged_message_referencing_definers=privileged_readers,limits=['Offline canonical migration rehearsal only; no deployed schema or production volume claim','Client timings include Docker/psql startup and synthetic local contention','Head counter orders only one conversation; multi-key legacy transactions may deadlock and require retry','Allocator owner and other owner SECURITY DEFINER writers are privileged; no superuser protection claim','Body/route reply dependency version is a separate projection contract, not implemented here'])
 (HERE/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
finally:
 close_processes()
