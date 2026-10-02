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
CATALOG_FORMAT_VERSION = 2
DRIFT_FIXTURE_VERSION = 1
KNOWN_TARGET_REFS = frozenset({'ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz'})
CATALOG_SECTIONS = ('created_objects_present', 'extensions', 'functions', 'index_names', 'relations', 'schema_migrations', 'schemas', 'trigger_names', 'types')
IDENT = re.compile(r'\b(?:public|auth|storage|inbox_[a-z_]+|supabase_migrations)\.[a-z_][a-z_0-9]*\b', re.I)
CREATED = re.compile(r'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|TYPE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:public|inbox_[a-z_]+)\.[a-z_][a-z_0-9]*)', re.I)
CREATED_SCHEMA = re.compile(r'\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+)\b', re.I)
CREATED_TRIGGER = re.compile(r'\bCREATE\s+TRIGGER\s+([a-z_][a-z_0-9]*)\b(?:(?!;).)*?\bON\s+((?:public|auth|inbox_[a-z_]+)\.[a-z_][a-z_0-9]*)\b', re.I | re.S)
CREATED_INDEX = re.compile(r'\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z_0-9]*)\s+ON\s+((?:public|inbox_[a-z_]+)\.[a-z_][a-z_0-9]*)\b', re.I)


def migration_identifiers():
    files = sorted(MIGRATIONS.glob('2026093004*.sql'))
    if len(files) != 3:
        raise ValueError('Expected exactly three 2026093004 migrations')
    return sorted({m.group().lower() for p in files for m in IDENT.finditer(p.read_text())})


def created_identifiers():
    return sorted({m.group(1).lower() for p in MIGRATIONS.glob('2026093004*.sql') for m in CREATED.finditer(p.read_text())})


def created_name_scope():
    sources = [p.read_text() for p in MIGRATIONS.glob('2026093004*.sql')]
    return {
        'created_schemas': sorted({m.group(1).lower() for source in sources for m in CREATED_SCHEMA.finditer(source)}),
        'created_triggers': sorted({f'{m.group(2).lower()}.{m.group(1).lower()}' for source in sources for m in CREATED_TRIGGER.finditer(source)}),
        'created_indexes': sorted({f'{m.group(2).split(".")[0].lower()}.{m.group(1).lower()}' for source in sources for m in CREATED_INDEX.finditer(source)}),
    }


def created_objects_present(sections, scope):
    present = set(scope['created_objects']) & {x['identity'] for kind in ('relations', 'functions', 'types') for x in sections[kind]}
    present.update(set(scope['created_schemas']) & {x['name'] for x in sections['schemas']})
    present.update(set(scope['created_triggers']) & set(sections['trigger_names']))
    present.update(set(scope['created_indexes']) & set(sections['index_names']))
    return sorted(present)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def fingerprint(sections, catalog_format_version=CATALOG_FORMAT_VERSION):
    hashes = {name: hashlib.sha256(canonical(value).encode()).hexdigest() for name, value in sorted(sections.items())}
    return {'catalog_format_version': catalog_format_version, 'sections': sections, 'section_sha256': hashes, 'sha256': hashlib.sha256(canonical({'catalog_format_version': catalog_format_version, 'section_sha256': hashes}).encode()).hexdigest()}


def normalize(value, key=''):
    # pg_get_* output is already deterministic for one server version. SQL
    # whitespace can occur in literals (including dollar-quoted bodies), so
    # even an apparently harmless collapse changes the behavioral fingerprint.
    return value


