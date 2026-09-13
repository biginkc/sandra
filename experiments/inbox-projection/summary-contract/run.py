#!/usr/bin/env python3
"""Source-parity fixtures, only under an explicitly granted offline DB window."""
import argparse,hashlib,json,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
PSQL=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def need(v,msg):
 if v is not True:raise RuntimeError(msg)
def sql(s,check=True):
 r=subprocess.run(PSQL,input="SET statement_timeout='20s';SET lock_timeout='2s';\n"+s,text=True,capture_output=True,timeout=30)
 if check and r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def uid():return str(uuid.uuid4())
def lit(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def ins(table,values):return 'INSERT INTO public.'+table+'('+','.join(values)+') VALUES('+','.join(lit(v) for v in values.values())+');'
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--continue-installed',action='store_true');args=parser.parse_args()
need(args.run_owned_fixture and not sys.flags.optimize,'Explicit fixture grant and unoptimized Python required')
c=json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=10))[0];validate_container(c);validate_cron(sql('SHOW cron.launch_active_jobs;'))
boot=json.loads((P.parent/'fixture/bootstrap-result.json').read_text());need(boot.get('complete') is True and boot.get('status')=='ready','Fixture not ready')
need(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture marker')
setup=(P/'compute.sql').read_text();checks=[];ORG=uid();OTHER=uid();USER=uid()
def passed(label,**kw):checks.append({'name':label,'passed':True,**kw});print('PASS '+label,flush=True)
def compute(conv,org=ORG,asof=None,timezone='UTC'):
 return json.loads(sql(f"SET TIME ZONE {lit(timezone)};SELECT inbox_t2_summary_contract.compute({lit(org)},{lit(conv)},{lit(asof or ASOF)}::timestamptz);"))
def fixture(label,age='1 hour',property=True,status='contacted',outcome=None,contact=True,conv=None,org=ORG):
 conv=conv or uid();cid=uid() if contact else None;pid=uid() if property else None;mid=uid()
 statements=''
 if cid:statements+=ins('contacts',{'id':cid,'org_id':org,'first_name':'Summary','last_name':label})
 if pid:statements+=ins('properties',{'id':pid,'org_id':org,'address':'Synthetic '+label+' '+pid,'state':'MO','status':status,'homeowner_contact_id':cid,'outreach_dispo':outcome})
 statements+=f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address,created_at) VALUES({lit(mid)},{lit(org)},{lit(conv)},{lit(cid)},{lit(pid)},'sms','inbound','received',{lit('Summary '+label)},'+18165550101','+18162804181',{lit(ASOF)}::timestamptz-interval {lit(age)});"
 sql(statements);return dict(conv=conv,cid=cid,pid=pid,mid=mid,org=org)
def review(f,property=None):
 rid=uid();sql(ins('ai_disposition_reviews',{'id':rid,'org_id':f['org'],'property_id':property or f['pid'],'conversation_id':f['conv'],'source_inbound_message_id':f['mid'],'disposition':'not_interested','ai_reason':'Synthetic source parity','status':'pending'}));return rid
def rpc(filter,hide=False):
 claims=json.dumps({'sub':USER,'role':'authenticated'})
 return json.loads(sql(f"BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claims={lit(claims)};SET LOCAL request.jwt.claim.sub={lit(USER)};SELECT public.sms_inbox_thread_page_snapshot({lit(ASOF)}::timestamptz-interval '2160 hours',{lit(filter)},'{USER}',NULL,{str(hide).lower()},500,0,NULL);ROLLBACK;"))
