#!/usr/bin/env python3
"""Verify compiler determinism and, with --installed, the exact guarded installed schema."""
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
drifted=receipt['source_sha256']!=digest
if drifted:
 correction=P/'hardening-evidence.json'
 if not correction.exists() or json.loads(correction.read_text())['foundation_sha256']!=digest:
  raise RuntimeError('Generated foundation differs from recorded installation and verified forward correction; never relabel old evidence')
 # A hardening receipt only records that some hash was applied once; recording a new hash
 # is not proof the exact reviewed candidate is what is live now. Non-retention DDL could
 # have drifted (tables/constraints/triggers/RLS/indexes/function attributes) with nothing
 # here ever re-checking the installed catalog against it. A foundation-hash mismatch can
 # therefore ONLY be certified by structurally re-verifying the installed object set in
 # THIS run (--installed); a matching receipt hash alone is not sufficient.
 if not a.installed:
  raise RuntimeError('Foundation hash differs from the original recorded installation; --installed structural re-verification against the live catalog is required to certify the forward correction in hardening-evidence.json, a matching receipt hash alone does not prove the installed DDL matches')

functions=dict(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',s,re.S))
tables=sorted(set(re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)',s)))
indexes=sorted(set(re.findall(r'CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? (\w+) ON ([\w.]+)',s)))
triggers=sorted(set(re.findall(r'CREATE TRIGGER (\w+).*?\bON\s+([\w.]+)',s,re.S)))
rls_tables=sorted(set(re.findall(r'ALTER TABLE ([\w.]+) ENABLE ROW LEVEL SECURITY',s)))
constraints=sorted(set(re.findall(r'ALTER TABLE ([\w.]+) ADD CONSTRAINT (\w+)',s)))
secdef_functions=sorted(set(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\([^)]*\)[^;]*?SECURITY DEFINER',s,re.S)))

if a.installed:
 from fixture_db import guard,sql
 guard()
 actual=json.loads(sql("BEGIN READ ONLY;SELECT jsonb_object_agg(n.nspname||'.'||p.proname,p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' OR (n.nspname='public' AND p.proname LIKE 'inbox\\_%' ESCAPE '\\');COMMIT;"))
 for name,body in functions.items():
  if actual.get(name)!=body:raise RuntimeError('Installed foundation body differs: '+name)

 # Structural re-verification beyond function bodies: every table, RLS flag, index,
 # trigger, constraint and SECURITY DEFINER attribute the current candidate declares
 # must actually be present in the live installed catalog, not merely a hash receipt.
 for full in tables:
  schema,_,table=full.partition('.')
  if sql(f"SELECT (to_regclass('{schema}.{table}') IS NOT NULL)::text")!='true':
   raise RuntimeError('Installed table missing: '+full)
 for full in rls_tables:
  schema,_,table=full.partition('.')
  if sql(f"SELECT relrowsecurity::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{schema}' AND c.relname='{table}'")!='true':
   raise RuntimeError('Installed table missing RLS: '+full)
 for name,full in indexes:
  schema=full.partition('.')[0]
  if sql(f"SELECT (to_regclass('{schema}.{name}') IS NOT NULL)::text")!='true':
   raise RuntimeError('Installed index missing: '+name)
 for name,full in triggers:
  schema,_,table=full.partition('.')
  if sql(f"SELECT (count(*)>0)::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{schema}' AND c.relname='{table}' AND t.tgname='{name}'")!='true':
   raise RuntimeError('Installed trigger missing: '+name)
 for table,cname in constraints:
  schema,_,tname=table.partition('.')
  if sql(f"SELECT (count(*)>0)::text FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{schema}' AND c.relname='{tname}' AND co.conname='{cname}'")!='true':
   raise RuntimeError('Installed constraint missing: '+cname)
 for name in secdef_functions:
  schema,_,fname=name.partition('.')
  attrs=sql(f"SELECT prosecdef::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='{schema}' AND p.proname='{fname}' LIMIT 1")
  if attrs!='true':raise RuntimeError('Installed function lost SECURITY DEFINER: '+name)

 if sql("SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass")!='f':raise RuntimeError('Projection replica identity drift')
 bad=sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))")
 if bad!='0':raise RuntimeError('Private helper exposed to browser/service roles')
 result={'foundation_sha256':digest,'installed_function_bodies':len(functions),'installed_tables':len(tables),'installed_indexes':len(indexes),'installed_triggers':len(triggers),'installed_rls_tables':len(rls_tables),'installed_constraints':len(constraints),'private_helper_exposure_count':0,'replica_identity':'FULL','scope':'Read-only owned fixture catalog proof; excludes runtime throughput and production schema equivalence'}
 (P/'catalog-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
else:
 print('Source syntax, pinned transforms and installation receipt hash verified')