DRIFT_RECORD_VERSION = 1
DRIFT_ITEM_KEYS = {'object', 'attribute', 'name', 'canonical_definition', 'definition_sha256', 'classification', 'origin', 'approval_sha256'}
DRIFT_APPROVALS = {
    'idx_message_threads_ai_responder_status': 'e419f623f1922466db14dba7aa091cdd4720924e2b97901088af2dc5719b108a',
    'idx_users_name': '4dbc01feffae5acf04236e5aa3611151cc43e1467f84588e05b025dd9fbc7402',
}
OPERATOR_INDEX_NAMES = {
    'inbox_parent_message_property', 'inbox_parent_message_contact', 'inbox_parent_review_property',
    'inbox_backfill_messages', 'inbox_backfill_reviews', 'inbox_backfill_threads',
    'inbox_backfill_thread_identity', 'inbox_unknown_history_page',
}
def derive_rowtype_tables(sources):
    """Conservatively derive relations read as whole rows by Inbox SQL.

    PostgreSQL's %ROWTYPE is only one whole-row form.  A star projection,
    qualified star, or selecting an alias/ROW(alias) also makes the relation's
    complete row type observable.  The parser is deliberately conservative:
    false positives reject otherwise recordable drift, while false negatives
    would allow a migration-read table to be recorded as unexplained drift.
    """
    tables = set()
    aliases = {}
    qualified = r'((?:public|auth|storage|inbox_[a-z_]+|supabase_migrations)\.[a-z_][a-z_0-9]*)'
    for source in sources:
        tables.update(f'{schema.lower()}.{table.lower()}' for schema, table in re.findall(
            r'\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)%rowtype\b', source, re.I))
        for match in re.finditer(rf'\b(?:FROM|JOIN)\s+{qualified}(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?', source, re.I):
            table = match.group(1).lower()
            alias = (match.group(2) or table.rsplit('.', 1)[-1]).lower()
            aliases.setdefault(alias, set()).add(table)
        for match in re.finditer(rf'\b(?:FROM|JOIN)\s+{qualified}\b', source, re.I):
            table = match.group(1).lower()
            if re.search(rf'\b{re.escape(table.rsplit(".", 1)[-1])}\s*\.\s*\*', source, re.I):
                tables.add(table)
            if re.search(rf'\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+{re.escape(table)}\b', source, re.I):
                tables.add(table)
        for alias, candidates in aliases.items():
            if re.search(rf'\b{re.escape(alias)}\s*\.\s*\*', source, re.I):
                tables.update(candidates)
            if re.search(rf'\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+{re.escape(alias)}\b', source, re.I):
                tables.update(candidates)
            if re.search(rf'\b(?:SELECT\s+\(?\s*{re.escape(alias)}\s*\)?\s*(?:,|FROM|$)|ROW\s*\(\s*{re.escape(alias)}\s*\))', source, re.I | re.M):
                tables.update(candidates)
    return frozenset(tables)


ROWTYPE_TABLES = derive_rowtype_tables([path.read_text() for path in MIGRATIONS.glob('2026093004*.sql')])


def _sha_text(value):
    if not isinstance(value, str) or not value or value.endswith('\n'):
        raise ValueError('canonical definition must be schema text without a trailing newline')
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _definition_digest(value):
    return _sha_text(value)


def _drift_digest(record):
    payload = {key: record[key] for key in ('record_version', 'target_ref', 'candidate_sha', 'baseline_digest', 'catalog_format_version', 'items')}
    return hashlib.sha256(canonical(payload).encode()).hexdigest()


def _validate_base_fingerprint(base):
    if (not isinstance(base, dict) or base.get('catalog_format_version') != CATALOG_FORMAT_VERSION
            or not isinstance(base.get('sections'), dict) or set(base['sections']) != set(CATALOG_SECTIONS)
            or set(base.get('section_sha256', {})) != set(CATALOG_SECTIONS)):
        raise ValueError('baseline catalog format mismatch')
    calculated = fingerprint(base['sections'], base['catalog_format_version'])
    if base.get('section_sha256') != calculated['section_sha256'] or base.get('sha256') != calculated['sha256']:
        raise ValueError('baseline catalog digest mismatch')
    return base


