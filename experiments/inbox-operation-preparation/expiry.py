#!/usr/bin/env python3
"""Natural five-minute expiry, never a clock override or immutable-row edit."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'));from guards import validate_container,validate_cron
if sys.argv[1:] not in [['--seed'],['--check']]:raise SystemExit('Explicit seed/check required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q,error=False):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=30)
 if error:return r
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
case=P/'expiry-case.json'
if sys.argv[1]=='--seed':
 if case.exists():raise RuntimeError('Existing expiry case; preserve it')
 org=json.loads((P/'behavior-evidence.json').read_text())['fixture_org']
 actor=json.loads(sql(f"SELECT jsonb_build_object('user_id',r.requester_id,'session_id',s.id,'conversation_id',p.snapshot->'items'->0->>'target_id') FROM inbox_action_api.preparation_requests r JOIN inbox_operations.preparations p ON p.id=r.preparation_id JOIN auth.sessions s ON s.user_id=r.requester_id JOIN organizations o ON o.id=r.org_id WHERE r.org_id='{org}' AND o.name='Authoritative actions {org}' AND p.snapshot->'items'->0->>'exclusion_code' IS NULL ORDER BY p.expires_at DESC LIMIT 1"))
 claims=json.dumps({'sub':actor['user_id'],'role':'authenticated','session_id':actor['session_id'],'exp':4102444800})
 auth=f'SET request.jwt.claims={lit(claims)};SET ROLE authenticated;'
 canonical=json.dumps({'purpose':'prepare_action','organizationId':org,'requesterId':actor['user_id'],'targets':[{'kind':'conversation','id':actor['conversation_id']}],'definition':{'version':1,'steps':[{'type':'outcome','value':'nurture'}]},'savedAction':None},separators=(',',':'));key=str(uuid.uuid4())
 prepared=json.loads(sql(auth+f'SELECT public.inbox_prepare_action({lit(canonical)},{lit(key)})'))
 if prepared['effect_count']!=1:raise RuntimeError('Expiry case not executable while fresh')
 case.write_text(json.dumps({'org':org,'claims':claims,'preparation_id':prepared['preparation_id'],'key':key,'expires_at':prepared['expires_at']},indent=2)+'\n')
 print('Natural expiry case seeded; check only after '+prepared['expires_at'])
else:
 row=json.loads(case.read_text());auth=f"SET request.jwt.claims={lit(row['claims'])};SET ROLE authenticated;";p=row['preparation_id'];k=row['key']
 if sql(f"SELECT expires_at<=clock_timestamp() FROM inbox_operations.preparations WHERE id='{p}'")!='t':raise SystemExit('Natural five-minute deadline has not passed; no mutation performed')
 recovered=json.loads(sql(auth+f"SELECT public.inbox_recover_operation('{p}','{k}')"))
 if recovered!={'state':'expired_not_accepted','operation':None}:raise RuntimeError('Expiry not definitive')
 retry=sql(auth+f"SELECT public.inbox_accept_action('{p}','{k}')",True)
 if retry.returncode==0 or 'Preparation expired' not in retry.stderr:raise RuntimeError('Expired original preparation accepted')
 if sql(f"SELECT count(*) FROM inbox_operations.operations WHERE org_id='{row['org']}' AND idempotency_key='{k}'")!='0':raise RuntimeError('Unexpected accepted operation')
 previous=json.loads(sql(f"SELECT jsonb_build_object('preparation_id',o.preparation_id,'key',o.idempotency_key,'operation_id',o.id,'accepted_at',o.created_at) FROM inbox_operations.operations o JOIN inbox_operations.preparations p ON p.id=o.preparation_id WHERE o.org_id='{row['org']}' AND p.expires_at<=clock_timestamp() ORDER BY o.created_at LIMIT 1"))
 recovered_existing=json.loads(sql(auth+f"SELECT public.inbox_recover_operation('{previous['preparation_id']}','{previous['key']}')"))
 expected={'operation_id':previous['operation_id'],'accepted_at':previous['accepted_at']}
 if recovered_existing!={'state':'accepted','operation':expected}:raise RuntimeError('Expired accepted preparation did not recover durable identity')
 if json.loads(sql(auth+f"SELECT public.inbox_accept_action('{previous['preparation_id']}','{previous['key']}')"))!=expected:raise RuntimeError('Expired accepted preparation replay changed identity')
 (P/'expiry-evidence.json').write_text(json.dumps({'checks':['natural five-minute never-posted preparation expiry returns definitive expired_not_accepted','later acceptance of same original preparation/key rejected with no operation','already accepted expired preparation recovers and replays original immutable identity'], 'case':row,'source_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [P/'setup.sql',P/'accept.sql',P/'review.sql']},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n')
 print('Natural expired-never-accepted recovery proved; later accept denied')
