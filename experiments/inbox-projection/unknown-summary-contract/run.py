#!/usr/bin/env python3
"""Guarded synthetic unknown-group parity; exclusive DB window required."""
import argparse,hashlib,json,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent;ROOT=P.parents[2]
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
def lit(v):return 'NULL' if v is None else "'"+str(v).replace("'","''")+"'"
def uid():return str(uuid.uuid4())
a=argparse.ArgumentParser();a.add_argument('--run-owned-fixture',action='store_true');args=a.parse_args();need(args.run_owned_fixture and not sys.flags.optimize,'Explicit exclusive fixture grant required')
c=json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=10))[0];validate_container(c);validate_cron(sql('SHOW cron.launch_active_jobs;'));need(sql('SELECT marker FROM inbox_t2_fixture.identity;')=='sandra-inbox-projection-t2-owned-synthetic','Wrong marker')
boot=json.loads((P.parent/'fixture/bootstrap-result.json').read_text());need(boot.get('complete') is True and boot.get('status')=='ready','Bootstrap not ready')
ORG=uid();OTHER=uid();USER=uid();checks=[]
def passed(label,**kw):checks.append(dict(name=label,passed=True,**kw));print('PASS '+label,flush=True)
def msg(sender,age='1 hour',dismissed=False,org=ORG,**extra):
 mid=extra.pop('id',uid());fields={'id':mid,'org_id':org,'channel':'sms','direction':'inbound','status':'received','from_address':sender,'to_address':'+18162804181','body':'unknown synthetic','dismissed_at':ASOF if dismissed else None,**extra}
 sql('INSERT INTO messages('+','.join(fields)+',created_at) VALUES('+','.join(lit(v) for v in fields.values())+f',{lit(ASOF)}::timestamptz-interval {lit(age)});');return mid