def _validate_drift_record(record, baseline=None, target_ref=None, candidate_sha=None, require_baseline_digest=True):
    if not isinstance(record, dict) or set(record) != {'record_version', 'target_ref', 'candidate_sha', 'baseline_digest', 'catalog_format_version', 'items', 'sha256'}:
        raise ValueError('malformed drift record')
    if record['record_version'] != DRIFT_RECORD_VERSION or record['catalog_format_version'] != CATALOG_FORMAT_VERSION:
        raise ValueError('drift record format mismatch')
    if not isinstance(record['target_ref'], str) or not record['target_ref'] or (target_ref is not None and record['target_ref'] != target_ref):
        raise ValueError('drift record target ref mismatch')
    if not isinstance(record['candidate_sha'], str) or not re.fullmatch(r'[0-9a-f]{40}', record['candidate_sha']) or (candidate_sha is not None and record['candidate_sha'] != candidate_sha):
        raise ValueError('drift record candidate SHA mismatch')
    if not isinstance(record['baseline_digest'], str) or not re.fullmatch(r'[0-9a-f]{64}', record['baseline_digest']):
        raise ValueError('drift record baseline digest mismatch')
    if not isinstance(record['items'], list) or record['sha256'] != _drift_digest(record):
        raise ValueError('drift record content digest mismatch')
    if baseline is not None:
        _validate_base_fingerprint(baseline)
        if require_baseline_digest and record['baseline_digest'] != baseline['sha256']:
            raise ValueError('drift record baseline digest mismatch')
    seen = set()
    relations = {row.get('identity'): row for row in (baseline or {}).get('sections', {}).get('relations', []) if isinstance(row, dict)}
    for item in record['items']:
        if not isinstance(item, dict) or set(item) != DRIFT_ITEM_KEYS:
            raise ValueError('malformed drift item')
        identity = (item['object'], item['attribute'], item['name'])
        if identity in seen:
            raise ValueError('duplicate drift item')
        seen.add(identity)
        if not all(isinstance(value, str) and value for value in identity):
            raise ValueError('malformed drift item identity')
        if item['object'] in ROWTYPE_TABLES:
            raise ValueError('rowtype-table drift item is forbidden')
        if item['attribute'] not in {'columns', 'indexes'} or not isinstance(item['canonical_definition'], str):
            raise ValueError('unknown drift item class')
        if item['definition_sha256'] != _definition_digest(item['canonical_definition']):
            raise ValueError('drift definition digest mismatch')
        classification = item['classification']
        if not isinstance(classification, dict) or classification.get('class') != {'columns': 'column', 'indexes': 'index'}[item['attribute']]:
            raise ValueError('drift classification mismatch')
        if item['origin'] not in {'unknown', 'platform'}:
            raise ValueError('unknown drift origin')
        relation = relations.get(item['object'])
        if relation is not None:
            owner = relation.get('owner')
            if item['origin'] == 'platform' and (item['object'] != 'auth.users' or item['attribute'] != 'indexes' or owner != 'supabase_auth_admin'):
                raise ValueError('mislabelled platform origin')
            if item['object'] == 'auth.users' and item['attribute'] == 'indexes' and item['origin'] != 'platform':
                raise ValueError('auth.users index origin mismatch')
        elif baseline is not None:
            raise ValueError('drift item object absent from baseline')
        if item['attribute'] == 'columns':
            expected = {'class', 'nullable', 'default', 'attidentity', 'attgenerated', 'column_acl', 'owner'}
            if (set(classification) != expected or classification['nullable'] is not True or classification['default'] is not None
                    or classification['attidentity'] != '' or classification['attgenerated'] != '' or classification['column_acl'] is not None
                    or not isinstance(classification['owner'], str) or not classification['owner']
                    or (relation is not None and classification['owner'] != relation.get('owner'))):
                raise ValueError('ineligible drift column')
            if item['approval_sha256'] is not None:
                raise ValueError('column approval is forbidden')
        else:
            expected = {'class', 'unique', 'primary', 'constraint', 'valid', 'ready', 'live', 'predicate', 'expression', 'owner'}
            if set(classification) != expected or any(classification[key] is not False for key in ('unique', 'primary', 'constraint')) or any(classification[key] is not True for key in ('valid', 'ready', 'live')):
                raise ValueError('ineligible drift index')
            if item['name'] in OPERATOR_INDEX_NAMES:
                raise ValueError('operator-index name collision')
            requires_approval = classification['predicate'] is not None or classification['expression'] is True
            expected_approval = DRIFT_APPROVALS.get(item['name']) if requires_approval else None
            if requires_approval and expected_approval is None:
                raise ValueError('unapproved expression or predicate index')
            if not isinstance(classification['owner'], str) or not classification['owner'] or (item['object'] == 'auth.users' and classification['owner'] != 'supabase_auth_admin'):
                raise ValueError('drift approval digest mismatch')
            if item['approval_sha256'] != expected_approval:
                raise ValueError('drift approval digest mismatch')
            if expected_approval is not None and _sha_text(item['canonical_definition']) != expected_approval:
                raise ValueError('drift approval digest mismatch')
    return record


