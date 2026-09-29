#!/usr/bin/env python3
"""Read-only, migration-scoped catalog fingerprint. --write-manifest is offline."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase/migrations'
MANIFEST = Path(__file__).with_name('catalog-scope.json')
IDENT = re.compile(r'\b(?:public|auth|storage|inbox_[a-z_]+|supabase_migrations)\.[a-z_][a-z_0-9]*\b', re.I)
CREATED = re.compile(r'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|TYPE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:public|inbox_[a-z_]+)\.[a-z_][a-z_0-9]*)', re.I)


def migration_identifiers():
    files = sorted(MIGRATIONS.glob('2026092900*.sql'))
    if len(files) != 3:
        raise ValueError('Expected exactly three 2026092900 migrations')
    return sorted({m.group().lower() for p in files for m in IDENT.finditer(p.read_text())})


def created_identifiers():
    return sorted({m.group(1).lower() for p in MIGRATIONS.glob('2026092900*.sql') for m in CREATED.finditer(p.read_text())})


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def fingerprint(sections):
    hashes = {name: hashlib.sha256(canonical(value).encode()).hexdigest() for name, value in sorted(sections.items())}
    return {'sections': sections, 'section_sha256': hashes, 'sha256': hashlib.sha256(canonical(hashes).encode()).hexdigest()}


def normalize(value, key=''):
    if isinstance(value, dict):
        return {k: normalize(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize(v, key) for v in value]
    if isinstance(value, str) and key in ('definition', 'default', 'qual', 'with_check'):
        return ' '.join(value.split())
    return value


def read_catalog(identifiers):
    # The only non-pg_catalog data read is the explicitly required migration
    # ledger. Everything else comes from pg_catalog, in one read-only txn.
    ids = canonical(identifiers).replace("'", "''")
    sql = f"""BEGIN READ ONLY;
SHOW transaction_read_only;
WITH wanted AS (SELECT split_part(x, '.', 1) AS schema_name, split_part(x, '.', 2) AS object_name
 FROM jsonb_array_elements_text('{ids}'::jsonb) AS x),
rels AS (SELECT w.schema_name||'.'||w.object_name AS identity, c.oid
 FROM wanted w JOIN pg_catalog.pg_namespace n ON n.nspname=w.schema_name
 JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.object_name),
funcs AS (SELECT w.schema_name||'.'||w.object_name AS identity,p.oid
 FROM wanted w JOIN pg_catalog.pg_namespace n ON n.nspname=w.schema_name
 JOIN pg_catalog.pg_proc p ON p.pronamespace=n.oid AND p.proname=w.object_name),
types AS (SELECT w.schema_name||'.'||w.object_name AS identity,t.oid
 FROM wanted w JOIN pg_catalog.pg_namespace n ON n.nspname=w.schema_name
 JOIN pg_catalog.pg_type t ON t.typnamespace=n.oid AND t.typname=w.object_name)
SELECT jsonb_build_object(
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',r.identity,'kind',c.relkind,
   'acl',c.relacl::text,'rls',c.relrowsecurity,
   'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) ORDER BY a.attname),'[]'::jsonb) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT coalesce(jsonb_agg(pg_catalog.pg_get_constraintdef(k.oid) ORDER BY k.conname),'[]'::jsonb) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
   'indexes',(SELECT coalesce(jsonb_agg(pg_catalog.pg_get_indexdef(i.indexrelid) ORDER BY pg_catalog.pg_get_indexdef(i.indexrelid)),'[]'::jsonb) FROM pg_catalog.pg_index i WHERE i.indrelid=c.oid),
   'triggers',(SELECT coalesce(jsonb_agg(pg_catalog.pg_get_triggerdef(t.oid) ORDER BY t.tgname),'[]'::jsonb) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
   'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'roles',(SELECT coalesce(jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END ORDER BY role_oid),'[]'::jsonb) FROM unnest(p.polroles) role_oid),'qual',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'with_check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]'::jsonb) FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)
 ) ORDER BY r.identity),'[]'::jsonb) FROM rels r JOIN pg_catalog.pg_class c ON c.oid=r.oid),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',f.identity,'signature',p.oid::pg_catalog.regprocedure::text,'definition',regexp_replace(pg_catalog.pg_get_functiondef(p.oid),'[[:space:]]+',' ','g'),'acl',p.proacl::text) ORDER BY f.identity,p.oid::pg_catalog.regprocedure::text),'[]'::jsonb) FROM funcs f JOIN pg_catalog.pg_proc p ON p.oid=f.oid),
 'types',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',t.identity,'kind',y.typtype,'definition',pg_catalog.format_type(y.oid,NULL),'acl',y.typacl::text) ORDER BY t.identity),'[]'::jsonb) FROM types t JOIN pg_catalog.pg_type y ON y.oid=t.oid),
 'extensions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion) ORDER BY e.extname),'[]'::jsonb) FROM pg_catalog.pg_extension e),
 'schemas',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname,'acl',n.nspacl::text) ORDER BY n.nspname),'[]'::jsonb) FROM pg_catalog.pg_namespace n WHERE n.nspname IN (SELECT schema_name FROM wanted)),
 'schema_migrations',(SELECT coalesce(jsonb_agg(version ORDER BY version),'[]'::jsonb) FROM supabase_migrations.schema_migrations)
)::text;
COMMIT;
"""
    result = subprocess.run(['psql','-X','-A','-t','-v','ON_ERROR_STOP=1'], input=sql, text=True, capture_output=True, check=True)
    lines = [line for line in result.stdout.splitlines() if line.strip() and line not in ('BEGIN', 'COMMIT')]
    if len(lines) != 2 or lines[0] != 'on':
        raise RuntimeError('READ ONLY assertion or catalog response failed')
    return json.loads(lines[1])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--write-manifest', action='store_true')
    parser.add_argument('--check-manifest', action='store_true')
    parser.add_argument('--preflight', action='store_true', help='refuse if a migration-created object already exists')
    parser.add_argument('--compare', type=Path, help='compare against a saved TEST fingerprint; any section mismatch fails')
    args = parser.parse_args()
    current = migration_identifiers()
    if args.write_manifest:
        MANIFEST.write_text(json.dumps({'qualified_identifiers': current, 'created_objects': created_identifiers()}, indent=2) + '\n')
        return
    pinned = json.loads(MANIFEST.read_text())['qualified_identifiers']
    missing = sorted(set(current) - set(pinned))
    if missing:
        raise SystemExit('Missing migration identifiers from catalog manifest: ' + ', '.join(missing))
    if sorted(json.loads(MANIFEST.read_text()).get('created_objects', [])) != created_identifiers():
        raise SystemExit('Created-object manifest drift')
    if args.check_manifest:
        print(f'PASS: {len(current)} migration identifiers covered')
        return
    sections = normalize(read_catalog(pinned))
    created = set(json.loads(MANIFEST.read_text())['created_objects'])
    existing = sorted(created & {x['identity'] for kind in ('relations', 'functions', 'types') for x in sections[kind]})
    sections['created_objects_present'] = existing
    if args.preflight and existing:
        raise SystemExit('Migration-created objects already exist: ' + ', '.join(existing))
    result = fingerprint(sections)
    if args.compare:
        expected = json.loads(args.compare.read_text())
        mismatches = [name for name, value in result['section_sha256'].items() if expected.get('section_sha256', {}).get(name) != value]
        if mismatches:
            raise SystemExit('Catalog sections differ: ' + ', '.join(mismatches))
        if result['sections']['schema_migrations'] != expected['sections']['schema_migrations']:
            raise SystemExit('schema_migrations hard comparison failed')
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
