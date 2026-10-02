import importlib.util
import copy
import hashlib
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

p = Path(__file__).with_name('catalog_fingerprint.py')
spec = importlib.util.spec_from_file_location('catalog_fingerprint', p)
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)

class CatalogScope(unittest.TestCase):
    def test_every_migration_identifier_is_manifested(self):
        import json
        scope = json.loads(f.MANIFEST.read_text())
        self.assertFalse(set(f.migration_identifiers()) - set(scope['qualified_identifiers']))
        self.assertEqual(f.created_identifiers(), scope['created_objects'])
        for key, value in f.created_name_scope().items():
            self.assertEqual(value, scope[key])
            self.assertTrue(value, key)
        sources = [p.read_text() for p in f.migration_files()]
        self.assertEqual(len(scope['created_triggers']), sum(len(re.findall(r'^CREATE TRIGGER\b', source, re.M | re.I)) for source in sources))
        self.assertEqual(len(scope['created_indexes']), sum(len(re.findall(r'^CREATE (?:UNIQUE )?INDEX\b', source, re.M | re.I)) for source in sources))
    def test_missing_identifier_mutation_fails_coverage(self):
        import json
        scope = json.loads(f.MANIFEST.read_text())['qualified_identifiers']
        self.assertTrue(set(f.migration_identifiers()) - set(scope[1:]))
    def test_section_hash_mutates(self):
        baseline = f.fingerprint({'relations': [{'default': '0'}], 'schema_migrations': ['1']})
        mutated = f.fingerprint({'relations': [{'default': '42'}], 'schema_migrations': ['1']})
        self.assertNotEqual(baseline['section_sha256']['relations'], mutated['section_sha256']['relations'])
        self.assertEqual(baseline['section_sha256']['schema_migrations'], mutated['section_sha256']['schema_migrations'])
    def test_literal_whitespace_collisions(self):
        for section, field, before, after in (
            ('relations', 'default', "'a  b'::text", "'a b'::text"),
            ('functions', 'definition', "SELECT 'a  b'::text", "SELECT 'a b'::text"),
            ('relations', 'qual', "name = 'a  b'::text", "name = 'a b'::text"),
        ):
            with self.subTest(section=section, field=field):
                first = f.fingerprint(f.normalize({section: [{field: before}]}))
                second = f.fingerprint(f.normalize({section: [{field: after}]}))
                self.assertNotEqual(first['section_sha256'][section], second['section_sha256'][section])
    def test_preflight_rejects_created_schema_trigger_and_index(self):
        import json
        scope = json.loads(f.MANIFEST.read_text())
        empty = {'relations': [], 'functions': [], 'types': [], 'schemas': [], 'trigger_names': [], 'index_names': [], 'schema_migrations': []}
        self.assertEqual(f.created_objects_present(empty, scope), [])
        for section, value in (
            ('schemas', {'name': scope['created_schemas'][0]}),
            ('trigger_names', scope['created_triggers'][0]),
            ('index_names', scope['created_indexes'][0]),
        ):
            sections = {**empty, section: [value]}
            with self.subTest(section=section), patch.object(f, 'read_catalog', return_value=sections), patch('sys.argv', ['catalog_fingerprint.py', '--preflight']):
                with self.assertRaisesRegex(SystemExit, 'Migration-created objects already exist'):
                    f.main()

    def test_tool_generated_fixture_and_sha_bound_record(self):
        sections = {name: [] for name in f.CATALOG_SECTIONS}
        sections['relations'] = [{'identity': 'public.message_threads', 'owner': 'postgres', 'columns': [], 'indexes': [], 'constraints': [], 'triggers': [], 'policies': []}]
        baseline = f.fingerprint(sections)
        observed_sections = copy.deepcopy(sections)
        observed_sections['relations'][0]['columns'].append({'name': 'new_column', 'type': 'uuid', 'not_null': False, 'default': None, 'acl': None, 'attgenerated': '', 'attidentity': ''})
        observed = f.fingerprint(observed_sections)
        fixture = f.generate_drift_items_fixture(baseline, observed, 'ncsngxlcyxylaeskiteu')
        self.assertEqual(set(fixture), {'fixture_version', 'items'})
        self.assertEqual(fixture['items'][0]['definition_sha256'], hashlib.sha256(b'uuid').hexdigest())
        record = f.generate_drift_record_from_fixture(baseline, observed, fixture, 'ncsngxlcyxylaeskiteu', 'a' * 40)
        self.assertEqual(f.record_bindings(record), f.fixture_bindings(fixture))
        self.assertNotIn('baseline_digest', fixture)
        self.assertNotIn('candidate_sha', fixture)

    def test_platform_index_drift_is_recordable(self):
        # Regression: 'indexes'[:-1] is 'indexe', so every index drift item failed validation
        # with 'drift classification mismatch' (the first TEST/PROD generator run).
        sections = {name: [] for name in f.CATALOG_SECTIONS}
        sections['relations'] = [{'identity': 'auth.users', 'owner': 'supabase_auth_admin', 'columns': [], 'indexes': [], 'constraints': [], 'triggers': [], 'policies': []}]
        baseline = f.fingerprint(sections)
        observed_sections = copy.deepcopy(sections)
        observed_sections['relations'][0]['indexes'].append({'name': 'platform_users_test_idx', 'definition': 'CREATE INDEX platform_users_test_idx ON auth.users USING btree (id)', 'unique': False, 'primary': False, 'constraint': False, 'valid': True, 'ready': True, 'live': True, 'predicate': None, 'expression': False, 'owner': 'supabase_auth_admin'})
        observed = f.fingerprint(observed_sections)
        fixture = f.generate_drift_items_fixture(baseline, observed, 'copflsklaefwzipsrjqz')
        self.assertEqual([(i['attribute'], i['classification']['class'], i['origin']) for i in fixture['items']], [('indexes', 'index', 'platform')])
        record = f.generate_drift_record_from_fixture(baseline, observed, fixture, 'copflsklaefwzipsrjqz', 'a' * 40)
        self.assertEqual(f.record_bindings(record), f.fixture_bindings(fixture))

    def test_drift_fixture_sql_is_partitioned_by_origin(self):
        sections = {name: [] for name in f.CATALOG_SECTIONS}
        sections['relations'] = [
            {'identity': 'auth.users', 'owner': 'supabase_auth_admin', 'columns': [], 'indexes': [], 'constraints': [], 'triggers': [], 'policies': []},
            {'identity': 'public.message_threads', 'owner': 'postgres', 'columns': [], 'indexes': [], 'constraints': [], 'triggers': [], 'policies': []},
        ]
        baseline = f.fingerprint(sections)
        observed_sections = copy.deepcopy(sections)
        observed_sections['relations'][0]['indexes'].append({
            'name': 'platform_users_test_idx',
            'definition': 'CREATE INDEX platform_users_test_idx ON auth.users USING btree (id)',
            'unique': False, 'primary': False, 'constraint': False, 'valid': True, 'ready': True,
            'live': True, 'predicate': None, 'expression': False, 'owner': 'supabase_auth_admin',
        })
        observed_sections['relations'][1]['columns'].append({
            'name': 'new_column', 'type': 'uuid', 'not_null': False, 'default': None, 'acl': None,
            'attgenerated': '', 'attidentity': '',
        })
        observed = f.fingerprint(observed_sections)
        fixture = f.generate_drift_items_fixture(baseline, observed, 'copflsklaefwzipsrjqz')

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            fixture_path = directory / 'fixture.json'
            nonplatform_path = directory / 'nonplatform.sql'
            platform_path = directory / 'platform.sql'
            fixture_path.write_text(json.dumps(fixture))
            with patch('sys.argv', [
                'catalog_fingerprint.py', '--write-drift-fixture-sql', '--fixture', str(fixture_path),
                '--output', str(nonplatform_path), '--platform-output', str(platform_path),
            ]):
                f.main()

            nonplatform_sql = nonplatform_path.read_text()
            platform_sql = platform_path.read_text()
        self.assertIn('ALTER TABLE "public"."message_threads" ADD COLUMN "new_column" uuid;', nonplatform_sql)
        self.assertNotIn('CREATE INDEX platform_users_test_idx', nonplatform_sql)
        self.assertIn('CREATE INDEX platform_users_test_idx ON auth.users USING btree (id);', platform_sql)
        self.assertNotIn('ALTER TABLE', platform_sql)

    def test_no_drift_is_an_explicit_empty_fixture_and_sql_is_safe(self):
        sections = {name: [] for name in f.CATALOG_SECTIONS}
        sections['relations'] = [{'identity': 'public.message_threads', 'owner': 'postgres', 'columns': [], 'indexes': [], 'constraints': [], 'triggers': [], 'policies': []}]
        baseline = f.fingerprint(sections)
        fixture = f.generate_drift_items_fixture(baseline, baseline, 'copflsklaefwzipsrjqz')
        self.assertEqual(fixture, {'fixture_version': f.DRIFT_FIXTURE_VERSION, 'items': []})
        self.assertEqual(f.drift_fixture_sql(fixture), '')

if __name__ == '__main__': unittest.main()
