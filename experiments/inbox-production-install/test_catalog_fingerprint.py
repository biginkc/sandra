import importlib.util
from pathlib import Path
import re
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
        sources = [p.read_text() for p in f.MIGRATIONS.glob('2026092900*.sql')]
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

if __name__ == '__main__': unittest.main()
