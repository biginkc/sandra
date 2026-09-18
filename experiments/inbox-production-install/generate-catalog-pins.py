#!/usr/bin/env python3
"""Regenerate catalog pins/evidence from the guarded native fixture.

This is deliberately read-only against PostgreSQL. It refuses to bless a
drifted catalog: every existing owner/ACL pin must match before ``--write``
can replace the canonical JSON, and the installer owner is derived from the
reviewed build contract rather than from the live catalog.
"""
import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

P = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--owned-fixture', action='store_true')
ap.add_argument('--source-only', action='store_true')
ap.add_argument('--write', action='store_true', help='write pins/evidence only after all checks pass')
ap.add_argument('--output-dir', type=Path, default=P)
a = ap.parse_args()


def installer_owner():
    """Return the only owner accepted by the reviewed installer contract."""
    build = (P / 'build.py').read_text()
    migration_roles = sorted(set(re.findall(r"current_user<>?'([^']+)'", build)))
    authorized_roles = sorted(set(re.findall(r'CREATE SCHEMA \w+ AUTHORIZATION (\w+)', build)))
    if migration_roles != ['postgres'] or authorized_roles != ['postgres']:
        raise RuntimeError('Installer owner contract drift: build.py must require and authorize postgres')
    return 'postgres'


def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return sorted((canonical(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))
    return value


def load(name):
    path = P / name
    return json.loads(path.read_text()) if path.exists() else {}


def source_check():
    manifest = load('source-manifest.json')
    for name, digest in manifest.items():
        # This receipt is deliberately pinned by verify.py after a fresh
        # guarded catalog read.  Skipping it here avoids a deadlock where a
        # changed generator cannot regenerate the receipt because its old
        # generator hash is still present in the manifest.
        if name == 'catalog-pin-provenance.json':
            continue
        if hashlib.sha256((P / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Bundle source manifest drift: ' + name)
    for path in P.glob('*.py'):
        ast.parse(path.read_text(), filename=str(path))
    owner = installer_owner()
    owner_pins = load('function-owners.json')
    relation_owners = load('relation-owners.json')
    if any(value != owner for value in owner_pins.values()):
        raise RuntimeError('function-owners.json contains a value outside the installer owner contract')
    if any(value != owner for value in relation_owners.values()):
        raise RuntimeError('relation-owners.json contains a value outside the installer owner contract')
    contract = load('column-acl.json')
    if contract.get('contract') != 'no-column-specific-grants':
        raise RuntimeError('column-acl.json must declare no-column-specific-grants')
    # Keep regeneration possible when this generator itself changes: the
    # source-only verifier validates the live provenance receipt, which must be
    # regenerated after a generator change.  These compiler checks are the
    # DB-less prerequisites needed before that read-only native regeneration;
    # verify.py --source-only remains the CI admission gate.
    subprocess.run([sys.executable, str(P / 'build.py')], cwd=P, check=True)
    subprocess.run([sys.executable, str(P / 'read-companion.py')], cwd=P, check=True)
    candidate = (P / 'generated/install-candidate.sql').read_text()
    if re.search(r'\bGRANT\s+[A-Z ,]+\([^)]*\)\s+ON\s+', candidate, re.I):
        raise RuntimeError('Candidate contains column-specific GRANT syntax but the reviewed contract is empty')
    return owner, hashlib.sha256((P / 'generated/install-candidate.sql').read_bytes()).hexdigest()


def read_catalog():
    """Read all scoped facts in one repeatable, read-only catalog snapshot."""
    from fixture_db import guard, sql
    guard()
    result = sql("""
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SELECT jsonb_build_object(
  'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',n.nspname||'.'||p.proname,
    'owner',p.proowner::regrole::text,
    'grants',(SELECT coalesce(jsonb_agg(jsonb_build_object(
      'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,
      'privilege_type',a.privilege_type,
      'grantable',a.is_grantable
    ) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,a.privilege_type,a.is_grantable),'[]')
    FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    LEFT JOIN pg_roles gr ON gr.oid=a.grantee
    WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner)
  )),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace),
  'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',n.nspname||'.'||c.relname,'owner',c.relowner::regrole::text,
    'acl',coalesce(c.relacl::text[],'{}')
  )),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p')),
  'schemas',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',n.nspname,'owner',n.nspowner::regrole::text,
    'acl',coalesce(n.nspacl::text[],'{}')
  )),'[]') FROM pg_namespace n),
  'types',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',n.nspname||'.'||t.typname,'owner',t.typowner::regrole::text,
    'acl',coalesce(t.typacl::text[],'{}')
  )),'[]') FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='c' AND t.typrelid<>0),
  'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',n.nspname||'.'||c.relname||'.'||a.attname,
    'acl',coalesce(a.attacl::text[],'{}')
  )),'[]') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','c'))
);
ROLLBACK;
""")
    return json.loads(result)


def verify_scope(snapshot, owner):
    functions = load('function-owners.json')
    grants = load('function-grants.json')
    relation_owners = load('relation-owners.json')
    relation_acls = load('relation-acl.json')
    columns = {}
    fn_rows = {}
    for row in snapshot['functions']:
        fn_rows.setdefault(row['key'], []).append(row)
    for key, expected in functions.items():
        rows = fn_rows.get(key, [])
        if not rows:
            raise RuntimeError('Pinned function missing from native catalog: ' + key)
        if len(rows) != 1:
            raise RuntimeError('Pinned function is overloaded in native catalog; pin keys need signatures: ' + key)
        row = rows[0]
        if row['owner'] != owner or expected != owner:
            raise RuntimeError(f'Function owner drift for {key}: expected installer owner {owner!r}, live={row["owner"]!r}')
        if canonical(grants.get(key)) != canonical(row['grants']):
            raise RuntimeError('Function ACL drift for ' + key + '; refusing to bless live catalog')

    table_rows = {f'table:{row["key"]}': row for row in snapshot['tables']}
    schema_rows = {f'schema:{row["key"]}': row for row in snapshot['schemas']}
    type_rows = {f'type:{row["key"]}': row for row in snapshot['types']}
    scoped = table_rows | schema_rows | type_rows
    for key, expected in relation_owners.items():
        row = scoped.get(key)
        if row is None:
            raise RuntimeError('Pinned relation missing from native catalog: ' + key)
        if expected != owner or row['owner'] != owner:
            raise RuntimeError(f'Relation owner drift for {key}: expected installer owner {owner!r}, live={row["owner"]!r}')
        if canonical(relation_acls.get(key)) != canonical(row['acl']):
            raise RuntimeError('Relation ACL drift for ' + key + '; refusing to bless live catalog')

    candidate_relations = {
        key.split(':', 1)[1] for key in relation_owners
        if key.startswith('table:') or key.startswith('type:')
    }
    for row in snapshot['columns']:
        if row['key'].rsplit('.', 1)[0] not in candidate_relations:
            continue
        if row['acl']:
            raise RuntimeError(f'Column ACL drift for {row["key"]}: live={row["acl"]}; refusing to bless live catalog')
        columns[row['key']] = []
    return {
        'function_owners': {key: owner for key in sorted(functions)},
        'function_grants': {key: canonical(grants[key]) for key in sorted(grants)},
        'relation_owners': {key: owner for key in sorted(relation_owners)},
        'relation_acls': {key: canonical(relation_acls[key]) for key in sorted(relation_acls)},
        'column_acls': {key: [] for key in sorted(columns)},
    }


def snapshot_sha256(snapshot):
    """Hash the complete catalog snapshot returned by the guarded read.

    The reduced pin files intentionally retain only the owner/ACL facts needed
    by the installer.  Provenance must still identify the complete observed
    catalog read, so hashing ``outputs`` here would falsely certify a snapshot
    after unrelated catalog fields disappeared during reduction.
    """
    return hashlib.sha256(
        json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()
    ).hexdigest()


def write_outputs(outputs, owner, source_sha, observed_snapshot_sha):
    out = a.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    files = {
        'function-owners.json': outputs['function_owners'],
        'function-grants.json': outputs['function_grants'],
        'relation-owners.json': outputs['relation_owners'],
        'relation-acl.json': outputs['relation_acls'],
        'column-acl.json': {
            'schema_version': 1,
            'contract': 'no-column-specific-grants',
            'columns': outputs['column_acls'],
        },
    }
    for name, value in files.items():
        (out / name).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')
    snapshot = json.dumps(outputs, sort_keys=True, separators=(',', ':')).encode()
    provenance = {
        'generator': 'generate-catalog-pins.py',
        'generator_sha256': hashlib.sha256((P / 'generate-catalog-pins.py').read_bytes()).hexdigest(),
        'installer_owner': owner,
        'candidate_sha256': source_sha,
        'catalog_snapshot_sha256': observed_snapshot_sha,
        'pin_output_sha256': hashlib.sha256(snapshot).hexdigest(),
        'scope': 'Guarded native fixture catalog read; no database writes; existing pins matched before replacement',
    }
    (out / 'catalog-pin-provenance.json').write_text(json.dumps(provenance, indent=2, sort_keys=True) + '\n')
    print(json.dumps(provenance, indent=2))


owner, source_sha = source_check()
if a.source_only:
    print(f'Source contract valid: installer owner={owner}, candidate_sha256={source_sha}; no database connection')
    raise SystemExit(0)
if not a.owned_fixture:
    raise SystemExit('Explicit --owned-fixture required for catalog reads')
observed_snapshot = read_catalog()
outputs = verify_scope(observed_snapshot, owner)
if a.write:
    write_outputs(outputs, owner, source_sha, snapshot_sha256(observed_snapshot))
else:
    print(f'Native catalog pins match reviewed source and installer owner {owner}; use --write to materialize provenance')
