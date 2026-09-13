#!/usr/bin/env python3
if not __debug__:raise SystemExit('Refusing optimized Python before fixture access')
import argparse,hashlib,json,select,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
p=argparse.ArgumentParser();p.add_argument('--run-owned-fixture',action='store_true');p.add_argument('--continue-installed',action='store_true');a=p.parse_args()
if not a.run_owned_fixture:raise SystemExit('Explicit fixture grant required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(ok,msg):
 if ok is not True:raise RuntimeError(msg)
def sql(s,check=True):
 r=subprocess.run(CMD,input="SET statement_timeout='20s';SET lock_timeout='2s';"+s,text=True,capture_output=True,timeout=30)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def uid():return str(uuid.uuid4())
def lit(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def stop(p):
 if p is None:return
 if p.poll() is None:
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
 for f in [p.stdin,p.stdout,p.stderr]:
  if f:f.close()
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0]);validate_cron(sql('SHOW cron.launch_active_jobs;'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong marker')
if a.continue_installed:
 for name,signature in [('sender_id','uuid,text'),('capture','')]:
  body=(P/'setup.sql').read_text().split('CREATE FUNCTION inbox_t2_message_capture.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
  need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_message_capture.{name}({signature})'::regprocedure;").strip()==body.strip(),'Installed source mismatch')
else:need(sql("SELECT to_regnamespace('inbox_t2_message_capture') IS NULL;")=='t','Already installed; refusing before writes')
original=sql("SELECT md5(string_agg(pg_get_triggerdef(oid),'|' ORDER BY tgname)) FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname<>'zzzzz_inbox_t2_message_direct';")
if not a.continue_installed:sql((P/'setup.sql').read_text())
org,org2,cid,pid,pid2,mid,othermid,otherconv=[uid() for _ in range(8)]
sql(f"BEGIN;INSERT INTO organizations(id,name) VALUES('{org}','Message capture {org}'),('{org2}','Message capture {org2}');INSERT INTO contacts(id,org_id,first_name) VALUES('{cid}','{org}','Capture');INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{org}','Synthetic {pid}','MO','{cid}'),('{pid2}','{org}','Synthetic {pid2}','MO','{cid}');COMMIT;")
def ins(mid,tenant=org,conv=None,contact=None,prop=None,raw='+18165550123',channel='sms',direction='inbound'):
 return f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,from_address,to_address,channel,direction,status,body) VALUES('{mid}','{tenant}',{lit(conv)},{lit(contact)},{lit(prop)},{lit(raw)},'+18162804181',{lit(channel)},{lit(direction)},'received','synthetic capture');"
def group(raw,tenant=org):
 return sql(f"SELECT sender_group_id FROM inbox_t2_message_capture.sender_groups WHERE org_id='{tenant}' AND raw_sender COLLATE \"C\"={lit(raw)} COLLATE \"C\";")
def dirty(target,kind='known_conversation',tenant=org):
 return int(sql(f"SELECT coalesce((SELECT generation FROM inbox_t2_message_capture.dirty WHERE org_id='{tenant}' AND target_kind={lit(kind)} AND target_id='{target}'),0);"))
def version(target,namespace='known_reply',tenant=org):
 return int(sql(f"SELECT coalesce((SELECT revision FROM inbox_t2_message_capture.versions WHERE org_id='{tenant}' AND namespace={lit(namespace)} AND target_id='{target}'),0);"))
def edge(mid,tenant=org):return sql(f"SELECT phone_e164 FROM inbox_t2_message_capture.route_edges WHERE org_id='{tenant}' AND message_id='{mid}';")
def allstate():return sql("SELECT jsonb_build_object("+','.join(f"'{t}',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) FROM inbox_t2_message_capture.{t} x)" for t in ['sender_buckets','sender_groups','dirty','versions','route_edges'])+");")
checks=[]
def passed(name):checks.append({'name':name,'passed':True})
holder=waiter=None
try:
 sql(ins(mid,contact=cid,prop=pid));conv=sql(f"SELECT conversation_id FROM messages WHERE id='{mid}';")
 need(bool(conv) and dirty(conv)==1 and version(conv)==1 and version(mid,'message_content')==1,'Final identity or nested stamp double counted');need(sql(f"SELECT inbox_inbound_revision>0 FROM messages WHERE id='{mid}';")=='t','Arrival not stamped');need(edge(mid)=='+18165550123','Route edge absent');passed('AFTER capture uses finalized canonical conversation; nested arrival self-stamp adds no dirty/content increment')
 sql(ins(othermid,conv=otherconv,contact=cid,prop=pid));unrelated=version(otherconv)
 for change in ["read_at=statement_timestamp()","status='delivered'","created_at=created_at+interval '1 second'","sent_at=statement_timestamp(),delivered_at=statement_timestamp(),error_message='display'"]:
  before=version(conv);sql(f"UPDATE messages SET {change} WHERE id='{mid}';");need(version(conv)==before,'Display change invalidated reply')
 passed('read_at, delivery-only status and timing do not invalidate prepared reply content')
 d,v=dirty(conv),version(conv);sql(f"UPDATE messages SET body='changed',from_address='(816) 555-0333',to_address='+18165550444' WHERE id='{mid}';")
 need(dirty(conv)==d+1 and version(conv)==v+1 and edge(mid)=='+18165550333','Content/route capture wrong');passed('body and address mutation dirty once, bump content once and update normalized source edge')
 v=version(conv);sql(f"UPDATE messages SET status='queued' WHERE id='{mid}';");need(version(conv)==v+1,'Queue eligibility change not versioned');v=version(conv);sql(f"UPDATE messages SET status='paused' WHERE id='{mid}';");need(version(conv)==v,'Equivalent excluded status changed content');sql(f"UPDATE messages SET status='received' WHERE id='{mid}';");need(version(conv)==v+1,'Eligibility return not versioned');passed('explicit conservative queued/paused boundary versions entry/exit; queued-to-paused remains display-only')
 d,v=dirty(conv),version(conv);sql(f"UPDATE messages SET metadata='{{\"fixture_policy\":true}}'::jsonb WHERE id='{mid}';")
 need(dirty(conv)==d and version(conv)==v+1,'Conservative metadata versioning wrong');passed('metadata change advances relevant content dependency without fabricated summary dirtiness')
 d,v=dirty(conv),version(conv);sql(f"UPDATE messages SET property_id='{pid2}' WHERE id='{mid}';");need(dirty(conv)==d+1 and version(conv)==v+1,'Property-link transition missed');passed('message property dependency replacement captured directly')
 raw=' 8165550555 ';umid=uid();sql(ins(umid,raw=raw));gid=group(raw);need(bool(gid) and dirty(gid,'unknown_sender')==1 and version(gid,'unknown_action')==1,'Unknown identity missing')
 variants=['8165550555','+18165550555','   '];ids=[]
 for raw2 in variants:
  x=uid();sql(ins(x,raw=raw2));ids.append(group(raw2))
 need(len(set([gid]+ids))==4,'Raw identity normalized/trimmed');sql(ins(uid(),tenant=org2,raw=raw));need(group(raw,org2)!=gid,'Cross-org unknown alias');passed('persistent unknown UUIDs preserve exact raw strings, whitespace and tenant identity')
 # Oversized raw keys are supported via bounded hash bucket + exact text comparison.
 longraw='x'*4000;sql(ins(uid(),raw=longraw));need(bool(group(longraw)),'Long raw sender could not be registered');passed('4000-character raw identity is not a truncated or oversized btree key')
 d,v=dirty(gid,'unknown_sender'),version(gid,'unknown_action');sql(f"UPDATE messages SET dismissed_at=statement_timestamp() WHERE id='{umid}';")
 need(dirty(gid,'unknown_sender')==d+1 and version(gid,'unknown_action')==v+1,'Unknown dismissal version absent');d,v=dirty(gid,'unknown_sender'),version(gid,'unknown_action');sql(f"UPDATE messages SET read_at=statement_timestamp(),status='delivered' WHERE id='{umid}';");need(dirty(gid,'unknown_sender')==d and version(gid,'unknown_action')==v,'Unrelated unknown read/status invalidated action');passed('dismissal advances unknown-action version; read/delivery status does not change unknown grouping or action version')
 d=dirty(gid,'unknown_sender');sql(f"UPDATE messages SET contact_id='{cid}',property_id='{pid}' WHERE id='{umid}';");matched=sql(f"SELECT conversation_id FROM messages WHERE id='{umid}';");need(dirty(gid,'unknown_sender')==d+1 and dirty(matched)>0,'Match failed to dirty departure/result');d=dirty(gid,'unknown_sender');sql(f"UPDATE messages SET contact_id=NULL WHERE id='{umid}';");need(group(raw)==gid and dirty(gid,'unknown_sender')==d+1,'Unmatch lost retained raw identity');passed('match/unmatch captures departed unknown and finalized known identities with stable sender UUID')
 newraw='8165550666';d=dirty(gid,'unknown_sender');sql(f"UPDATE messages SET from_address={lit(newraw)} WHERE id='{umid}';");newgid=group(newraw);need(dirty(gid,'unknown_sender')==d+1 and dirty(newgid,'unknown_sender')==1,'Raw sender move missed old/new group');passed('raw sender replacement dirties old and new typed targets')
 d=dirty(newgid,'unknown_sender');sql(f"UPDATE messages SET channel='email' WHERE id='{umid}';");need(dirty(newgid,'unknown_sender')==d+1 and edge(umid)=='','Channel departure failed');d=dirty(newgid,'unknown_sender');sql(f"UPDATE messages SET channel='sms' WHERE id='{umid}';");need(dirty(newgid,'unknown_sender')==d+1 and edge(umid)=='+18165550666','Channel reentry failed');passed('SMS/email exit and reentry capture memberships and source route edges')
 oldconv=conv;newconv=uid();d=dirty(oldconv);sql(f"UPDATE messages SET org_id='{org2}',conversation_id='{newconv}' WHERE id='{mid}';");need(dirty(oldconv)==d+1 and dirty(newconv,tenant=org2)==1 and edge(mid)=='' and edge(mid,org2)=='+18165550333','Cross-org identity/edge move failed');passed('organization/conversation move dirties both scoped identities and moves route edge')
 d,v=dirty(newgid,'unknown_sender'),version(umid,'message_content');sql(f"DELETE FROM messages WHERE id='{umid}';");need(group(newraw)==newgid and edge(umid)=='','Deletion removed stable identity or retained edge');sql(ins(umid,raw=newraw));need(group(newraw)==newgid and dirty(newgid,'unknown_sender')==d+2 and version(umid,'message_content')==v+2,'Delete/reinsert reset identity/counter');passed('delete/reinsert retains unknown UUID and persistent message/action generations while removing transient edges')
 before=allstate();rollbackraw='rollback-'+uid();sql('BEGIN;'+ins(uid(),raw=rollbackraw)+f"UPDATE messages SET body='rolled back' WHERE id='{othermid}';ROLLBACK;");need(allstate()==before,'Rollback leaked identity/dirty/version/edge changes');passed('rollback restores registry, dirty counters, versions and edges together')
 # Same new raw group in two real transactions; second must wait for first identity allocation.
 concurrentraw='concurrent-'+uid();x,y=uid(),uid();holder=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 holder.stdin.write("SET statement_timeout='10s';SET idle_in_transaction_session_timeout='15s';BEGIN;"+ins(x,raw=concurrentraw)+"\n\\echo ready\n");holder.stdin.flush()
 ready,_,_=select.select([holder.stdout],[],[],10);need(bool(ready) and holder.stdout.readline().strip()=='ready','Holder barrier missing')
 app='message-capture-'+uid();waiter=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 waiter.stdin.write("SET statement_timeout='10s';SET application_name="+lit(app)+';'+ins(y,raw=concurrentraw)+'\n');waiter.stdin.close();deadline=time.monotonic()+5;blocked=False
 while time.monotonic()<deadline:
  if sql(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name={lit(app)} AND cardinality(pg_blocking_pids(pid))>0);")=='t':blocked=True;break
  time.sleep(.02)
 need(blocked,'Concurrent insertion did not observe identity lock');holder.stdin.write('COMMIT;\n\\q\n');holder.stdin.flush();holder.wait(timeout=5);need(holder.returncode==0,'Holder commit failed');waiter.wait(timeout=5);need(waiter.returncode==0,'Waiter insert failed: '+waiter.stderr.read())
 g=group(concurrentraw);need(bool(g) and dirty(g,'unknown_sender')==2,'Concurrent raw insert split identity or lost dirtiness');need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.sender_groups WHERE org_id='{org}' AND raw_sender={lit(concurrentraw)};")=='1','Duplicate exact registry identity');passed('concurrent first inserts block then share one persistent sender UUID with two generations')
 need(version(otherconv)==unrelated,'Unrelated conversation reply version was invalidated');passed('all mutations leave unrelated conversation reply dependency unchanged')
 for role in ['authenticated','service_role']:
  r=sql(f"SET ROLE {role};SELECT inbox_t2_message_capture.sender_id('{org}','forged');",False);need(r.returncode!=0 and '42501' in r.stderr and 'permission denied' in r.stderr,'Registry helper externally callable')
 passed('authenticated/service roles cannot allocate registry identities directly')
 need(sql("SELECT md5(string_agg(pg_get_triggerdef(oid),'|' ORDER BY tgname)) FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname<>'zzzzz_inbox_t2_message_direct';")==original,'Earlier triggers changed');passed('all earlier capture/guard triggers preserved')
 evidence={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,'org':org,'other_org':org2,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'limits':['Private direct-message rehearsal; no parent fanout/expiry/backfill/production migration','Existing smaller lab dirty trigger also runs; duplicate lab effects are not deployment topology or write-amplification evidence','Queued/paused boundary versioning is a conservative implementation assumption pending full reply validation','Hash buckets serialize exact raw identity allocation; privileged direct table writes bypass helper invariant','No privileged restore/trigger-disable repair or universal deadlock-freedom proof']}
 (P/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks},indent=2))
except Exception as error:
 with (P/'attempts.jsonl').open('a') as f:f.write(json.dumps({'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'error':str(error),'checks':checks,'org':org})+'\n')
 raise
finally:stop(holder);stop(waiter)
