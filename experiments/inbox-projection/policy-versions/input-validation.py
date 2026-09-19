#!/usr/bin/env python3
if not __debug__: raise SystemExit('Optimized Python refused before fixture access')
import argparse,hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'fixture'))
from guards import validate_container,validate_cron
parser=argparse.ArgumentParser();parser.add_argument('--run-owned-fixture',action='store_true');parser.add_argument('--apply-validation',action='store_true');args=parser.parse_args()
if not args.run_owned_fixture: raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q,check=True):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose'],input="SET statement_timeout='20s';SET lock_timeout='2s';"+q,capture_output=True,text=True,timeout=30)
 if check and r.returncode: raise RuntimeError(r.stderr)
 return r.stdout.strip() if check else r
def need(value,label):
 if value is not True: raise RuntimeError(label)
def uid():return str(uuid.uuid4())
def lit(v):return "'"+str(v).replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','marker')
source=(P/'setup.sql').read_text();oldsource=(P/'setup-before-input-validation.sql').read_text()
def body(text,name):return text.split('CREATE FUNCTION inbox_t2_policy.'+name,1)[1].split('AS $$',1)[1].split('$$;',1)[0]
def verify(text,name,sig):need(sql(f"SELECT prosrc FROM pg_proc WHERE oid='inbox_t2_policy.{name}({sig})'::regprocedure").strip()==body(text,name).strip(),'Installed function mismatch: '+name)
if args.apply_validation:
 for name,sig in [('bump','jsonb'),('snapshot','uuid,jsonb')]:verify(oldsource,name,sig)
 need(sql("SELECT to_regprocedure('inbox_t2_policy.validate_key(text,jsonb)') IS NULL")=='t','Validation patch already installed; refusing replacement')
 statements=[]
 for name in ['validate_key','bump','snapshot']:
  start=source.index('CREATE FUNCTION inbox_t2_policy.'+name+'(');end=source.index('$$;',start)+3
  statements.append(source[start:end].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1))
 sql('BEGIN;'+''.join(statements)+'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_t2_policy FROM PUBLIC,anon,authenticated,service_role;COMMIT;')
for name,sig in [('validate_key','text,jsonb'),('bump','jsonb'),('snapshot','uuid,jsonb')]+[('capture_'+t,'') for t in json.loads((P/'field-map.json').read_text())]:verify(source,name,sig)
o=uid();entity=uid();checks=[]
def mark(n):checks.append({'name':n,'passed':True})
def rejected(q,label):
 r=sql('BEGIN;'+q+';ROLLBACK;',False);need(r.returncode!=0 and 'ERROR:' in r.stderr,label)
for value in ['NULL',"'null'::jsonb","'{}'::jsonb","'true'::jsonb","'1'::jsonb"]:
 rejected(f"SELECT inbox_t2_policy.snapshot('{o}',{value})",'Malformed requirements accepted')
 rejected(f"SELECT inbox_t2_policy.bump({value})",'Malformed event list accepted')
mark('SQL NULL, JSON null, object, boolean and numeric requirements/event lists rejected')
valid={'namespace':'property_identity','key':[entity]}
bad=[None,{}, {'namespace':None,'key':[entity]}, {'namespace':'unknown','key':[entity]}, {'namespace':'property_identity'}, {'namespace':'property_identity','key':None}, {'namespace':'property_identity','key':entity}, {'namespace':'property_identity','key':{}}, {'namespace':'property_identity','key':[None]}, {'namespace':'property_identity','key':['not-a-uuid']}, {'namespace':'property_identity','key':[entity,entity]}, {'namespace':'property_identity','key':[entity],'extra':True}, {'namespace':'contact_channel_consent','key':[entity,'fax']}, {'namespace':'route_policy','key':['email','+18165550791']}, {'namespace':'route_policy','key':['sms','18165550791']}, {'namespace':'route_policy','key':['sms',None]}]
for b in bad:
 rejected(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps([b]))}::jsonb)",'Malformed namespace/key accepted')
 event=b if not isinstance(b,dict) else {'org':o,**b}
 rejected(f"SELECT inbox_t2_policy.bump({lit(json.dumps([event]))}::jsonb)",'Malformed event key accepted')
