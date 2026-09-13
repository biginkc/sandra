#!/usr/bin/env python3
"""Verify compiler determinism and optionally the exact guarded installed function bodies."""
import argparse,ast,hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--installed',action='store_true');a=ap.parse_args()
manifest=P/'source-manifest.json'
if manifest.exists():
 for name,digest in json.loads(manifest.read_text()).items():
  if hashlib.sha256((P/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Bundle source manifest drift: '+name)
for f in P.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
subprocess.run([sys.executable,str(P/'build.py')],check=True)
subprocess.run([sys.executable,str(P/'read-companion.py')],check=True)
foundation=P/'generated/install-candidate.sql';s=foundation.read_text();digest=hashlib.sha256(foundation.read_bytes()).hexdigest()
receipt=json.loads((P/'install-evidence.json').read_text())
if receipt['source_sha256']!=digest:
 correction=P/'hardening-evidence.json'
 if not correction.exists() or json.loads(correction.read_text())['foundation_sha256']!=digest:raise RuntimeError('Generated foundation differs from recorded installation and verified forward correction; never relabel old evidence')
functions=dict(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',s,re.S))
if a.installed:
 from fixture_db import guard,sql
 guard()
 actual=json.loads(sql("BEGIN READ ONLY;SELECT jsonb_object_agg(n.nspname||'.'||p.proname,p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' OR (n.nspname='public' AND p.proname LIKE 'inbox\\_%' ESCAPE '\\');COMMIT;"))
 for name,body in functions.items():
  if actual.get(name)!=body:raise RuntimeError('Installed foundation body differs: '+name)
 if sql("SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass")!='f':raise RuntimeError('Projection replica identity drift')
 bad=sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))")
 if bad!='0':raise RuntimeError('Private helper exposed to browser/service roles')
 result={'foundation_sha256':digest,'installed_function_bodies':len(functions),'private_helper_exposure_count':0,'replica_identity':'FULL','scope':'Read-only owned fixture catalog proof; excludes runtime throughput and production schema equivalence'}
 (P/'catalog-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
else:print('Source syntax, pinned transforms and installation receipt hash verified')
