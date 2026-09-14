#!/usr/bin/env python3
"""Compile pinned read/history companion; installation is restricted to the owned fixture."""
import argparse,hashlib,json,re,sys
from pathlib import Path
P=Path(__file__).resolve().parent;ROOT=P.parent.parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from transaction_envelope import normalize
parser=argparse.ArgumentParser();parser.add_argument('--owned-fixture',action='store_true');parser.add_argument('--verify-only',action='store_true');args=parser.parse_args()
manifest=json.loads((P/'read-companion-manifest.json').read_text());chunks=[];concurrent_indexes=[]
for entry in manifest:
 raw=(ROOT/entry['source_file']).read_bytes()
 if hashlib.sha256(raw).hexdigest()!=entry['source_sha256']:raise RuntimeError('Pinned companion source changed')
 s=raw.decode();guards=[g for g in re.finditer(r'DO \$\$.*?END \$\$;',s,re.S) if 'inbox_t2_fixture.identity' in g.group()]
 if len(guards)!=1:raise RuntimeError('Companion fixture guard drift')
 g=guards[0];s=s[:g.start()]+s[g.end():];s,n=normalize(s)
 if n!=2:raise RuntimeError('Companion transaction envelope drift')
 s=s.replace('inbox_t2_','inbox_')
 if entry.get('concurrent_index'):
  concurrent_indexes.extend(q.replace('CREATE INDEX ','CREATE INDEX CONCURRENTLY ',1) for q in re.findall(r'CREATE INDEX \w+ ON public\.\w+[^;]*;',s))
  s=re.sub(r'CREATE INDEX \w+ ON public\.\w+[^;]*;','-- Canonical index moved to separate concurrent packet.',s)
 if hashlib.sha256(s.encode()).hexdigest()!=entry['compiled_sha256']:raise RuntimeError('Companion transformation drift')
 chunks.append(s)
compiled="BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';\n"+'\n'.join(chunks)+'\n'+(P/'read-retention.sql').read_text()+(P/'unknown-retention.sql').read_text()+(P/'harden-private.sql').read_text()+'COMMIT;\n'
(P/'generated/read-companion.sql').write_text(compiled)
(P/'generated/read-indexes.json').write_text(json.dumps(concurrent_indexes,indent=2)+'\n')
for i,q in enumerate(concurrent_indexes,1):(P/f'generated/read-index-{i:02d}.sql').write_text(q+'\n')
(P/'generated/read-upgrade-unknown.sql').write_text('BEGIN;'+chunks[-1]+(P/'unknown-retention.sql').read_text()+(P/'harden-private.sql').read_text()+'COMMIT;')
if not args.owned_fixture:
 if args.verify_only:raise RuntimeError('--verify-only requires --owned-fixture')
 print('Compiled pinned read/history companion; no database connection');sys.exit(0)
from fixture_db import guard,sql,ensure_concurrent_index
guard()
if not args.verify_only:
 if sql("SELECT to_regnamespace('inbox_read') IS NOT NULL")=='t':raise RuntimeError('Existing read schema; use verification or reviewed forward upgrade')
 if sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')!='f':raise RuntimeError('Installation requires disabled serving gate')
 sql(compiled)
 for q in concurrent_indexes:ensure_concurrent_index(q)
 sql("NOTIFY pgrst,'reload schema'")
expected=dict(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',compiled,re.S))
actual=json.loads(sql("SELECT jsonb_object_agg(n.nspname||'.'||p.proname,p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='inbox_read' OR (n.nspname='public' AND p.proname IN ('inbox_read_detail','inbox_acknowledge_read','inbox_history_page','inbox_unknown_history_page'))"))
for name,body in expected.items():
 if actual.get(name)!=body:raise RuntimeError('Installed companion body mismatch: '+name)
permissions=json.loads(sql("SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE')) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('inbox_read_detail','inbox_acknowledge_read','inbox_history_page','inbox_unknown_history_page')"))
if len(permissions)!=4 or any(not p['authenticated'] or p['anon'] or p['service'] for p in permissions):raise RuntimeError('Companion permission mismatch')
receipt={'installed_bodies_verified':len(expected),'permissions':permissions,'compiled_sha256':hashlib.sha256(compiled.encode()).hexdigest(),'scope':'Actual fresh DB catalog proof; browser transport is independent evidence'}
(P/'read-companion-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