def reconstruct_drift_fingerprint(baseline, record, *, bound_baseline_digest=None):
    _validate_base_fingerprint(baseline)
    _validate_drift_record(record, baseline, require_baseline_digest=bound_baseline_digest is None)
    if bound_baseline_digest is not None and record['baseline_digest'] != bound_baseline_digest:
        raise ValueError('drift record baseline digest mismatch')
    sections = json.loads(json.dumps(baseline['sections']))
    relations = {row['identity']: row for row in sections['relations']}
    seen = set()
    for item in record['items']:
        identity = (item['object'], item['attribute'], item['name'])
        if identity in seen:
            raise ValueError('duplicate drift item')
        seen.add(identity)
        relation = relations.get(item['object'])
        if relation is None:
            raise ValueError('drift item object absent from baseline')
        bucket = relation[item['attribute']]
        if any(entry.get('name') == item['name'] for entry in bucket):
            raise ValueError('drift item collides with baseline')
        c = item['classification']
        if item['attribute'] == 'columns':
            bucket.append({'name': item['name'], 'type': item['canonical_definition'], 'not_null': not c['nullable'], 'default': c['default'], 'acl': c['column_acl'], 'attgenerated': c['attgenerated'], 'attidentity': c['attidentity']})
            bucket.sort(key=lambda entry: entry['name'])
        else:
            bucket.append({'name': item['name'], 'definition': item['canonical_definition'], 'unique': c['unique'], 'primary': c['primary'], 'constraint': c['constraint'], 'valid': c['valid'], 'ready': c['ready'], 'live': c['live'], 'predicate': c['predicate'], 'expression': c['expression'], 'owner': c['owner']})
            bucket.sort(key=lambda entry: entry['definition'])
    return fingerprint(sections, CATALOG_FORMAT_VERSION)


def generate_drift_record(baseline, observed, target_ref, candidate_sha):
    _validate_base_fingerprint(baseline)
    _validate_base_fingerprint(observed)
    if not isinstance(target_ref, str) or not target_ref or not re.fullmatch(r'[0-9a-z]+', target_ref):
        raise ValueError('invalid target ref')
    if not isinstance(candidate_sha, str) or not re.fullmatch(r'[0-9a-f]{40}', candidate_sha):
        raise ValueError('invalid candidate SHA')
    if baseline['sections'].keys() != observed['sections'].keys():
        raise ValueError('catalog section set changed')
    for name in baseline['sections']:
        if name != 'relations' and baseline['sections'][name] != observed['sections'][name]:
            raise ValueError(f'non-relations catalog drift: {name}')
    base_relations = {row['identity']: row for row in baseline['sections']['relations']}
    observed_relations = {row['identity']: row for row in observed['sections']['relations']}
    if set(base_relations) != set(observed_relations):
        raise ValueError('relation object drift is not recordable')
    items = []
    for identity, base in base_relations.items():
        current = observed_relations[identity]
        for key in set(base) | set(current):
            if key not in {'columns', 'indexes'} and base.get(key) != current.get(key):
                raise ValueError(f'relation metadata drift is not recordable: {identity}.{key}')
        for attribute, class_name in (('columns', 'column'), ('indexes', 'index')):
            base_items = {entry['name']: entry for entry in base[attribute]}
            current_items = {entry['name']: entry for entry in current[attribute]}
            if set(base_items) - set(current_items):
                raise ValueError(f'baseline {class_name} missing or altered: {identity}')
            for name, entry in current_items.items():
                if name in base_items:
                    if base_items[name] != entry:
                        raise ValueError(f'baseline {class_name} altered: {identity}.{name}')
                    continue
                if class_name == 'column':
                    classification = {'class': 'column', 'nullable': not entry['not_null'], 'default': entry['default'], 'attidentity': entry['attidentity'], 'attgenerated': entry['attgenerated'], 'column_acl': entry['acl'], 'owner': current['owner']}
                    item = {'object': identity, 'attribute': attribute, 'name': name, 'canonical_definition': entry['type'], 'definition_sha256': _definition_digest(entry['type']), 'classification': classification, 'origin': 'unknown', 'approval_sha256': None}
                else:
                    classification = {'class': 'index', 'unique': entry['unique'], 'primary': entry['primary'], 'constraint': entry['constraint'], 'valid': entry['valid'], 'ready': entry['ready'], 'live': entry['live'], 'predicate': entry['predicate'], 'expression': entry['expression'], 'owner': entry['owner']}
                    approval = DRIFT_APPROVALS.get(name) if classification['predicate'] is not None or classification['expression'] else None
                    if approval is not None and _sha_text(entry['definition']) != approval:
                        raise ValueError(f'approval digest mismatch: {identity}.{name}')
                    item = {'object': identity, 'attribute': attribute, 'name': name, 'canonical_definition': entry['definition'], 'definition_sha256': _definition_digest(entry['definition']), 'classification': classification, 'origin': 'platform' if identity == 'auth.users' else 'unknown', 'approval_sha256': approval}
                items.append(item)
    record = {'record_version': DRIFT_RECORD_VERSION, 'target_ref': target_ref, 'candidate_sha': candidate_sha, 'baseline_digest': baseline['sha256'], 'catalog_format_version': CATALOG_FORMAT_VERSION, 'items': sorted(items, key=lambda item: (item['object'], item['attribute'], item['name']))}
    record['sha256'] = _drift_digest(record)
    _validate_drift_record(record, baseline, target_ref, candidate_sha)
    if reconstruct_drift_fingerprint(baseline, record)['section_sha256'] != observed['section_sha256']:
        raise ValueError('drift record does not reconstruct observed catalog')
    return record


