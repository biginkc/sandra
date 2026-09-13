#!/usr/bin/env python3
if not __debug__:raise SystemExit('Refusing optimized Python before fixture access')
import argparse,hashlib,json,select,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
p=argparse.ArgumentParser();p.add_argument('--run-owned-fixture',action='store_true');a=p.parse_args()
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
source=json.loads((P/'evidence.json').read_text());org,org2=source['org'],source['other_org']
need(sql("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='zzzzz_inbox_t2_message_direct';")=='O','Direct capture disabled')
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
raw='supplement-'+uid();mid=uid();conv=uid();sql(ins(mid,conv=conv,raw=raw));g=group(raw)
d=dirty(g,'unknown_sender');v=version(conv);sql(f"UPDATE messages SET direction='outbound',to_address='8165550777' WHERE id='{mid}';")
need(dirty(g,'unknown_sender')==d+1 and version(conv)==v+1 and edge(mid)=='+18165550777','Direction transition failed')
d=dirty(g,'unknown_sender');sql(f"UPDATE messages SET direction='inbound',from_address='8165550888' WHERE id='{mid}';");newg=group('8165550888');need(dirty(g,'unknown_sender')==d and dirty(newg,'unknown_sender')>0 and edge(mid)=='+18165550888','Inbound reentry failed')
passed('direction transitions dirty departing/entering unknown identities and use the customer side of route edges')
v=version(mid,'message_content');newmid=uid();d=dirty(newg,'unknown_sender');sql(f"UPDATE messages SET id='{newmid}' WHERE id='{mid}';")
need(version(mid,'message_content')==v+1 and version(newmid,'message_content')==1 and dirty(newg,'unknown_sender')==d+1 and edge(mid)=='' and edge(newmid)=='+18165550888','SourceID replacement failed')
passed('source UUID replacement retains old version and creates new version while moving edge')
d=dirty(newg,'unknown_sender');sql(f"UPDATE messages SET org_id='{org2}' WHERE id='{newmid}';")
g2=group('8165550888',org2);need(g2!=newg and dirty(newg,'unknown_sender')==d+1 and dirty(g2,'unknown_sender',org2)>0 and edge(newmid)=='' and edge(newmid,org2)=='+18165550888','Unknown tenant move failed')
passed('unknown organization move retains distinct scoped sender UUIDs and dirties both')
# Latest timestamp ties remain a legacy query ambiguity; capture assigns no new tie policy.
a,b=uid(),uid();rawtie='tie-'+uid();at=sql('SELECT statement_timestamp()::text;')
sql(ins(a,raw=rawtie)+ins(b,raw=rawtie)+f"UPDATE messages SET created_at={lit(at)} WHERE id IN ('{a}','{b}');")
gt=group(rawtie);need(bool(gt) and sql(f"SELECT count(*) FROM inbox_t2_message_capture.sender_groups WHERE org_id='{org}' AND raw_sender={lit(rawtie)};")=='1','Tied source rows split identity')
d,v=dirty(gt,'unknown_sender'),version(gt,'unknown_action');sql(f"UPDATE messages SET created_at=created_at+interval '1 microsecond' WHERE id='{a}';")
need(dirty(gt,'unknown_sender')==d+1 and version(gt,'unknown_action')==v,'Timestamp display change invalidated action')
passed('equal timestamps share raw identity; microsecond ordering changes dirty display without inventing unknown tie policy')
count=sql(f"SELECT count(*) FROM inbox_t2_message_capture.sender_groups WHERE org_id='{org}';")
sql(ins(uid(),raw='')+ins(uid(),raw=None));need(sql(f"SELECT count(*) FROM inbox_t2_message_capture.sender_groups WHERE org_id='{org}';")==count,'Empty/null raw created unknown identity')
passed('NULL and empty sender excluded while initial proof preserves nonempty whitespace')
e={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checks':checks,'org':org,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'limits':['No winner assertion for equal-timestamp unknown messages: legacy tie behavior remains undefined','Additional synthetic rows only; no parent fanout or expiry implementation']}
(P/'supplement-evidence.json').write_text(json.dumps(e,indent=2)+'\n');print(json.dumps(e,indent=2))
