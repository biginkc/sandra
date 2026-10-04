"""Migration-helper failures must stop every affected lane before provisioning."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LANES = Path(__file__).resolve().parent


class MigrationHelperGuardTest(unittest.TestCase):
    def run_lane(self, lane, mode):
        with tempfile.TemporaryDirectory() as temporary:
            tmp = Path(temporary)
            bin_dir = tmp / 'bin'
            bin_dir.mkdir()
            marker = tmp / 'provisioned'
            github_env = tmp / 'github-env'
            github_env.touch()
            sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()

            git = bin_dir / 'git'
            git.write_text('''#!/bin/sh
if [ "$1" = rev-parse ] && [ "$2" = HEAD ]; then
  printf '%s\n' "$HEAVY_TESTED_SHA"
  exit 0
fi
if [ "$1" = rev-parse ] && [ "$2" = --show-toplevel ]; then
  printf '%s\n' "$REPO_ROOT"
  exit 0
fi
if [ "$1" = status ]; then exit 0; fi
exit 0
''')
            git.chmod(0o755)

            node = bin_dir / 'node'
            node.write_text('''#!/bin/bash
if [[ "$1" == *scripts/inbox-ci/inbox-migrations.mjs ]]; then
  if [[ "$2" == --count ]]; then
    printf '3\n'
    exit 0
  fi
  if [[ "$MUTATION_MODE" == nonzero ]]; then
    echo 'stubbed migration helper failure' >&2
    exit 37
  fi
  exit 0
fi
if [[ "$1" == *provision-disposable-stack.mjs ]]; then
  printf 'provisioned\n' >> "$PROVISION_MARKER"
  exit 99
fi
exit 0
''')
            node.chmod(0o755)

            uname = bin_dir / 'uname'
            uname.write_text('#!/bin/sh\nprintf Linux\n')
            uname.chmod(0o755)
            docker = bin_dir / 'docker'
            docker.write_text('#!/bin/sh\nexit 0\n')
            docker.chmod(0o755)
            supabase = bin_dir / 'supabase'
            supabase.write_text('#!/bin/sh\nexit 0\n')
            supabase.chmod(0o755)

            script = LANES / f'{lane}.sh'
            if lane == 'migration-dry-run':
                script = tmp / 'migration-dry-run.sh'
                source = (LANES / 'migration-dry-run.sh').read_text()
                source = source.replace(
                    'preflight "$@"\n',
                    'DOCKER_SOCKET=unix:///tmp/fake-docker; API_PORT=55421; DB_PORT=55422\n',
                )
                script.write_text(source)
                script.chmod(0o755)
                compat = tmp / 'mapfile-compat.sh'
                compat.write_text((LANES / 'mapfile-compat.sh').read_text())
                compat.chmod(0o755)

            env = {
                **os.environ,
                'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                'REPO_ROOT': str(ROOT),
                'PROVISION_MARKER': str(marker),
                'MUTATION_MODE': mode,
                'RUNNER_TEMP': temporary,
                'GITHUB_ENV': str(github_env),
                'GITHUB_RUN_ID': '901',
                'GITHUB_RUN_ATTEMPT': '1',
                'GITHUB_ACTIONS': 'true',
                'GITHUB_EVENT_NAME': 'workflow_dispatch',
                'GITHUB_REF_NAME': 'main',
                'GITHUB_WORKFLOW_REF': 'biginkc/sandra/.github/workflows/inbox-heavy-verification.yml@main',
                'HEAVY_TESTED_SHA': sha,
                'HEAVY_LANE': lane,
            }
            env.pop('CI', None)
            result = subprocess.run(
                ['bash', str(script)],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0, f'{lane}/{mode} unexpectedly passed')
            self.assertFalse(marker.exists(), f'{lane}/{mode} provisioned after helper guard failure')
            if mode == 'nonzero':
                self.assertIn('stubbed migration helper failure', result.stderr)
            else:
                self.assertRegex(result.stderr, r'Expected [36] Inbox migration')

    def test_helper_nonzero_fails_before_provisioning(self):
        for lane in (
            'outbox-pre',
            'db-contract-pre',
            'db-contract-post',
            'drift-replay',
            'migration-dry-run',
            'burst',
            'perf-120k',
        ):
            with self.subTest(lane=lane):
                self.run_lane(lane, 'nonzero')

    def test_zero_count_output_fails_before_provisioning(self):
        for lane in (
            'outbox-pre',
            'db-contract-pre',
            'db-contract-post',
            'drift-replay',
            'migration-dry-run',
            'burst',
            'perf-120k',
        ):
            with self.subTest(lane=lane):
                self.run_lane(lane, 'empty')


if __name__ == '__main__':
    unittest.main()