def validate_drift_items_fixture(fixture, baseline=None):
    if not isinstance(fixture, dict) or set(fixture) != {'fixture_version', 'items'} or fixture['fixture_version'] != DRIFT_FIXTURE_VERSION or not isinstance(fixture['items'], list):
        raise ValueError('malformed drift items fixture')
    payload = {
        'record_version': DRIFT_RECORD_VERSION,
        'target_ref': 'fixture',
        'candidate_sha': '0' * 40,
        'baseline_digest': baseline['sha256'] if baseline is not None else '0' * 64,
        'catalog_format_version': CATALOG_FORMAT_VERSION,
        'items': fixture['items'],
    }
    payload['sha256'] = _drift_digest(payload)
    _validate_drift_record(payload, baseline, require_baseline_digest=baseline is not None)
    return fixture


def fixture_bindings(fixture):
    return sorted((item['object'], item['attribute'], item['name'], item['definition_sha256']) for item in fixture['items'])


def record_bindings(record):
    return sorted((item['object'], item['attribute'], item['name'], item['definition_sha256']) for item in record['items'])


def generate_drift_items_fixture(baseline, observed, target_ref):
    if target_ref not in KNOWN_TARGET_REFS:
        raise ValueError('unknown target ref')
    record = generate_drift_record(baseline, observed, target_ref, '0' * 40)
    fixture = {'fixture_version': DRIFT_FIXTURE_VERSION, 'items': record['items']}
    validate_drift_items_fixture(fixture, baseline)
    return fixture


def generate_drift_record_from_fixture(baseline, observed, fixture, target_ref, candidate_sha):
    if target_ref not in KNOWN_TARGET_REFS:
        raise ValueError('unknown target ref')
    validate_drift_items_fixture(fixture, baseline)
    record = {
        'record_version': DRIFT_RECORD_VERSION,
        'target_ref': target_ref,
        'candidate_sha': candidate_sha,
        'baseline_digest': baseline['sha256'],
        'catalog_format_version': CATALOG_FORMAT_VERSION,
        'items': fixture['items'],
    }
    record['sha256'] = _drift_digest(record)
    _validate_drift_record(record, baseline, target_ref, candidate_sha)
    expected = reconstruct_drift_fingerprint(baseline, record)
    if expected['section_sha256'] != observed.get('section_sha256') or expected['sha256'] != observed.get('sha256'):
        raise ValueError('drift fixture does not reconstruct observed catalog')
    return record


def drift_fixture_sql(fixture, origin=None):
    if origin not in (None, 'platform', 'nonplatform'):
        raise ValueError('unknown drift SQL origin')
    validate_drift_items_fixture(fixture)
    statements = []
    for item in fixture['items']:
        if origin is not None and (item['origin'] == 'platform') != (origin == 'platform'):
            continue
        if ';' in item['canonical_definition'] or '\x00' in item['canonical_definition']:
            raise ValueError('drift definition contains SQL terminator')
        schema, table = item['object'].split('.', 1)
        quote = lambda value: '"' + value.replace('"', '""') + '"'
        if item['attribute'] == 'columns':
            statements.append(f'ALTER TABLE {quote(schema)}.{quote(table)} ADD COLUMN {quote(item["name"])} {item["canonical_definition"]};')
        else:
            if not re.match(r'^CREATE INDEX\s+', item['canonical_definition'], re.I):
                raise ValueError('drift index definition is not a CREATE INDEX statement')
            statements.append(item['canonical_definition'] + ';')
    return '\n'.join(statements) + ('\n' if statements else '')


