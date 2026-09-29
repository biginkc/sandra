"""Stubbed post-provisioning failures must leave a stageable FAIL run."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LANES = Path(__file__).resolve().parent


class ExitFailureTest(unittest.TestCase):
    def run_lane(self, lane, node_script, *, env_extra=None, script=None, expected_error=None):
        with tempfile.TemporaryDirectory() as temporary:
            tmp = Path(temporary)
            bin_dir = tmp / 'bin'
            bin_dir.mkdir()
            node = bin_dir / 'node'
            node.write_text('#!/bin/bash\n' + node_script)
            node.chmod(0o755)
            docker = bin_dir / 'docker'
            docker.write_text('#!/bin/bash\necho supabase_db_sandra-heavy-test\n')
            docker.chmod(0o755)
            git = bin_dir / 'git'
            git.write_text('#!/bin/bash\nif [[ "$1" == status ]]; then exit 0; fi\nexec /usr/bin/git "$@"\n')
            git.chmod(0o755)
            github_env = tmp / 'github-env'
            github_env.touch()
            sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                   'RUNNER_TEMP': temporary, 'GITHUB_ENV': str(github_env),
                   'GITHUB_RUN_ID': '901', 'GITHUB_RUN_ATTEMPT': '1',
                   'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                   'GITHUB_REF_NAME': 'main', 'HEAVY_TESTED_SHA': sha,
                   'HEAVY_LANE': lane, 'FAIL_TEST_DIR': temporary,
                   'GITHUB_WORKFLOW_REF': 'biginkc/sandra/.github/workflows/inbox-heavy-verification.yml@main'}
            env.update(env_extra or {})
            result = subprocess.run(['bash', str(script or LANES / f'{lane}.sh')], cwd=ROOT, env=env,
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            if expected_error:
                self.assertIn(expected_error, result.stderr)
            self.assertTrue((tmp / 'manifest.json').exists(), result.stderr)
            self.assertIn('"verdict":"FAIL"', (tmp / 'manifest.json').read_text())
            self.assertIn('HEAVY_RUN_DIR=', github_env.read_text())

    def test_migration_and_catalog_post_provision_guard(self):
        # The copied script skips machine-specific Docker preflight, then executes
        # the real post-provision URL guard with a stubbed provisioner.
        for lane in ('migration-dry-run', 'catalog-fingerprint'):
            with self.subTest(lane=lane):
                source = (LANES / 'migration-dry-run.sh').read_text()
                source = source.replace('preflight "$@"\n', 'DOCKER_SOCKET=unix:///var/run/docker.sock; API_PORT=55421; DB_PORT=55422\n')
                script = LANES / '.test-migration-exit.sh'
                script.write_text(source)
                try:
                    self.run_lane(lane, '''
if [[ "$1" == *provision-disposable-stack.mjs ]]; then
  printf 'E2E_CI_SUPABASE_DB_URL=unsafe\\n' >> "$GITHUB_ENV"
  exit 0
fi
if [[ "$1" == *write-migration-record.mjs ]]; then
  printf '{"verdict":"FAIL"}' > "$FAIL_TEST_DIR/manifest.json"
  exit 0
fi
exit 7
''', script=script, env_extra={'DOCKER_HOST': 'unix:///var/run/docker.sock'},
                                  expected_error='Provisioner did not report the requested local DB URL')
                finally:
                    script.unlink()

    def test_db_contract_pre_and_post_provision_failure(self):
        for lane in ('db-contract-pre', 'db-contract-post'):
            with self.subTest(lane=lane):
                self.run_lane(lane, '''
if [[ "$1" == *provision-disposable-stack.mjs ]]; then
  printf 'E2E_LOCAL_WORKDIR=%s\\n' "$FAIL_TEST_DIR/owned" >> "$GITHUB_ENV"
  exit 0
fi
if [[ "$1" == *write-failure-record.mjs ]]; then
  printf '{"verdict":"FAIL"}' > "$FAIL_TEST_DIR/manifest.json"
  exit 0
fi
exit 7
''')

    def test_existing_pass_cleanup_failure_stages_but_exits_failed(self):
        with tempfile.TemporaryDirectory() as temporary:
            tmp = Path(temporary)
            sha = 'a' * 40
            run_dir = tmp / 'docs/performance/inbox-redesign/evidence' / sha / 'pre-merge/901'
            run_dir.mkdir(parents=True)
            (run_dir / 'manifest.json').write_text('{"verdict":"PASS","exit_status":0}')
            github_env = tmp / 'github-env'
            github_env.touch()
            bin_dir = tmp / 'bin'
            bin_dir.mkdir()
            node = bin_dir / 'node'
            node.write_text('#!/bin/bash\nprintf called > "$FAIL_TEST_DIR/second-seal"\nexit 1\n')
            node.chmod(0o755)
            script = f'''source "{LANES / 'failure-exit.sh'}"
cleanup_fails() {{ return 7; }}
heavy_lane_exit 0 cleanup_fails
'''
            result = subprocess.run(['bash', '-c', script], cwd=tmp,
                                    env={**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                                         'FAIL_TEST_DIR': temporary, 'HEAVY_TESTED_SHA': sha,
                                         'GITHUB_RUN_ID': '901', 'GITHUB_ENV': str(github_env)},
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 7)
            self.assertIn('HEAVY_RUN_DIR=docs/performance/inbox-redesign/evidence/', github_env.read_text())
            self.assertEqual((run_dir / 'manifest.json').read_text(), '{"verdict":"PASS","exit_status":0}')
            self.assertFalse((tmp / 'second-seal').exists())

    def test_perf_burst_and_120k_post_provision_guard(self):
        for lane in ('burst', 'perf-120k'):
            with self.subTest(lane=lane):
                self.run_lane(lane, '''
if [[ "$1" == *provision-disposable-stack.mjs ]]; then
  mkdir -p "$FAIL_TEST_DIR/owned/supabase"
  printf 'project_id = "sandra-heavy-test"\\n' > "$FAIL_TEST_DIR/owned/supabase/config.toml"
  printf 'E2E_LOCAL_WORKDIR=%s\\nE2E_CI_SUPABASE_DB_URL=postgresql://unsafe.example/postgres\\nTEST_SUPABASE_URL=http://127.0.0.1:55421\\nTEST_SUPABASE_SERVICE_ROLE_KEY=synthetic\\n' "$FAIL_TEST_DIR/owned" >> "$GITHUB_ENV"
  exit 0
fi
if [[ "$1" == *write-failure-record.mjs ]]; then
  printf '{"verdict":"FAIL"}' > "$FAIL_TEST_DIR/manifest.json"
  exit 0
fi
exit 7
''', expected_error='Non-local Supabase endpoint')

    def test_outbox_pre_and_post_provision_guard(self):
        for lane in ('outbox-pre', 'outbox-post'):
            with self.subTest(lane=lane):
                self.run_lane(lane, '''
if [[ "$1" == *write-failure-record.mjs ]]; then
  printf '{"verdict":"FAIL"}' > "$FAIL_TEST_DIR/manifest.json"
  exit 0
fi
exit 7
''', env_extra={'CI': 'unexpected'})


if __name__ == '__main__':
    unittest.main()
