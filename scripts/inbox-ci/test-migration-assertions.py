import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('assertions', Path(__file__).with_name('migration-assertions.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class MigrationAssertionsTest(unittest.TestCase):
    def test_exact_three_migration_names_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'supabase/migrations'
            directory.mkdir(parents=True)
            for version, name in zip(a.VERSIONS, a.NAMES):
                (directory / f'{version}_{name}.sql').write_text('SELECT 1;\n')
            self.assertEqual(len(a.migration_files(tmp)), 3)
            (directory / '20260929000300_unreviewed.sql').write_text('SELECT 1;\n')
            with self.assertRaisesRegex(ValueError, 'exactly the three'):
                a.migration_files(tmp)

    def test_missing_migration_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'missing='):
                a.migration_files(tmp)

    def test_second_apply_mutations_fail(self):
        a.assert_second_apply(3, a.REFUSAL, list(a.VERSIONS))
        for code, message, versions in [(0, a.REFUSAL, list(a.VERSIONS)), (3, 'other error', list(a.VERSIONS)), (3, a.REFUSAL, list(a.VERSIONS[:-1]))]:
            with self.assertRaises(ValueError):
                a.assert_second_apply(code, message, versions)

    def test_missing_history_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'supabase/migrations'
            directory.mkdir(parents=True)
            (directory / '20260901000000_old.sql').write_text('SELECT 1;\n')
            a.assert_full_history(tmp, ['20260901000000'])
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                a.assert_full_history(tmp, [])

    def test_verify_count_mutation_fails(self):
        a.assert_verify('{"private_helper_exposure_count":0}')
        with self.assertRaises(ValueError):
            a.assert_verify('{"private_helper_exposure_count":1}')

    def test_mutation_harness_count_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'cases.json'
            path.write_text(json.dumps({'passed': True, 'cases': [{'drift_caught': True, 'restored_pass': True}] * 41}))
            a.assert_mutations(path)
            path.write_text(json.dumps({'passed': True, 'cases': [{'drift_caught': True, 'restored_pass': True}] * 40}))
            with self.assertRaises(ValueError):
                a.assert_mutations(path)

    def test_index_mutations_fail(self):
        statement = 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ' + 'sample ON public.messages(id);'
        assert len(a.index_statements(statement * 8)) == 8
        for source in (statement * 7, statement.replace('CONCURRENTLY ', '') * 8):
            with self.assertRaises(ValueError):
                a.index_statements(source)

    def test_catalog_live_skip_fails(self):
        a.assert_catalog_live('Ran 5 tests in 0.100s\n\nOK\n')
        for output in ('Ran 5 tests in 0.100s\n\nOK (skipped=5)\n', 'Ran 4 tests in 0.100s\n\nOK\n', 'Ran 5 tests in 0.100s\n\nFAILED (failures=1)\n'):
            with self.assertRaisesRegex(ValueError, 'Five live catalog'):
                a.assert_catalog_live(output)

    def test_offline_suite_skip_fails(self):
        a.assert_offline_suite('Ran 67 tests in 1.000s\n\nOK\n')
        for output in ('Ran 72 tests in 1.000s\n\nOK (skipped=5)\n',
                       'Ran 63 tests in 1.000s\n\nOK\n'):
            with self.assertRaises(ValueError):
                a.assert_offline_suite(output)

    def test_catalog_harness_drift_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            first, second = Path(tmp) / 'first.json', Path(tmp) / 'second.json'
            first.write_text(json.dumps({'section_sha256': {'schema': 'a'}}))
            second.write_text(json.dumps({'section_sha256': {'schema': 'b'}}))
            with self.assertRaisesRegex(ValueError, 'Catalog changed'):
                a.assert_catalog_unchanged(first, second)
            second.write_text(first.read_text())
            a.assert_catalog_unchanged(first, second)


if __name__ == '__main__':
    unittest.main()
