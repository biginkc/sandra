#!/usr/bin/env python3
"""Compile/once-install the same metadata companion in the existing owned preview."""
if not __debug__:raise SystemExit('Optimized Python refused')
import hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent;E=P.parent
sys.path.insert(0,str(E/'inbox-projection/fixture'))
from guards import validate_container,validate_cron
from transaction_envelope import normalize
if sys.argv[1:] not in (['--compile'],['--install-owned']):raise SystemExit('Use --compile or --install-owned')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db';DB='sandra_inbox_install_20260913';MARKER='sandra-inbox-production-candidate-owned-synthetic'
paths=['inbox-operation-acceptance/setup.sql','inbox-operation-domain/setup.sql','inbox-operation-domain/restrictive-scope.sql','inbox-operation-domain/restrictive-effect.sql','inbox-operation-domain/restrictive-apply.sql']+[f'inbox-operation-preparation/{name}.sql' for name in ['setup','worker','accept','public-api','review','worker-role']]
parts=[];manifest=[];functions={};triggers=[]
for name in paths:
 raw=(E/name).read_text();transformed=raw.replace('inbox_t2_','inbox_');body,removed=normalize(transformed)
 if removed not in (0,2):raise RuntimeError('Unexpected transaction envelope '+name)
 manifest.append({'path':name,'source_sha256':hashlib.sha256(raw.encode()).hexdigest(),'transformed_sha256':hashlib.sha256(body.encode()).hexdigest()})
 parts.append(body)
 for fn,source in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\([^;]*?AS \$\$(.*?)\$\$;',body,re.S):functions[fn]=source
 for table,fn in re.findall(r'CREATE TRIGGER \w+ AFTER INSERT OR UPDATE OR DELETE ON (public\.\w+)\s+FOR EACH ROW EXECUTE FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\(\);',body):triggers.append((table,fn))
ledger="CREATE TABLE inbox_action_api.install_sources(path text PRIMARY KEY,source_sha256 text NOT NULL,transformed_sha256 text NOT NULL);ALTER TABLE inbox_action_api.install_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON inbox_action_api.install_sources FROM PUBLIC,anon,authenticated,service_role,inbox_action_worker;"
for entry in manifest:
 ledger+="INSERT INTO inbox_action_api.install_sources VALUES('"+entry['path']+"','"+entry['source_sha256']+"','"+entry['transformed_sha256']+"');"
parts.append(ledger)
compiled='BEGIN;\nSET LOCAL lock_timeout=\'2s\';SET LOCAL statement_timeout=\'30s\';\n'+ '\n'.join(parts)+'\nCOMMIT;\n'
(P/'preview-companion.sql').write_text(compiled)
receipt={'database':DB,'marker':MARKER,'namespace_replace':{'inbox_t2_':'inbox_'},'components':manifest,'compiled_sha256':hashlib.sha256(compiled.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'limits':['Owned full-schema fixture only; no production installation','No worker started by this installer']}
(P/'preview-companion-manifest.json').write_text(json.dumps(receipt,indent=2)+'\n')
if sys.argv[1:] == ['--compile']:print('Compiled fixed-fixture metadata companion; no database connection');raise SystemExit(0)
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True,timeout=15))[0])
def sql(q,db=DB):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=50)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
def lit(v):return "'"+v.replace("'","''")+"'"
def need(v,label):
 if not v:raise RuntimeError(label)
