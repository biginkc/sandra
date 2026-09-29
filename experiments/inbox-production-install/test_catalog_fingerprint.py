import importlib.util
from pathlib import Path
import unittest

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
    def test_missing_identifier_mutation_fails_coverage(self):
        import json
        scope = json.loads(f.MANIFEST.read_text())['qualified_identifiers']
        self.assertTrue(set(f.migration_identifiers()) - set(scope[1:]))
    def test_section_hash_mutates(self):
        baseline = f.fingerprint({'relations': [{'default': '0'}], 'schema_migrations': ['1']})
        mutated = f.fingerprint({'relations': [{'default': '42'}], 'schema_migrations': ['1']})
        self.assertNotEqual(baseline['section_sha256']['relations'], mutated['section_sha256']['relations'])
        self.assertEqual(baseline['section_sha256']['schema_migrations'], mutated['section_sha256']['schema_migrations'])

if __name__ == '__main__': unittest.main()
