#!/usr/bin/env python3
"""Canonical-only bounded seed for the explicitly owned full-Auth local candidate."""
import argparse,datetime,json,re,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
SANDRA_ORG_ID=str(uuid.UUID(re.search(r'SANDRA_ORG_ID = "([^"]+)"',(P.parent.parent/'src/lib/auth/sandra-org.ts').read_text()).group(1)))
ap=argparse.ArgumentParser();ap.add_argument('--prepare',action='store_true');ap.add_argument('--apply',action='store_true');ap.add_argument('--manifest',type=Path);ap.add_argument('--actor-user-id',type=uuid.UUID);ap.add_argument('--max-batches',type=int,default=10);a=ap.parse_args()
if a.prepare==a.apply:raise SystemExit('Choose --prepare or --apply')
if a.prepare:
 run=str(uuid.uuid4());manifest={'version':1,'run_id':run,'organization_id':SANDRA_ORG_ID,'as_of':datetime.datetime.now(datetime.timezone.utc).isoformat(),'known':108000,'unknown':12000,'batch_size':100,'expected_messages':147000,'expected_summaries':120000,'creation_mode':'source-only-manifest'}
 path=P/('manifest-'+run+'.json');path.write_text(json.dumps(manifest,indent=2)+'\n');print(path);sys.exit(0)
if not a.manifest or not a.actor_user_id or not 1<=a.max_batches<=100:raise SystemExit('Apply requires manifest, fresh synthetic actor and 1..100 batches')
m=json.loads(a.manifest.read_text());run=uuid.UUID(m['run_id']);actor=str(a.actor_user_id);org=str(uuid.UUID(m['organization_id']));base=datetime.datetime.fromisoformat(m['as_of'])
if org!=SANDRA_ORG_ID or base.tzinfo is None:raise SystemExit('Manifest identity/clock invalid')
if {k:m[k] for k in ['version','known','unknown','batch_size','expected_messages','expected_summaries']}!={'version':1,'known':108000,'unknown':12000,'batch_size':100,'expected_messages':147000,'expected_summaries':120000}:raise SystemExit('Unexpected fixed volume contract')
sys.path.insert(0,str(P.parent/'inbox-production-install'))
from fixture_db import guard,sql,literal
guard()
def ident(kind,i):return str(uuid.uuid5(run,f'{kind}:{i}'))
def rows(values):return ','.join('('+','.join('NULL' if v is None else literal(v) for v in row)+')' for row in values)
# Fixture-only checkpoint metadata, not a new production architecture/schema.
sql('CREATE TABLE IF NOT EXISTS install_fixture.volume_runs(run_id uuid PRIMARY KEY,org_id uuid NOT NULL,actor_id uuid NOT NULL,configuration jsonb NOT NULL,next_row integer NOT NULL DEFAULT 0)',role='supabase_admin')
existing=sql(f"SELECT row_to_json(r) FROM install_fixture.volume_runs r WHERE run_id='{run}'",role='supabase_admin')
if not existing:
 if sql(f"SELECT count(*) FROM organizations WHERE id='{org}'")!='1':raise RuntimeError('Canonical Sandra organization missing')
 if sql(f"SELECT count(*) FROM auth.users WHERE id='{actor}'")!='1' or sql(f"SELECT count(*) FROM memberships WHERE user_id='{actor}' AND access_status='active'")!='0':raise RuntimeError('Actor must be a fresh real Auth user with no active membership')
 sql(f"BEGIN;SET LOCAL ROLE postgres;INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{actor}','{org}','owner','active');RESET ROLE;INSERT INTO install_fixture.volume_runs(run_id,org_id,actor_id,configuration) VALUES('{run}','{org}','{actor}',{literal(json.dumps(m))});COMMIT;",role='supabase_admin')
else:
 stored=json.loads(existing)
 if stored['org_id']!=org or stored['actor_id']!=actor or stored['configuration']!=m:raise RuntimeError('Existing run identity/configuration differs')