def compute(sender,org=ORG):return json.loads(sql(f"SELECT inbox_t2_unknown_summary.compute({lit(org)},{lit(sender)},{lit(ASOF)});"))
def proposal(sender,action,limit=200):return json.loads(sql(f"SELECT inbox_t2_unknown_summary.propose_message_ids('{ORG}',{lit(sender)},{lit(action)},{limit});"))
try:
 need(sql("SELECT to_regnamespace('inbox_t2_unknown_summary') IS NULL;")=='t','Already installed: do not reset; coordinate continuation')
 setup=(P/'compute.sql').read_text();sql(setup);passed('private unknown summary and proposal SQL compile')
 ASOF=sql('SELECT statement_timestamp()::text;')
 sql(f"INSERT INTO organizations(id,name) VALUES('{ORG}','Unknown summary {ORG}'),('{OTHER}','Unknown summary {OTHER}');INSERT INTO auth.users(id,email) VALUES('{USER}','{USER}@example.invalid');INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{USER}','{ORG}','owner','active');")
 raw='+18165551001';old=msg(raw,'24000 hours');new=msg(raw,'1 hour',True);x=compute(raw);need(x['message_count']==2 and x['active_message_count']==1 and x['is_dismissed'] is True,'Latest classification or all-history count wrong');passed('latest dismissed hides group despite older active row; all history counts')
 active='(816) 555-1001';msg(active,'2 hours',True);latest=msg(active,'1 hour');need(compute(active)['visible_unknown'] is True and compute(active)['message_count']==2,'Latest active bucket wrong');need(compute(raw)['raw_sender_key']!=compute(active)['raw_sender_key'],'Raw formats merged');passed('latest active bucket and unnormalized distinct raw keys')
 msg(raw,'1 minute',org=OTHER);need(compute(raw)['message_count']==2 and compute(raw,OTHER)['message_count']==1,'Crossorg sender merge');passed('same raw sender remains separate within each organization')
 # A whitespace-only raw address is truthy in legacy JS; empty/null are excluded.
 msg(' ');msg('');msg(None);need(compute(' ')['exists'] is True and compute('')['exists'] is False,'Raw blank semantics changed');passed('whitespace retained while empty address is skipped')
 skip='skip-source';eligible=msg(skip,status='queued');msg(skip,'1 minute',channel='email');msg(skip,'2 minutes',direction='outbound');contact=uid();sql(f"INSERT INTO contacts(id,org_id,first_name) VALUES('{contact}','{ORG}','Unknown matched exclusion');");msg(skip,'3 minutes',contact_id=contact);need(compute(skip)['message_count']==1 and compute(skip)['latest_message_id']==eligible,'Canonical unknown predicates wrong');passed('queued status included but email outbound and matched contact excluded')
 # Suppression and test-like body do not remove unknown groups.
 suppressed='+18165551099';msg(suppressed,body='Canary Canary-test');sql(f"INSERT INTO sms_phone_suppressions(org_id,phone_e164,source) VALUES('{ORG}','{suppressed}','synthetic unknown parity');");need(compute(suppressed)['visible_unknown'] is True,'Invented suppression/noise filter');passed('unknown list preserves suppressed and test-like senders')
 big='many-source';sql(f"INSERT INTO messages(org_id,channel,direction,status,from_address,body,created_at) SELECT '{ORG}','sms','inbound','received','{big}','paged source', {lit(ASOF)}::timestamptz-n*interval '1 microsecond' FROM generate_series(1,1005)n;");need(compute(big)['message_count']==1005,'Full count truncated');p=proposal(big,'dismiss',200);need(p['complete'] is False and p['message_ids'] is None,'Overflow supplied partial actionable IDs');passed('1005-row count complete and bounded proposal rejects partial group')
 # Call actual source implementation via paginated mocked transport, with rows
 # read under one real active organization membership rather than owner-wide rows.
 claims=json.dumps({'sub':USER,'role':'authenticated'})
 rows=json.loads(sql(f"BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claims={lit(claims)};SET LOCAL request.jwt.claim.sub='{USER}';SELECT coalesce(json_agg(row_to_json(q)),'[]'::json) FROM (SELECT from_address,to_address,body,created_at,dismissed_at FROM messages WHERE channel='sms' AND direction='inbound' AND contact_id IS NULL AND from_address IS NOT NULL ORDER BY created_at DESC)q;ROLLBACK;"))
 oracle=subprocess.run([str(ROOT/'node_modules/.bin/tsx'),str(P/'parity-oracle.ts')],input=json.dumps(rows),text=True,capture_output=True,timeout=30);need(oracle.returncode==0,'Source oracle failed: '+oracle.stderr);expected=json.loads(oracle.stdout)
 summaries={row['fromAddress']:compute(row['fromAddress']) for row in expected['all']}
 for row in expected['all']:
  x=summaries[row['fromAddress']];need(x['message_count']==row['messageCount'] and x['is_dismissed']==row['isDismissed'] and x['to_address']==row['toAddress'] and x['latest_preview']==row['latestBody'][:120],'Actual source classifier parity mismatch')
 need({r['fromAddress'] for r in expected['active']}=={key for key,x in summaries.items() if x['visible_unknown'] is True},'Active group set mismatch');passed('actual legacy paginated classifier parity under single-org RLS',rows_read=len(rows),groups=len(summaries))
 tie='tie-source';low,high=sorted([uid(),uid()]);msg(tie,id=low);msg(tie,id=high,dismissed=True);x=compute(tie);need(x['latest_message_id']==high and x['latest_timestamp_tie_count']==2 and x['legacy_tie_parity_defined'] is False,'Tie diagnostic/order wrong');passed('new deterministic UUID tie ordering is explicitly not legacy tie parity')
 # Freeze proposal IDs in this synthetic harness, then admit a later eligible row.
 action='action-source';first=msg(action,'2 hours');out=msg(action,'1 hour',direction='outbound');email=msg(action,'1 hour',channel='email');ids=proposal(action,'dismiss')['message_ids'];need(ids==[first],'Proposal included ineligible transport');late=msg(action,'1 minute')
 sql(f"UPDATE messages SET dismissed_at=now() WHERE org_id='{ORG}' AND id=ANY(ARRAY[{','.join(lit(i) for i in ids)}]::uuid[]) AND channel='sms' AND direction='inbound' AND contact_id IS NULL AND dismissed_at IS NULL;")
 untouched=sql(f"SELECT count(*) FROM messages WHERE id=ANY(ARRAY['{late}','{out}','{email}']::uuid[]) AND dismissed_at IS NULL;");need(untouched=='3','Frozen ID mutation touched later/ineligible rows');need(proposal(action,'restore')['message_ids']==[first],'Restore proposal wrong');passed('frozen synthetic IDs exclude later arrivals and non-inbound-SMS rows')
 for role in ['authenticated','service_role']:
  r=sql(f"SET ROLE {role};SELECT inbox_t2_unknown_summary.compute('{ORG}','{raw}',now());",False);need(r.returncode!=0 and '42501' in r.stderr and 'permission denied' in r.stderr,'Private summary accessible')
 passed('private summary access denied with42501')
 result={'status':'PASS','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'org':ORG,'other_org':OTHER,'setup_sha256':hashlib.sha256(setup.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':checks,'limits':['No persisted sender_group_id mapping or operation workset; proposal never grants command authority','Legacy tie ordering undefined; UUID tie choice is explicit new determinism','Actual classifier called against SQL-filtered synthetic rows via mocked pagination; no PostgREST transport or browser proof','Counts scan full raw-sender history; no bounded-work or capacity claim','No90day, review, noise or suppression exclusion exists in canonical unknown list']}
 (P/'evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
except Exception as e:
 with (P/'attempts.jsonl').open('a') as f:f.write(json.dumps({'error':str(e),'org':ORG,'checks':checks})+'\n')
 raise
