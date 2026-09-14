#!/usr/bin/env python3
"""Source-bound proof inventory; --installed is read-only guarded fixture verification."""
import ast,hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
if sys.argv[1:] not in ([],['--installed']):raise SystemExit('Use no args or --installed')
manifest=json.loads((P/'source-manifest.json').read_text())
for name,digest in manifest.items():
 if hashlib.sha256((P/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Source differs from evidence manifest: '+name)
for f in P.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
if sys.argv[1:]:
 sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
 from guards import validate_container
 D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
 validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
 q="BEGIN READ ONLY; SELECT marker FROM inbox_t2_fixture.identity;SELECT jsonb_object_agg(n.nspname||'.'||p.proname,p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='inbox_t2_bridge' OR (n.nspname='public' AND p.proname IN ('inbox_authorize_sync','inbox_create_workset','inbox_get_sync_scope','inbox_bind_sync_handle','inbox_counts_v2','inbox_create_workset_v2')); COMMIT;"
 out=subprocess.check_output(D+['exec',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-c',q],text=True).splitlines()
 if out[0]!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong marker')
 installed=json.loads(out[1]);count=0
 for f in P.glob('*.sql'):
  for name,body in re.findall(r'CREATE FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',f.read_text(),re.S):
   if installed.get(name,'').strip()!=body.strip():raise RuntimeError('Installed body differs: '+name)
   count+=1
 print(f'{count} installed performance function bodies match reviewed source')
print('Manifest and Python syntax verified')
