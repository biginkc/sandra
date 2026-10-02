import importlib.util
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('assertions', Path(__file__).with_name('migration-assertions.py'))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


class MigrationAssertionsTest(unittest.TestCase):
    def test_source_manifest_matches_checkout_files(self):
        install = Path(__file__).resolve().parents[2] / 'experiments/inbox-production-install'
        manifest = json.loads((install / 'source-manifest.json').read_text())
        self.assertTrue(manifest)
        for name, expected in manifest.items():
            with self.subTest(name=name):
                self.assertEqual(hashlib.sha256((install / name).read_bytes()).hexdigest(), expected)

    def test_github_hosted_refuses_local_diagnostic(self):
        lane = Path(__file__).with_name('migration-dry-run.sh')
        result = subprocess.run(['bash', str(lane), '--preflight-only'],
                                env={'PATH': '/usr/bin:/bin', 'RUNNER_ENVIRONMENT': 'github-hosted',
                                     'MIGRATION_LOCAL_EXECUTION': '1'},
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 3)
        self.assertIn('Local diagnostic refused on github-hosted runner', result.stderr)

    def test_preflight_failure_routes_to_fail_record(self):
        lane = Path(__file__).with_name('migration-dry-run.sh')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            node = bin_dir / 'node'
            node.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > "$FAIL_WRITER_CALL"\n')
            node.chmod(0o755)
            env = {
                **os.environ,
                'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                'RUNNER_TEMP': tmp,
                'DOCKER_HOST': 'unix:///tmp/not-a-docker-socket',
                'GITHUB_RUN_ID': '901',
                'HEAVY_TESTED_SHA': 'a' * 40,
                'GITHUB_ENV': str(root / 'github-env'),
                'FAIL_WRITER_CALL': str(root / 'writer-call'),
            }
            result = subprocess.run(['bash', str(lane), '--preflight-only'], env=env,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn('Runner requires /var/run/docker.sock', result.stderr)
            self.assertIn('write-migration-record.mjs', (root / 'writer-call').read_text())
            self.assertIn('--fail 3', (root / 'writer-call').read_text())
            self.assertEqual(len(list(root.glob('inbox-migration.*/failure.log'))), 1)
            self.assertIn('HEAVY_RUN_DIR=', (root / 'github-env').read_text())

    def test_runner_socket_requires_system_docker_socket(self):
        self.assertEqual(a.docker_socket({'GITHUB_ACTIONS': 'true'}), 'unix:///var/run/docker.sock')
        with self.assertRaisesRegex(ValueError, 'Runner requires'):
            a.docker_socket({'GITHUB_ACTIONS': 'true', 'DOCKER_HOST': 'unix:///tmp/colima/docker.sock'})
        self.assertEqual(a.docker_socket({'GITHUB_ACTIONS': 'true', 'MIGRATION_LOCAL_EXECUTION': '1', 'DOCKER_HOST': 'unix:///tmp/colima/docker.sock'}), 'unix:///tmp/colima/docker.sock')
    def test_exact_three_migration_names_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'supabase/migrations'
            directory.mkdir(parents=True)
            for version, name in zip(a.VERSIONS, a.NAMES):
                (directory / f'{version}_{name}.sql').write_text('SELECT 1;\n')
            self.assertEqual(len(a.migration_files(tmp)), 3)
            unreviewed = directory / f'{a.RESERVED_END[:-2]}50_inbox_unreviewed.sql'
            unreviewed.write_text('SELECT 1;\n')
            with self.assertRaisesRegex(ValueError, 'manifest Inbox'):
                a.migration_files(tmp)
            unreviewed.unlink()
            stale = directory / ('20260929' + '000000_inbox_control_foundation.sql')
            stale.write_text('SELECT 1;\n')
            with self.assertRaisesRegex(ValueError, 'manifest Inbox'):
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

    def test_index_precondition_rows(self):
        good = ''.join(f'index_{n}|t|8|t\n' for n in range(8))
        a.assert_index_preconditions(good)
        with self.assertRaisesRegex(ValueError, 'Eight valid concurrent indexes'):
            a.assert_index_preconditions(good.replace('index_7|t|8|t', 'index_7|f|8|t'))

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
