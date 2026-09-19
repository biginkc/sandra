#!/usr/bin/env python3
"""One-time private owned installation with exact writer-capture preconditions."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q):return subprocess.check_output(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,timeout=40).strip()
def lit(v):return "'"+v.replace("'","''")+"'"
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
if sql("SELECT to_regnamespace('inbox_action_api') IS NULL")!='t':raise RuntimeError('Existing action API; refusing overwrite')
files=[P.parent/'inbox-projection/policy-versions/setup.sql',P.parent/'inbox-operation-domain/setup.sql',P.parent/'inbox-operation-domain/restrictive-scope.sql',P.parent/'inbox-operation-domain/restrictive-effect.sql',P.parent/'inbox-operation-domain/restrictive-apply.sql']
guards=[];functions={};triggers=[]
for path in files:
 source=path.read_text()
 for name,body in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\([^;]*?AS \$\$(.*?)\$\$;',source,re.S):
  if name.startswith('inbox_t2_policy.') or name.endswith(('.capture_target','.capture_sms_scope','.apply_property_step','.apply_sms_opt_out')):functions[name]=body
 for table,name in re.findall(r'CREATE TRIGGER \w+ AFTER INSERT OR UPDATE OR DELETE ON (public\.\w+)\s+FOR EACH ROW EXECUTE FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\(\);',source):
  if name.startswith('inbox_t2_policy.') or name.endswith(('.capture_target','.capture_sms_scope')):triggers.append((table,name))
for name,body in functions.items():
 schema,fn=name.split('.')
 query=f"SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname={lit(schema)} AND p.proname={lit(fn)}"
 if sql(query).strip()!=body.strip():raise RuntimeError('Installed function mismatch: '+name)
 guards.append(f"DO $$ BEGIN IF ({query}) IS DISTINCT FROM {lit(body)} THEN RAISE EXCEPTION 'Writer source changed';END IF;END $$;")
if len(triggers)<10:raise RuntimeError('Incomplete source trigger inventory')
for table,name in triggers:
 query=f"SELECT count(*) FROM pg_trigger WHERE tgrelid='{table}'::regclass AND tgfoid='{name}()'::regprocedure AND tgtype=29 AND tgenabled IN ('O','A') AND tgqual IS NULL AND NOT tgisinternal"
 if sql(query)!='1':raise RuntimeError('Missing unconditional writer coverage: '+table+' '+name)
 guards.append(f"DO $$ BEGIN IF ({query})<>1 THEN RAISE EXCEPTION 'Writer coverage changed';END IF;END $$;")
parts=[]
for name in ['setup.sql','worker.sql','accept.sql','public-api.sql','review.sql']:
 source=(P/name).read_text();parts.append(source.replace('BEGIN;','',1).rsplit('COMMIT;',1)[0])
sql("BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';"+''.join(guards)+''.join(parts)+'COMMIT;')
(P/'install-evidence.json').write_text(json.dumps({'source_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in P.glob('*.sql')},'writer_source_hashes':{str(p.relative_to(P.parent)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'guarded_functions':list(functions),'guarded_triggers':triggers,'limits':['Private fixture only','No worker/application route enabled','Lazy baseline concurrency still requires actual tests']},indent=2)+'\n')
print('Private authoritative action API installed under exact writer capture guards')