mark('null/missing/unknown namespace and malformed typed keys, route/channel values and extra fields rejected')
for org in [None,1,'bad-org']:
 rejected(f"SELECT inbox_t2_policy.bump({lit(json.dumps([{'org':org,**valid}]))}::jsonb)",'Malformed organization accepted')
rejected(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps([valid,valid]))}::jsonb)",'Duplicate requirements accepted')
rejected(f"SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps([valid]))}::jsonb)",'Unseeded valid requirement accepted')
rejected(f"SELECT inbox_t2_policy.bump({lit(json.dumps([{'org':o,**valid},{'org':o,'namespace':'unknown','key':[entity]}]))}::jsonb)",'Mixed malformed batch accepted')
need(sql(f"SELECT count(*) FROM inbox_t2_policy.versions WHERE org_id='{o}'")=='0','Malformed batch leaked prefix write')
mark('invalid organization, duplicate/unseeded requirements and mixed valid/invalid batch fail without persisted prefix')
for table,items in json.loads((P/'field-map.json').read_text()).items():
 for ns,fields,key_fields in items:
  key=['sms','+18165550791'] if ns=='route_policy' else [entity,'sms'] if ns=='contact_channel_consent' else [entity]
  sql(f"SELECT inbox_t2_policy.validate_key({lit(ns)},{lit(json.dumps(key))}::jsonb)")
# Exercise new bump+snapshot path in a rolled-back private transaction with a valid typed key.
result=sql(f"BEGIN;SELECT inbox_t2_policy.bump({lit(json.dumps([{'org':o,**valid}]))}::jsonb);SELECT inbox_t2_policy.snapshot('{o}',{lit(json.dumps([valid]))}::jsonb);ROLLBACK;")
need('"revision": "1"' in result and sql(f"SELECT count(*) FROM inbox_t2_policy.versions WHERE org_id='{o}'")=='0','Valid typed vector failed or survived rollback')
mark('all fourteen supported key types validate; valid private bump/snapshot works and rollback removes test baseline')
for role in ['authenticated','service_role','anon']:
 for call in [f"inbox_t2_policy.bump({lit(json.dumps([{'org':o,**valid}]))}::jsonb)",f"inbox_t2_policy.snapshot('{o}',{lit(json.dumps([valid]))}::jsonb)"]:
  r=sql(f"SET ROLE {role};SELECT {call}",False);need(r.returncode!=0 and '42501' in r.stderr,'Private function executable by ordinary role')
need(sql("SELECT count(*)=10 AND bool_and(prosecdef AND array_to_string(proconfig,',')='search_path=\"\"' AND NOT has_function_privilege('anon',oid,'EXECUTE') AND NOT has_function_privilege('authenticated',oid,'EXECUTE') AND NOT has_function_privilege('service_role',oid,'EXECUTE')) FROM pg_proc WHERE pronamespace='inbox_t2_policy'::regnamespace")=='t','Private function security metadata mismatch')
need(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='inbox_t2_policy'::regnamespace AND a.grantee=0 AND a.privilege_type='EXECUTE')")=='t','PUBLIC execute privilege leaked')
need(sql("SELECT count(*)=7 AND bool_and(t.tgenabled='O' AND p.pronamespace='inbox_t2_policy'::regnamespace AND p.proname='capture_'||c.relname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND t.tgname='zzzzzz_inbox_t2_policy' AND c.relnamespace='public'::regnamespace AND c.relname IN ('properties','contacts','consent_events','sms_phone_suppressions','message_threads','ai_disposition_reviews','memberships')")=='t','Capture trigger attachment/enabled metadata mismatch')
mark('ordinary roles cannot call bump/snapshot; definer/search-path/ACL and all seven enabled source trigger attachments verified')
evidence={'at':sql('SELECT statement_timestamp()::text'),'checks':checks,'setup_sha256':hashlib.sha256((P/'setup.sql').read_bytes()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Focused private input validation only; earlier source-trigger/concurrency receipts correspond to preserved pre-validation setup','No new canonical source writes, authorization checks or production actions']}
(P/'input-validation-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence,indent=2))
