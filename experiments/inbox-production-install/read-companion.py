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
 s=raw.decode();guard_marker=entry.get('fixture_guard','inbox_t2_fixture.identity')
 guards=[g for g in re.finditer(r'DO \$\$.*?END \$\$;',s,re.S) if guard_marker in g.group()]
 if len(guards)!=1:raise RuntimeError('Companion fixture guard drift')
 g=guards[0];s=s[:g.start()]+s[g.end():];s,n=normalize(s)
 if n!=2:raise RuntimeError('Companion transaction envelope drift')
 # Entries reviewed from the t2 fixture harness ship t2-prefixed private schema
 # names that must be translated to their production inbox_* names. Entries
 # reviewed from a harness that already targets production names (e.g. the
 # sync-authority batch, which writes inbox_bridge.*/public.* directly) pin
 # rename_prefix to null so nothing is rewritten.
 rename_prefix=entry.get('rename_prefix','inbox_t2_')
 if rename_prefix:
  s=s.replace(rename_prefix,'inbox_')
  if rename_prefix in s:raise RuntimeError('Untranslated fixture reference: '+entry['source_file'])
 # Read/history RPCs are serving callers.  The bridge's base authorize()
 # remains available to receipt/recovery adapters during rollback; these
 # reviewed read callers must retain the independent serving admission.
 s=s.replace('inbox_bridge.authorize(', 'inbox_bridge.authorize_serving(')
 if entry.get('concurrent_index'):
  concurrent_indexes.extend(q.replace('CREATE INDEX ','CREATE INDEX CONCURRENTLY ',1) for q in re.findall(r'CREATE INDEX \w+ ON public\.\w+[^;]*;',s))
  s=re.sub(r'CREATE INDEX \w+ ON public\.\w+[^;]*;','-- Canonical index moved to separate concurrent packet.',s)
 if hashlib.sha256(s.encode()).hexdigest()!=entry['compiled_sha256']:raise RuntimeError('Companion transformation drift')
 chunks.append(s)
compiled="BEGIN;SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';\n"+'\n'.join(chunks)+'\n'+(P/'read-retention.sql').read_text()+(P/'unknown-retention.sql').read_text()+(P/'harden-private.sql').read_text()+'COMMIT;\n'
(P/'generated/read-companion.sql').write_text(compiled)
(P/'generated/read-indexes.json').write_text(json.dumps(concurrent_indexes,indent=2)+'\n')
for i,q in enumerate(concurrent_indexes,1):(P/f'generated/read-index-{i:02d}.sql').write_text(q+'\n')
# Each entry that names an upgrade_name gets its own standalone forward-upgrade
# packet (that entry's chunk plus the minimum companion-wide retention/hardening
# additions it introduced), for applying to a fixture that already has every
# earlier entry installed. Keyed by entry, never by position, so adding a new
# entry never silently repoints an earlier entry's named upgrade packet (the
# read-upgrade-unknown.sql regression this replaces: it used to grab
# chunks[-1], which used to be entry 4 but would silently become entry 5).
UPGRADE_EXTRAS={'unknown':['unknown-retention.sql','harden-private.sql']}
for entry,chunk in zip(manifest,chunks):
 name=entry.get('upgrade_name')
 if not name:continue
 extra=''.join((P/f).read_text() for f in UPGRADE_EXTRAS.get(name,['harden-private.sql']))
 (P/f'generated/read-upgrade-{name}.sql').write_text('BEGIN;'+chunk+extra+'COMMIT;')
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
# Derived from this run's own compiled output -- never hard-coded -- so a newly
# added entry (its own private schema, its own public RPC names) is verified
# against the live catalog automatically instead of silently being skipped.
private_schemas=sorted({n.split('.',1)[0] for n in expected if not n.startswith('public.')})
public_names=sorted({n.split('.',1)[1] for n in expected if n.startswith('public.')})
schema_list=','.join("'"+x+"'" for x in private_schemas)
public_list=','.join("'"+x+"'" for x in public_names)
actual=json.loads(sql(f"SELECT jsonb_object_agg(n.nspname||'.'||p.proname,p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ({schema_list}) OR (n.nspname='public' AND p.proname IN ({public_list}))"))
for name,body in expected.items():
 if actual.get(name)!=body:raise RuntimeError('Installed companion body mismatch: '+name)
permissions=json.loads(sql(f"SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE')) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ({public_list})"))
if len(permissions)!=len(public_names) or any(not p['authenticated'] or p['anon'] or p['service'] for p in permissions):raise RuntimeError('Companion permission mismatch')
receipt={'installed_bodies_verified':len(expected),'permissions':permissions,'compiled_sha256':hashlib.sha256(compiled.encode()).hexdigest(),'scope':'Actual fresh DB catalog proof; browser transport is independent evidence'}
(P/'read-companion-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