def read_catalog(identifiers, scope):
    # The only non-pg_catalog data read is the explicitly required migration
    # ledger. Everything else comes from pg_catalog, in one read-only txn.
    ids = canonical(identifiers).replace("'", "''")
    index_names = canonical(scope['created_indexes']).replace("'", "''")
    trigger_names = canonical(scope['created_triggers']).replace("'", "''")
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
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',r.identity,'kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
   'acl',c.relacl::text,'rls',c.relrowsecurity,'rls_forced',c.relforcerowsecurity,
   'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text,'attgenerated',a.attgenerated,'attidentity',a.attidentity) ORDER BY a.attname),'[]'::jsonb) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT coalesce(jsonb_agg(pg_catalog.pg_get_constraintdef(k.oid) ORDER BY k.conname),'[]'::jsonb) FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
   'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_catalog.pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'primary',i.indisprimary,'constraint',EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid=i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid),'expression',EXISTS (SELECT 1 FROM unnest(i.indkey) AS key(attnum) WHERE key.attnum=0),'owner',pg_catalog.pg_get_userbyid(ic.relowner)) ORDER BY pg_catalog.pg_get_indexdef(i.indexrelid)),'[]'::jsonb) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
   'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname),'[]'::jsonb) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
   'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT coalesce(jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_oid) END ORDER BY role_oid),'[]'::jsonb) FROM unnest(p.polroles) role_oid),'qual',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'with_check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]'::jsonb) FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)
 ) ORDER BY r.identity),'[]'::jsonb) FROM rels r JOIN pg_catalog.pg_class c ON c.oid=r.oid),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',f.identity,'signature',p.oid::pg_catalog.regprocedure::text,'definition',pg_catalog.pg_get_functiondef(p.oid),'security_definer',p.prosecdef,'owner',pg_catalog.pg_get_userbyid(p.proowner),'config',p.proconfig,'acl',p.proacl::text) ORDER BY f.identity,p.oid::pg_catalog.regprocedure::text),'[]'::jsonb) FROM funcs f JOIN pg_catalog.pg_proc p ON p.oid=f.oid),
 'types',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',t.identity,'kind',y.typtype,'definition',pg_catalog.format_type(y.oid,NULL),'acl',y.typacl::text) ORDER BY t.identity),'[]'::jsonb) FROM types t JOIN pg_catalog.pg_type y ON y.oid=t.oid),
 'extensions',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion) ORDER BY e.extname),'[]'::jsonb) FROM pg_catalog.pg_extension e),
 'schemas',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname,'acl',n.nspacl::text) ORDER BY n.nspname),'[]'::jsonb) FROM pg_catalog.pg_namespace n WHERE n.nspname IN (SELECT schema_name FROM wanted)),
 'index_names',(SELECT coalesce(jsonb_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname),'[]'::jsonb) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('i','I') AND n.nspname||'.'||c.relname IN (SELECT jsonb_array_elements_text('{index_names}'::jsonb))),
 'trigger_names',(SELECT coalesce(jsonb_agg(n.nspname||'.'||c.relname||'.'||t.tgname ORDER BY n.nspname,c.relname,t.tgname),'[]'::jsonb) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname||'.'||c.relname||'.'||t.tgname IN (SELECT jsonb_array_elements_text('{trigger_names}'::jsonb))),
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
    parser.add_argument('--write-drift-record', action='store_true', help='build a content-addressed record from two read-only catalog observations')
    parser.add_argument('--write-drift-items-fixture', action='store_true', help='build an unbound tool-output fixture from two read-only catalog observations')
    parser.add_argument('--write-drift-fixture-sql', action='store_true', help='emit SQL that materializes a committed drift items fixture')
    parser.add_argument('--verify-drift-record', action='store_true', help='verify a drift record reconstructs a read-only catalog observation')
    parser.add_argument('--catalog-observation', type=Path)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--drift-record', type=Path)
    parser.add_argument('--fixture', type=Path)
    parser.add_argument('--target-ref')
    parser.add_argument('--candidate-sha')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--platform-output', type=Path, help='with --output, write platform-origin SQL separately')
    args = parser.parse_args()
    if args.write_drift_items_fixture:
        if not all((args.catalog_observation, args.baseline, args.target_ref, args.output)):
            raise SystemExit('--write-drift-items-fixture requires --catalog-observation --baseline --target-ref --output')
        fixture = generate_drift_items_fixture(json.loads(args.baseline.read_text()), json.loads(args.catalog_observation.read_text()), args.target_ref)
        args.output.write_text(json.dumps(fixture, indent=2, sort_keys=True) + '\n')
        print(json.dumps({'fixture_version': DRIFT_FIXTURE_VERSION, 'items': len(fixture['items']), 'output': str(args.output)}, sort_keys=True))
        return
    if args.write_drift_fixture_sql:
        if not args.fixture:
            raise SystemExit('--write-drift-fixture-sql requires --fixture')
        fixture = json.loads(args.fixture.read_text())
        if args.platform_output:
            if not args.output:
                raise SystemExit('--platform-output requires --output')
            args.output.write_text(drift_fixture_sql(fixture, origin='nonplatform'))
            args.platform_output.write_text(drift_fixture_sql(fixture, origin='platform'))
            return
        sql = drift_fixture_sql(fixture)
        if args.output:
            args.output.write_text(sql)
        else:
            print(sql, end='')
        return
    if args.write_drift_record:
        if not all((args.catalog_observation, args.baseline, args.target_ref, args.candidate_sha, args.output)):
            raise SystemExit('--write-drift-record requires --catalog-observation --baseline --target-ref --candidate-sha --output')
        baseline = json.loads(args.baseline.read_text())
        observed = json.loads(args.catalog_observation.read_text())
        record = (generate_drift_record_from_fixture(baseline, observed, json.loads(args.fixture.read_text()), args.target_ref, args.candidate_sha)
                  if args.fixture else generate_drift_record(baseline, observed, args.target_ref, args.candidate_sha))
        args.output.write_text(json.dumps(record, indent=2, sort_keys=True) + '\n')
        print(json.dumps({'drift_record_sha256': record['sha256'], 'items': len(record['items']), 'output': str(args.output)}, sort_keys=True))
        return
    if args.verify_drift_record:
        if not all((args.catalog_observation, args.baseline, args.drift_record)):
            raise SystemExit('--verify-drift-record requires --catalog-observation --baseline --drift-record')
        baseline = json.loads(args.baseline.read_text())
        observed = json.loads(args.catalog_observation.read_text())
        expected = reconstruct_drift_fingerprint(baseline, json.loads(args.drift_record.read_text()))
        if expected['section_sha256'] != observed.get('section_sha256') or expected['sha256'] != observed.get('sha256'):
            raise SystemExit('Drift record reconstruction differs from observation')
        print(json.dumps({'verdict': 'PASS', 'catalog_sha256': expected['sha256']}, sort_keys=True))
        return
    current = migration_identifiers()
    generated_scope = {'catalog_format_version': CATALOG_FORMAT_VERSION, 'qualified_identifiers': current, 'created_objects': created_identifiers(), **created_name_scope()}
    if args.write_manifest:
        MANIFEST.write_text(json.dumps(generated_scope, indent=2) + '\n')
        return
    scope = json.loads(MANIFEST.read_text())
    pinned = scope['qualified_identifiers']
    missing = sorted(set(current) - set(pinned))
    if missing:
        raise SystemExit('Missing migration identifiers from catalog manifest: ' + ', '.join(missing))
    if any(scope.get(key) != value for key, value in generated_scope.items() if key != 'qualified_identifiers'):
        raise SystemExit('Created-object manifest drift')
    if args.check_manifest:
        print(f'PASS: {len(current)} migration identifiers covered')
        return
    sections = normalize(read_catalog(pinned, scope))
    existing = created_objects_present(sections, scope)
    sections['created_objects_present'] = existing
    if args.preflight and existing:
        raise SystemExit('Migration-created objects already exist: ' + ', '.join(existing))
    result = fingerprint(sections, scope.get('catalog_format_version', CATALOG_FORMAT_VERSION))
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