receipts=[]
for _ in range(a.max_batches):
 start=int(sql(f"SELECT next_row FROM install_fixture.volume_runs WHERE run_id='{run}'",role='supabase_admin'));end=min(start+100,120000)
 if start==end:break
 contacts=[];properties=[];messages=[];outcomes=[]
 for i in range(start,end):
  at=base-datetime.timedelta(hours=i%2136);phone='+1555'+f'{i:07d}'
  if i<108000:
   c,p,conv=ident('contact',i),ident('property',i),ident('conversation',i)
   contacts.append((c,org,'Volume '+str(i),'Needle' if i%100==0 else 'Contact'))
   properties.append((p,org,'Owned volume property '+str(i),'MO','contacted',c,actor if i%2==0 else None))
   messages.append((ident('message',i),org,conv,c,p,'sms','inbound','received','Owned volume '+str(run)+' inquiry '+str(i),phone,'+18162804181',at.isoformat()))
   if i%4==0:
    outbound=i%8==0
    messages.append((ident('extra-message',i),org,conv,c,p,'sms','outbound' if outbound else 'inbound','sent' if outbound else 'received','Owned volume '+str(run)+' follow-up '+str(i),'+18162804181' if outbound else phone,phone if outbound else '+18162804181',(at+datetime.timedelta(minutes=1)).isoformat()))
   if i%10<3:outcomes.append((p,'nurture' if i%10<2 else 'not_interested'))
  else:messages.append((ident('unknown-message',i),org,None,None,None,'sms','inbound','received','Owned volume '+str(run)+' unknown inquiry '+str(i),'owned-volume-'+str(run)+'-'+str(i),'+18162804181',at.isoformat()))
 statements=[]
 if contacts:statements.append('INSERT INTO contacts(id,org_id,first_name,last_name) VALUES '+rows(contacts)+';')
 if properties:statements.append('INSERT INTO properties(id,org_id,address,state,status,homeowner_contact_id,assigned_user_id) VALUES '+rows(properties)+';')
 statements.append('INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address,created_at) VALUES '+rows(messages)+';')
 if outcomes:statements.append('UPDATE properties p SET outreach_dispo=v.outcome FROM (VALUES '+rows(outcomes)+')v(id,outcome) WHERE p.id=v.id::uuid;')
 checkpoint=f"RESET ROLE;UPDATE install_fixture.volume_runs SET next_row={end} WHERE run_id='{run}' AND next_row={start};"
 # Advisory run lock + checkpoint assertion prevents overlapping seed writers.
 query=f"BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('{run}',0));DO $$ BEGIN IF (SELECT next_row FROM install_fixture.volume_runs WHERE run_id='{run}')<>{start} THEN RAISE EXCEPTION 'Concurrent seed run';END IF;END $$;SET LOCAL ROLE postgres;"+''.join(statements)+checkpoint+'COMMIT;'
 started=time.monotonic();sql(query,role='supabase_admin');receipts.append({'start':start,'end':end,'seconds':time.monotonic()-started,'canonical_messages':len(messages)})
progress=int(sql(f"SELECT next_row FROM install_fixture.volume_runs WHERE run_id='{run}'",role='supabase_admin'))
known=min(progress,108000);unknown=max(0,progress-108000)
expected={'messages':known+(known+3)//4+unknown,'conversations':known,'unknown_senders':unknown}
actual=json.loads(sql(f"SELECT jsonb_build_object('messages',count(*),'conversations',count(DISTINCT conversation_id),'unknown_senders',count(DISTINCT from_address) FILTER(WHERE contact_id IS NULL)) FROM messages WHERE org_id='{org}' AND body LIKE 'Owned volume {run} %'"))
if actual!=expected:raise RuntimeError('Canonical seed reconciliation failed: '+json.dumps({'expected':expected,'actual':actual}))
result={'run_id':str(run),'organization_id':org,'batches':receipts,'canonical_counts':actual,'progress':progress,'scope':'Owned fixture canonical writes only; worker drain and summary reconciliation are separate'}
receipt=P/f'receipt-{run}-{progress}.json';receipt.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