try:
 if args.continue_installed:
  actual=sql("SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_summary_contract.compute(uuid,uuid,timestamptz)'::regprocedure;")
  expected=setup.split("AS $$\n",1)[1].rsplit('\n$$;',1)[0]
  need(actual.strip()==expected.strip(),'Installed function differs; no automatic replacement')
 else:
  need(sql("SELECT to_regnamespace('inbox_t2_summary_contract') IS NULL;")=='t','Already installed; explicit continuation required')
  sql(setup)
 passed('private compute SQL compiles on canonical fixture')
 ASOF=sql('SELECT statement_timestamp()::text;')
 sql(ins('organizations',{'id':ORG,'name':'Summary '+ORG})+ins('organizations',{'id':OTHER,'name':'Summary '+OTHER})+f"INSERT INTO auth.users(id,email) VALUES('{USER}','{USER}@example.invalid');"+ins('memberships',{'user_id':USER,'org_id':ORG,'role':'owner','access_status':'active'}))
 main=fixture('recent');x=compute(main['conv']);need(x['exists'] is True and x['unread_count']==1 and x['needs_outcome'] is True,'Recent canonical fields wrong');passed('recent row fields and existing needs-outcome predicate')
 # Cutoff is inclusive; dropping it changes unread even while newer history remains.
 edge=fixture('edge','2160 hours');x=compute(edge['conv']);later=sql(f"SELECT ({lit(ASOF)}::timestamptz+interval '1 microsecond')::text;");need(x['exists'] is True and compute(edge['conv'],asof=later)['exists'] is False,'Expiry boundary wrong');passed('exact90day boundary and one-microsecond expiry')
 no=fixture('old','2400 hours');need(compute(no['conv'])['exists'] is False,'Old nonreview visible');rid=review(no);x=compute(no['conv']);need(x['has_recent'] is False and x['visible_review'] is True and x['unread_count']==1,'Old review exception wrong');passed('old pending review exception independent of recent window')
 sql(f"UPDATE ai_disposition_reviews SET status='superseded',resolved_at=now(),superseded_reason='synthetic close' WHERE id='{rid}';");need(compute(no['conv'])['exists'] is False,'Closed review remained visible');passed('closing old review produces keyed tombstone')
 oldreview=fixture('old-review','2400 hours',outcome='not_interested');review(oldreview)
 mismatch=fixture('review-mismatch');review(mismatch,main['pid']);need(compute(mismatch['conv'])['visible_review'] is False,'Mismatched review property joined');passed('pending review joins only selected property')
 # Propertyless recent row can inherit pending-review property.
 fallback=fixture('fallback',property=False);review(fallback,main['pid']);need(compute(fallback['conv'])['property_id']==main['pid'],'Review fallback missing');passed('recent propertyless review fallback')
 # Recent cohort must exclude old unread even with a pending review.
 recent=fixture('recent-old');oldid=uid();sql(f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,created_at) VALUES('{oldid}','{ORG}','{recent['conv']}','{recent['cid']}','{recent['pid']}','sms','inbound','received','old unread',{lit(ASOF)}::timestamptz-interval '2400 hours');");review(recent);need(compute(recent['conv'])['unread_count']==1,'Old unread leaked into recent cohort');passed('recent cohort ignores old unread while pending review exists')
 # New queued/paused/contactless/email rows cannot supersede canonical latest.
 for status,channel,contact in [('queued','sms',main['cid']),('paused','sms',main['cid']),('received','sms',None),('received','email',main['cid'])]:
  sql(ins('messages',{'id':uid(),'org_id':ORG,'conversation_id':main['conv'],'contact_id':contact,'property_id':main['pid'],'channel':channel,'direction':'inbound','status':status,'body':'excluded'}))
 need(compute(main['conv'])['last_message_id']==main['mid'],'Excluded latest row selected');passed('queued paused contactless and email rows excluded')
 # Route follows latest message direction, not contact phone.
 latest=uid();sql(ins('messages',{'id':latest,'org_id':ORG,'conversation_id':main['conv'],'contact_id':main['cid'],'property_id':main['pid'],'channel':'sms','direction':'outbound','status':'sent','body':'x'*180,'from_address':'+18162804181','to_address':'+18165550222'}));x=compute(main['conv']);need(x['thread_customer_phone']=='+18165550222' and len(x['last_message_preview'])==120,'Route/preview wrong');passed('latest outbound route and narrow120-character preview')
 same=fixture('shared-property',property=False);sql(f"UPDATE messages SET property_id='{main['pid']}' WHERE id='{same['mid']}';");need(compute(same['conv'])['conversation_id']!=x['conversation_id'] and compute(same['conv'])['property_id']==x['property_id'],'Property merged identities');passed('shared property preserves separate conversation identities')
 cross=fixture('crossorg',conv=main['conv'],org=OTHER);need(compute(main['conv'],org=OTHER)['contact_id']==cross['cid'] and compute(main['conv'])['contact_id']==main['cid'],'Tenant scope leak');passed('same conversation UUID in two organizations stays scoped')
 prospect=fixture('prospect',status='prospect');need(compute(prospect['conv'])['assignment_eligible'] is False,'Prospect assignment eligible');sql(f"UPDATE properties SET assigned_user_id='{USER}' WHERE id='{main['pid']}';");need(compute(main['conv'])['assigned_user_id']==USER,'Owner missing');passed('assignment lead boundary and raw owner preserved')
 # Deterministic consent order uses timestamp plus UUID.
 cons=fixture('consent');a,b=sorted([uid(),uid()]);sql(ins('consent_events',{'id':a,'org_id':ORG,'contact_id':cons['cid'],'channel':'sms','event_type':'opt_out','occurred_at':ASOF})+ins('consent_events',{'id':b,'org_id':ORG,'contact_id':cons['cid'],'channel':'sms','event_type':'opt_in_confirmed','occurred_at':ASOF}));need(compute(cons['conv'])['is_opted_out'] is False,'Consent tie ordering wrong');sql(f"UPDATE contacts SET sms_opted_out=true WHERE id='{cons['cid']}';");need(compute(cons['conv'])['is_opted_out'] is True,'Contact optout not dominant');passed('latest consent tie ordering and contact optout precedence')
 noise=fixture('noise',outcome='dnc');review(noise);x=compute(noise['conv']);need(x['is_noise'] is True and x['visible_all_hide_noise'] is False and x['visible_review'] is True,'DNC review visibility wrong');test=fixture('test-traffic');review(test);sql(f"UPDATE contacts SET entity_name='Canary Canary-test' WHERE id='{test['cid']}';");need(compute(test['conv'])['visible_review'] is False,'Test traffic review visible');passed('DNC remains reviewable but test traffic never does')
 # Route suppression is tenant/channel scoped and normalizes10digitUS display.
 suppressed=fixture('suppressed');sql(f"UPDATE messages SET from_address='8165550999' WHERE id='{suppressed['mid']}';")
 sql(ins('sms_phone_suppressions',{'org_id':OTHER,'phone_e164':'+18165550999','source':'synthetic parity'}));need(compute(suppressed['conv'])['is_phone_suppressed'] is False,'Crossorg phone suppression leaked')
 sql(ins('sms_phone_suppressions',{'org_id':ORG,'phone_e164':'+18165550999','source':'synthetic parity'}));need(compute(suppressed['conv'])['is_phone_suppressed'] is True,'10digit route suppression not normalized');passed('phone suppression normalizes route and remains organization scoped')
 tied=fixture('tied');low,high=sorted([uid(),uid()])
 for mid,pid in [(low,main['pid']),(high,None)]:
  sql(ins('messages',{'id':mid,'org_id':ORG,'conversation_id':tied['conv'],'contact_id':tied['cid'],'property_id':pid,'channel':'sms','direction':'inbound','status':'received','body':mid,'created_at':ASOF}))
 t=compute(tied['conv']);need(t['last_message_id']==high and t['property_id']==main['pid'],'LatestUUID or latestnonnullproperty wrong');passed('equal timestamp chooses highestUUID and latestnonnullproperty independently')
 missing=compute(uid());need(missing['exists'] is False,'Missing scope not tombstone')
 invalid=json.loads(sql(f"SELECT inbox_t2_summary_contract.compute(NULL,'{main['conv']}',now());"));need(invalid=={'error':'invalid_compute_scope'},'NULL scope accepted');passed('missing and invalid compute scope fail explicitly')
 # Contextful source RPC is the parity oracle. Its requester membership filters only own org.
 fields=['contact_id','contact_name','thread_customer_phone','thread_business_phone','property_id','property_address','property_status','outreach_dispo','unread_count','has_inbound','needs_outcome','is_opted_out','is_test_traffic','ai_responder_status','ai_disposition_review_id','ai_disposition_review_status','ai_disposition_review_disposition','ai_disposition_review_source_inbound_message_id']
 parity=0
 for filter,hide in [('all',False),('all',True),('dispo',False),('dispo',True)]:
  result=rpc(filter,hide);need('__error' not in result,'RPC ambiguity/error')
  all_convs=json.loads(sql(f"SELECT json_agg(DISTINCT conversation_id) FROM messages WHERE org_id='{ORG}' AND conversation_id IS NOT NULL;"))
  key='visible_review' if filter=='dispo' else ('visible_all_hide_noise' if hide else 'visible_all_show_noise')
  expected_ids={conv for conv in all_convs if compute(conv).get(key) is True}
  need({row['thread_id'] for row in result['rows']}==expected_ids,'Compute/RPC visibility set mismatch')
  for row in result['rows']:
   out=compute(row['thread_id'])
   for field in fields:need(out[field]==row[field],f'RPC parity mismatch {field}: {out[field]!r} != {row[field]!r}')
   need(out['assigned_user_id']==row['assignee_id'],'Owner mapping mismatch');need(out['last_message_preview']==row['last_message_body'][:120],'Preview parity mismatch')
   need(out['visible_review'] is True if filter=='dispo' else out['visible_all_hide_noise' if hide else 'visible_all_show_noise'] is True,'Visibility mismatch');parity+=1
 passed('existing authenticated Inbox RPC field and visibility parity',compared_rows=parity,filters=['all/show-noise','all/hide-noise','dispo/show-noise','dispo/hide-noise'])
 # As-of is elapsed hours irrespective of session timezone; compare semantic fields.
 dstfixture=fixture('dst-window');dst_asof='2026-05-01 12:00:00+00';sql(f"UPDATE messages SET created_at={lit(dst_asof)}::timestamptz-interval '2160 hours' WHERE id='{dstfixture['mid']}';");utc=compute(dstfixture['conv'],asof=dst_asof,timezone='UTC');dst=compute(dstfixture['conv'],asof=dst_asof,timezone='America/Chicago');need(utc['exists'] is True and dst['exists'] is True and utc['last_message_id']==dst['last_message_id'] and utc['unread_count']==dst['unread_count'],'Timezone changed elapsed cutoff');passed('DST-spanning2160hour boundary has identical membership across timezones')
 for role in ['authenticated','service_role']:
  r=sql(f"SET ROLE {role};SELECT inbox_t2_summary_contract.compute('{ORG}','{main['conv']}',now());",False);need(r.returncode!=0 and '42501' in r.stderr and 'permission denied' in r.stderr,'Private compute callable by '+role)
 passed('private compute denies authenticated and service roles with42501')
 result={'status':'PASS','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'setup_sha256':hashlib.sha256(setup.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'org':ORG,'other_org':OTHER,'as_of':ASOF,'checks':checks,'limits':['Synthetic small cohorts; no bounded-scan or production workload claim','RPC uses simulated DB auth claims for own fixture membership; no JWT or external API verification','Compute remains worker-private and is not integrated with generation/CAS or dirty fanout','Case plan has additional scenarios not yet executed; use actual check list as evidence']}
 (P/'evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
except Exception as e:
 with (P/'attempts.jsonl').open('a') as f:f.write(json.dumps({'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'error':str(e),'checks':checks,'org':ORG})+'\n')
 raise
