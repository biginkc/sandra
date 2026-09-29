"""Synthetic W3 records must satisfy W1's pull and sealed-evidence interfaces."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import importlib.util

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('sealed_evidence', ROOT / 'experiments/inbox-release/sealed_evidence.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
PULL = ROOT / 'scripts/ci/pull-heavy-record.mjs'


def run(*args, cwd, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        raise AssertionError(f'{args}: {result.stderr}')
    return result.stdout.strip()


class RecordContractTests(unittest.TestCase):
    def test_three_attempt_record_and_latest_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / 'repo'
            repo.mkdir()
            run('git', 'init', '-q', cwd=repo)
            run('git', 'config', 'user.name', 'Test', cwd=repo)
            run('git', 'config', 'user.email', 'test@example.invalid', cwd=repo)
            for relative, source in [
                ('experiments/inbox-production-install/perf/record.py', HERE / 'record.py'),
                ('scripts/inbox-ci/burst.sh', ROOT / 'scripts/inbox-ci/burst.sh'),
                ('e2e/inbox-acceptance/fault-proxy.mjs', ROOT / 'e2e/inbox-acceptance/fault-proxy.mjs'),
                ('.github/workflows/inbox-heavy-verification.yml', ROOT / '.github/workflows/inbox-heavy-verification.yml'),
            ]:
                target = repo / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            run('git', 'add', '.', cwd=repo)
            run('git', 'commit', '-qm', 'candidate', cwd=repo)
            sha = run('git', 'rev-parse', 'HEAD', cwd=repo)
            source = Path(temp) / 'source'
            source.mkdir()
            env = {**os.environ, 'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                   'GITHUB_REF_NAME': 'main', 'GITHUB_WORKFLOW_REF': 'biginkc/sandra/.github/workflows/inbox-heavy-verification.yml@refs/heads/main',
                   'HEAVY_TESTED_SHA': sha, 'HEAVY_LANE': 'burst', 'GITHUB_RUN_ATTEMPT': '1'}

            (source / 'oversize.csv').write_bytes(os.urandom(41 * 1024 * 1024))
            oversized = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                        str(source), 'burst', 'PASS'], cwd=repo, env={**env, 'GITHUB_RUN_ID': '999'},
                                       text=True, capture_output=True)
            self.assertNotEqual(oversized.returncode, 0)
            self.assertIn('40 MiB', oversized.stderr)
            print('NEGATIVE CONTROL oversized raw run: 40 MiB cap refusal')
            shutil.rmtree(repo / 'docs')
            (source / 'oversize.csv').unlink()

            def produce(run_id, verdicts, workrepo=repo):
                for n, verdict in enumerate(verdicts, 1):
                    attempt = source / f'attempt-{n}'
                    attempt.mkdir(parents=True, exist_ok=True)
                    (attempt / 'verdict.txt').write_text(verdict + '\n')
                    (attempt / 'runner-hardware.txt').write_text('4 CPU, 16 GB\n')
                    (attempt / 'raw.csv').write_text('x,y\n1,2\n')
                local_env = {**env, 'GITHUB_RUN_ID': run_id}
                verdict = 'PASS' if all(v == 'PASS' for v in verdicts) else 'FAIL'
                relative = run('python3', 'experiments/inbox-production-install/perf/record.py', str(source), 'burst', verdict,
                               cwd=workrepo, env=local_env)
                manifest = json.loads((workrepo / relative / 'manifest.json').read_text())
                artifact = {'name': manifest['artifact_name'], 'expired': False, 'size_in_bytes': 1}
                workflow_run = {'event': 'workflow_dispatch', 'head_branch': 'main',
                                'path': '.github/workflows/inbox-heavy-verification.yml', 'conclusion': 'success',
                                'head_sha': sha, 'run_attempt': 1, 'id': int(run_id),
                                'display_title': f'Inbox heavy burst {sha}'}
                downloaded = Path(temp) / 'download'
                if downloaded.exists():
                    shutil.rmtree(downloaded)
                shutil.copytree(workrepo / 'docs', downloaded / 'docs')
                script = f"import {{verifyDownload}} from {json.dumps(PULL.as_uri())}; verifyDownload(process.argv[1], process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4]), process.argv[5]);"
                pull = subprocess.run(['node', '--input-type=module', '-e', script, str(workrepo), str(downloaded),
                                       json.dumps(workflow_run), json.dumps(artifact), sha], cwd=workrepo, text=True, capture_output=True)
                run('git', 'add', 'docs', cwd=workrepo)
                run('git', 'commit', '-qm', f'seal {run_id}', cwd=workrepo)
                return manifest, pull, relative

            manifest, pull, _ = produce('1001', ['PASS'] * 3)
            self.assertEqual(pull.returncode, 0, pull.stderr)
            self.assertEqual(manifest['attempts'], ['PASS'] * 3)
            self.assertEqual(gate.evaluate(repo, sha, 'pre-merge')['status'], 'PASS')

            failure_repo = Path(temp) / 'failure'
            run('git', 'worktree', 'add', '--detach', str(failure_repo), sha, cwd=repo)
            failed, rejected, failure_path = produce('1002', ['PASS', 'FAIL', 'PASS'], failure_repo)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('Manifest identity or verdict mismatch', rejected.stderr)
            self.assertEqual(failed['exit_status'], 1)
            shutil.copytree(failure_repo / failure_path, repo / failure_path)
            run('git', 'add', 'docs', cwd=repo)
            run('git', 'commit', '-qm', 'seal failed attempt', cwd=repo)
            with self.assertRaisesRegex(gate.EvidenceError, 'latest required check failed') as caught:
                gate.evaluate(repo, sha, 'pre-merge')
            print(f'NEGATIVE CONTROL failing attempt: {caught.exception}')


if __name__ == '__main__':
    unittest.main()