validate_cron(sql('SHOW cron.launch_active_jobs','postgres'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity','postgres')=='sandra-inbox-projection-t2-owned-synthetic','Container marker mismatch')
need(sql('SELECT marker FROM install_fixture.identity')==MARKER,'Fresh full-schema fixture marker mismatch')
need(sql("SELECT stage='done' FROM inbox_control.baseline_progress WHERE singleton")=='t','Canonical capture baseline incomplete')
need(sql("SELECT to_regnamespace('inbox_action_api') IS NULL AND to_regnamespace('inbox_operations') IS NULL AND to_regnamespace('inbox_operation_domain') IS NULL")=='t','Companion namespaces already exist; no reset/reinstall')
# Verify actual authoritative prerequisite bodies, not merely table presence.
checks=[]
for relative in ['inbox-projection/policy-versions/setup.sql','inbox-workset-bridge/auth.sql']:
 text=(E/relative).read_text().replace('inbox_t2_','inbox_')
 for fn,source in re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\([^;]*?AS \$\$(.*?)\$\$;',text,re.S):
  if not(fn.startswith('inbox_policy.') or fn=='inbox_bridge.authorize'):continue
  if fn=='inbox_bridge.authorize':
   needle='BEGIN\n IF u IS NULL'
   need(source.count(needle)==1,'Authorization gate insertion drift')
   source=source.replace(needle,"BEGIN\n IF NOT EXISTS(SELECT 1 FROM inbox_control.rollout WHERE singleton AND serving_enabled) THEN RAISE EXCEPTION 'INBOX_NOT_READY' USING ERRCODE='55000';END IF;\n IF u IS NULL")
  query="SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname="+lit(fn)
  need(sql(query).strip()==source.strip(),'Prerequisite source mismatch '+fn);checks.append(fn)
need(len(checks)>=3,'Incomplete prerequisite body inventory')
# The reviewed canonical enrollment guard must still exist unchanged before the
# SMS helper relies on it; never install a privileged legacy bypass.
canonical=(E.parent/'supabase/migrations/20260830092331_switchboard_contact_preferences.sql').read_text().split('create or replace function public.guard_locked_property_sequence_enrollment()',1)[1].split('as $$',1)[1].split('$$;',1)[0]
need(sql("SELECT prosrc FROM pg_proc WHERE oid='public.guard_locked_property_sequence_enrollment()'::regprocedure").strip()==canonical.strip(),'Canonical sequence writer guard changed')
preservation_query="SELECT jsonb_build_object('serving_enabled',(SELECT serving_enabled FROM inbox_control.rollout WHERE singleton),'users',(SELECT count(*) FROM auth.users),'sessions',(SELECT count(*) FROM auth.sessions),'messages',(SELECT count(*) FROM public.messages),'properties',(SELECT count(*) FROM public.properties))::text"
preserved=json.loads(sql(preservation_query))
need(preserved['serving_enabled'] is True,'Preview serving gate must already be enabled')
need(hashlib.sha256(compiled.encode()).hexdigest()==json.loads((P/'fixture-companion-manifest.json').read_text())['compiled_sha256'],'Preview companion differs from proven action fixture source')
sql(compiled)
need(json.loads(sql(preservation_query))==preserved,'Preview gate or canonical/Auth row counts changed during install')
receipt['preserved_preview_state']=preserved
for fn,source in functions.items():
 query="SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname="+lit(fn)
 need(sql(query).strip()==source.strip(),'Installed companion body mismatch '+fn)
for table,fn in triggers:
 need(sql(f"SELECT count(*) FROM pg_trigger WHERE tgrelid='{table}'::regclass AND tgfoid='{fn}()'::regprocedure AND tgtype=29 AND tgenabled IN('O','A') AND tgqual IS NULL AND NOT tgisinternal")=='1','Unconditional capture missing '+fn)
need(sql('SELECT inbox_action_api.worker_readiness()')=='t','Real baseline readiness failed')
need(sql('SELECT count(*) FROM inbox_operations.operations')=='0','New preview companion unexpectedly has accepted jobs')
receipt.update({'installed':True,'verified_functions':len(functions),'verified_triggers':len(triggers),'prerequisite_functions':checks,'empty_accepted_operations':True})
(P/'preview-install-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n')
print('Existing preview companion installed; exact proven source, gate, Auth/canonical counts, captures and worker authority checked')
