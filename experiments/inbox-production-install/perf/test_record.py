"""Synthetic W3 records must satisfy W1's pull and sealed-evidence interfaces."""
import json
import csv
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import importlib.util
from analyze import analyze

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('sealed_evidence', ROOT / 'experiments/inbox-release/sealed_evidence.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
PULL = ROOT / 'scripts/ci/pull-heavy-record.mjs'


def write_burst_attempt(attempt, verdict='PASS'):
    attempt.mkdir(parents=True, exist_ok=True)
    (attempt / 'verdict.txt').write_text(verdict + '\n')
    (attempt / 'runner-hardware.txt').write_text('4 CPU, 16 GB\n')
    (attempt / 'lock-config-observed.txt').write_text('on\n10ms\n')
    (attempt / 'before.json').write_text(json.dumps({'before': {'deadlocks': 0}}))
    (attempt / 'burst-summary.json').write_text(json.dumps({'counts': {
        'scheduled': {'update': 10200, 'inbound': 2400},
        'completed': {'update': 10200, 'inbound': 2400},
        'failed': {'update': 0, 'inbound': 0},
        'worker': {'errors': 0, 'parent': 60, 'finish': 12000, 'parent_sources': 60}}, 'errors': []}))
    (attempt / 'final-db.json').write_text(json.dumps({'inbound': 2400, 'unknown': 240, 'total': 149400}))
    (attempt / 'pg-stat-statements.json').write_text(json.dumps([
        {'query': 'UPDATE public.messages SET status= $1', 'calls': 10200},
        {'query': 'INSERT INTO public.messages(id,org_id,conversation_id', 'calls': 2400}]))
    writer_distribution = {'update': {}, 'inbound': {}}
    with (attempt / 'client-latencies.csv').open('w', newline='') as stream:
        rows = csv.writer(stream)
        rows.writerow(('kind', 'scheduled_ms', 'started_ms', 'finished_ms', 'wall_ms', 'error', 'writer'))
        for index in range(10200):
            rows.writerow(('update', index, index, index + 1, 1, '', index % 16))
            writer = str(index % 16)
            writer_distribution['update'][writer] = writer_distribution['update'].get(writer, 0) + 1
        for second in range(120):
            offsets = (0, 25, 200, 225, 400, 425) + tuple(500 + i for i in range(14))
            for index, offset in enumerate(offsets):
                ms = second * 1000 + offset
                rows.writerow(('inbound', ms, ms, ms + 1, 1, '', index % 16))
                writer = str(index % 16)
                writer_distribution['inbound'][writer] = writer_distribution['inbound'].get(writer, 0) + 1
    with (attempt / 'backlog.csv').open('w', newline='') as stream:
        rows = csv.writer(stream)
        rows.writerow(('elapsed_s', 'dirty_pending', 'maintained_queue', 'parent_pending', 'deadlocks', 'xact_rollback', 'n_dead_tup'))
        for second in range(181):
            rows.writerow((second, int(second < 120), 0, 0, 0, 0, 0))
    (attempt / 'pg-server.log').write_text(
        ('duration: 1 ms execute <unnamed>: UPDATE public.messages SET status=\n' * 10200) +
        ('duration: 1 ms execute <unnamed>: INSERT INTO public.messages(id,org_id,conversation_id\n' * 2400) +
        'acquired ShareLock after 1 ms\n')
    (attempt / 'writer-distribution.json').write_text(json.dumps(writer_distribution))
    # The checked-in analyzer will generate this after the raw files are written.
    subprocess.run(['python3', str(HERE / 'analyze.py'), str(attempt)], capture_output=True, check=verdict == 'PASS')


def run(*args, cwd, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        raise AssertionError(f'{args}: {result.stderr}')
    return result.stdout.strip()


class RecordContractTests(unittest.TestCase):
    def test_raw_truncation_controls(self):
        with tempfile.TemporaryDirectory() as temp:
            attempt = Path(temp)
            write_burst_attempt(attempt)
            self.assertEqual(analyze(attempt)['verdict'], 'PASS')
            client = attempt / 'client-latencies.csv'
            backlog = attempt / 'backlog.csv'
            original_client = client.read_text()
            original_backlog = backlog.read_text()
            controls = {
                'missing_update_samples': (client, '\n'.join(row for row in original_client.splitlines() if not row.startswith('update,')) + '\n'),
                'missing_inbound_samples': (client, '\n'.join(row for row in original_client.splitlines() if not row.startswith('inbound,')) + '\n'),
                'truncated_backlog': (backlog, '\n'.join(original_backlog.splitlines()[:123]) + '\n'),
                'backlog_gap': (backlog, '\n'.join(row for row in original_backlog.splitlines() if not row.startswith(('90,', '91,', '92,'))) + '\n'),
                'missing_end_observation': (backlog, '\n'.join(original_backlog.splitlines()[:-1]) + '\n'),
            }
            for name, (path, changed) in controls.items():
                with self.subTest(name=name):
                    path.write_text(changed)
                    scored = analyze(attempt)
                    print(f'NEGATIVE CONTROL raw {name}: {scored["verdict"]} {scored["failures"]}')
                    self.assertEqual(scored['verdict'], 'FAIL')
                    path.write_text(original_client if path == client else original_backlog)

    def test_perf_120k_record_is_sealable_but_cannot_satisfy_burst(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / 'repo'
            repo.mkdir()
            run('git', 'init', '-q', cwd=repo)
            run('git', 'config', 'user.name', 'Test', cwd=repo)
            run('git', 'config', 'user.email', 'test@example.invalid', cwd=repo)
            for relative, source in [
                ('experiments/inbox-production-install/perf/record.py', HERE / 'record.py'),
                ('scripts/inbox-ci/perf-120k.sh', ROOT / 'scripts/inbox-ci/perf-120k.sh'),
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
            (source / 'analysis.json').write_text(json.dumps({'kind': 'perf-120k', 'verdict': 'PASS', 'thresholds': {'p95_ms': 5}, 'latencies': {'insert': {'p95_ms': 2}}, 'foundation_file_wall_upper_ms': 100, 'foundation_access_exclusive_messages_observed_ms': 75}) + '\n')
            env = {**os.environ, 'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                   'GITHUB_REF_NAME': 'main', 'GITHUB_WORKFLOW_REF': 'biginkc/sandra/.github/workflows/inbox-heavy-verification.yml@refs/heads/main',
                   'HEAVY_TESTED_SHA': sha, 'HEAVY_LANE': 'perf-120k', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_RUN_ID': '2001'}
            local = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py', str(source), 'perf-120k', 'PASS'],
                                   cwd=repo, env={**env, 'PERF_LOCAL_EXECUTION': '1'}, text=True, capture_output=True)
            self.assertNotEqual(local.returncode, 0, 'local mode sealed a record')
            self.assertFalse((repo / 'docs').exists())
            print(f'NEGATIVE CONTROL local record: {local.stderr.strip().splitlines()[-1]}')

            (source / 'pg-server.log').write_text('token=sb_secret_abcdefghijklmnopqrstuvwxyz123456\n')
            leaked = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py', str(source), 'perf-120k', 'PASS'],
                                    cwd=repo, env=env, text=True, capture_output=True)
            self.assertNotEqual(leaked.returncode, 0, 'secret-bearing log sealed a record')
            self.assertFalse((repo / 'docs').exists())
            print(f'NEGATIVE CONTROL residual secret: {leaked.stderr.strip().splitlines()[-1]}')
            (source / 'pg-server.log').write_text('bearer eyJabcdefghij.eyJpayload.signature\n')
            jwt_leaked = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py', str(source), 'perf-120k', 'PASS'],
                                        cwd=repo, env=env, text=True, capture_output=True)
            self.assertNotEqual(jwt_leaked.returncode, 0, 'JWT-bearing log sealed a record')
            self.assertFalse((repo / 'docs').exists())
            print(f'NEGATIVE CONTROL residual JWT: {jwt_leaked.stderr.strip().splitlines()[-1]}')
            (source / 'pg-server.log').unlink()
            relative = run('python3', 'experiments/inbox-production-install/perf/record.py', str(source), 'perf-120k', 'PASS', cwd=repo, env=env)
            manifest = json.loads((repo / relative / 'manifest.json').read_text())
            self.assertEqual((manifest['kind'], manifest['phase'], manifest['target']), ('perf-120k', 'n/a', 'disposable'))
            workflow_run = {'event': 'workflow_dispatch', 'head_branch': 'main', 'path': '.github/workflows/inbox-heavy-verification.yml', 'conclusion': 'success', 'head_sha': sha, 'run_attempt': 1, 'id': 2001, 'display_title': f'Inbox heavy perf-120k {sha}'}
            artifact = {'name': manifest['artifact_name'], 'expired': False, 'size_in_bytes': 1}
            downloaded = Path(temp) / 'download'
            shutil.copytree(repo / 'docs', downloaded / 'docs')
            script = f"import {{verifyDownload}} from {json.dumps(PULL.as_uri())}; verifyDownload(process.argv[1], process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4]), process.argv[5]);"
            pull = subprocess.run(['node', '--input-type=module', '-e', script, str(repo), str(downloaded), json.dumps(workflow_run), json.dumps(artifact), sha], cwd=repo, text=True, capture_output=True)
            self.assertEqual(pull.returncode, 0, pull.stderr)
            run('git', 'add', 'docs', cwd=repo)
            run('git', 'commit', '-qm', 'seal perf', cwd=repo)
            selected = gate.collect(repo, sha, 'HEAD')['selected']
            self.assertIn(('pre-merge', 'perf-120k', 'n/a', 'disposable'), selected)
            self.assertNotIn(('pre-merge', 'burst', 'n/a', 'disposable'), selected)
            with self.assertRaisesRegex(gate.EvidenceError, "migration-dry-run") as caught:
                gate.evaluate(repo, 'j5b', sha, sha)
            print(f'NEGATIVE CONTROL perf-120k cannot satisfy burst: {caught.exception}')

    def test_three_attempt_record_and_latest_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / 'repo'
            repo.mkdir()
            run('git', 'init', '-q', cwd=repo)
            run('git', 'config', 'user.name', 'Test', cwd=repo)
            run('git', 'config', 'user.email', 'test@example.invalid', cwd=repo)
            for relative, source in [
                ('experiments/inbox-production-install/perf/record.py', HERE / 'record.py'),
                ('experiments/inbox-production-install/perf/analyze.py', HERE / 'analyze.py'),
                ('experiments/inbox-production-install/perf/thresholds.json', HERE / 'thresholds.json'),
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
                   'HEAVY_TESTED_SHA': sha, 'HEAVY_LANE': 'burst', 'GITHUB_RUN_ATTEMPT': '1',
                   'PYTHONDONTWRITEBYTECODE': '1'}

            (source / 'oversize.csv').write_bytes(os.urandom(41 * 1024 * 1024))
            oversized = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                        str(source), 'burst', 'PASS'], cwd=repo, env={**env, 'GITHUB_RUN_ID': '999'},
                                       text=True, capture_output=True)
            self.assertNotEqual(oversized.returncode, 0)
            self.assertIn('40 MiB', oversized.stderr)
            print('NEGATIVE CONTROL oversized raw run: 40 MiB cap refusal')
            shutil.rmtree(repo / 'docs')
            (source / 'oversize.csv').unlink()

            only_one = source / 'attempt-1'
            only_one.mkdir()
            (only_one / 'verdict.txt').write_text('PASS\n')
            (only_one / 'runner-hardware.txt').write_text('local diagnostic\n')
            incomplete = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                         str(source), 'burst', 'PASS'], cwd=repo, env={**env, 'GITHUB_RUN_ID': '998'},
                                        text=True, capture_output=True)
            self.assertNotEqual(incomplete.returncode, 0)
            self.assertIn('Burst attempt 1 missing burst-summary.json', incomplete.stderr)
            print('NEGATIVE CONTROL one attempt cannot seal a PASS burst record')
            shutil.rmtree(repo / 'docs')

            for n in range(1, 4):
                write_burst_attempt(source / f'attempt-{n}')
            required = ('pg-server.log', 'pg-stat-statements.json', 'client-latencies.csv',
                        'backlog.csv', 'writer-distribution.json', 'final-db.json',
                        'lock-config-observed.txt', 'analysis.json')
            for name in required:
                with self.subTest(missing=name):
                    path = source / 'attempt-1' / name
                    saved = path.read_bytes()
                    path.unlink()
                    missing = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                              str(source), 'burst', 'PASS'], cwd=repo,
                                             env={**env, 'GITHUB_RUN_ID': '997'}, text=True, capture_output=True)
                    path.write_bytes(saved)
                    if (repo / 'docs').exists():
                        shutil.rmtree(repo / 'docs')
                    print(f'NEGATIVE CONTROL missing {name}: {missing.returncode} {missing.stderr.strip().splitlines()[-1] if missing.stderr.strip() else "sealed"}')
                    self.assertNotEqual(missing.returncode, 0, f'{name} deletion sealed a PASS')
            final_path = source / 'attempt-2' / 'final-db.json'
            good_final = final_path.read_bytes()
            final_path.write_text(json.dumps({'inbound': 0, 'unknown': 0, 'total': 0}))
            tampered = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                       str(source), 'burst', 'PASS'], cwd=repo,
                                      env={**env, 'GITHUB_RUN_ID': '996'}, text=True, capture_output=True)
            self.assertNotEqual(tampered.returncode, 0, 'PASS verdict over failing raw analysis sealed')
            print(f'NEGATIVE CONTROL verdict tamper: {tampered.stderr.strip().splitlines()[-1]}')
            final_path.write_bytes(good_final)
            if (repo / 'docs').exists():
                shutil.rmtree(repo / 'docs')

            def produce(run_id, verdicts, workrepo=repo, prepare=True):
                if prepare:
                    for n, verdict in enumerate(verdicts, 1):
                        attempt = source / f'attempt-{n}'
                        write_burst_attempt(attempt, verdict)
                        if verdict == 'FAIL':
                            (attempt / 'final-db.json').write_text(json.dumps({'inbound': 0, 'unknown': 0, 'total': 0}))
                            subprocess.run(['python3', str(HERE / 'analyze.py'), str(attempt)], capture_output=True, check=False)
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

            crash_repo = Path(temp) / 'crash'
            run('git', 'worktree', 'add', '--detach', str(crash_repo), sha, cwd=repo)
            (source / 'attempt-2' / 'fatal.json').write_text(json.dumps({'error': 'synthetic burst crash'}) + '\n')
            forged_complete = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                              str(source), 'burst', 'PASS'], cwd=crash_repo,
                                             env={**env, 'GITHUB_RUN_ID': '1004'}, text=True, capture_output=True)
            self.assertNotEqual(forged_complete.returncode, 0, 'complete PASS with fatal.json sealed')
            self.assertIn('PASS verdict conflicts with fatal.json', forged_complete.stderr)
            print(f'NEGATIVE CONTROL forged complete PASS crash: {forged_complete.stderr.strip().splitlines()[-1]}')
            (source / 'attempt-2' / 'fatal.json').unlink()
            shutil.rmtree(crash_repo / 'docs')

            crash_attempt = source / 'attempt-2'
            shutil.rmtree(crash_attempt)
            crash_attempt.mkdir()
            (crash_attempt / 'fatal.json').write_text(json.dumps({'error': 'synthetic burst crash'}) + '\n')
            forged = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                     str(source), 'burst', 'PASS'], cwd=crash_repo,
                                    env={**env, 'GITHUB_RUN_ID': '1003'}, text=True, capture_output=True)
            self.assertNotEqual(forged.returncode, 0, 'PASS aggregate over crash sealed')
            print(f'NEGATIVE CONTROL forged aggregate PASS crash: {forged.stderr.strip().splitlines()[-1]}')
            shutil.rmtree(crash_repo / 'docs')
            (crash_attempt / 'verdict.txt').write_text('PASS\n')
            forged_attempt = subprocess.run(['python3', 'experiments/inbox-production-install/perf/record.py',
                                             str(source), 'burst', 'FAIL'], cwd=crash_repo,
                                            env={**env, 'GITHUB_RUN_ID': '1003'}, text=True, capture_output=True)
            self.assertNotEqual(forged_attempt.returncode, 0, 'PASS attempt over crash sealed')
            print(f'NEGATIVE CONTROL forged attempt PASS crash: {forged_attempt.stderr.strip().splitlines()[-1]}')
            shutil.rmtree(crash_repo / 'docs')
            (crash_attempt / 'verdict.txt').unlink()
            crashed, pulled, crash_path = produce('1003', ['PASS', 'FAIL', 'PASS'], crash_repo, prepare=False)
            self.assertEqual(pulled.returncode, 0, pulled.stderr)
            self.assertEqual(crashed['attempts'], ['PASS', 'FAIL', 'PASS'])
            self.assertEqual(crashed['verdict'], 'FAIL')
            self.assertEqual(crashed['missing_artifacts']['attempt-2'], sorted(
                ('runner-hardware.txt', 'verdict.txt', 'burst-summary.json', 'before.json',
                 'pg-server.log', 'pg-stat-statements.json', 'client-latencies.csv',
                 'backlog.csv', 'writer-distribution.json', 'final-db.json',
                 'lock-config-observed.txt', 'analysis.json')))
            self.assertIn('attempt-2/fatal.json', crashed['artifacts'])
            shutil.copytree(crash_repo / crash_path, repo / crash_path)
            run('git', 'add', 'docs', cwd=repo)
            run('git', 'commit', '-qm', 'seal crashed attempt', cwd=repo)
            with self.assertRaisesRegex(gate.EvidenceError, 'latest required check failed') as crash_rejection:
                gate.evaluate(repo, sha, 'pre-merge')
            print(f'NEGATIVE CONTROL crashed attempt: {crash_rejection.exception}')

            (crash_attempt / 'fatal.json').unlink()
            (crash_attempt / 'verdict.txt').write_text('FAIL\n')
            partial_repo = Path(temp) / 'partial-fail'
            run('git', 'worktree', 'add', '--detach', str(partial_repo), sha, cwd=repo)
            partial, partial_pull, _ = produce('1005', ['PASS', 'FAIL', 'PASS'], partial_repo, prepare=False)
            self.assertEqual(partial_pull.returncode, 0, partial_pull.stderr)
            self.assertEqual(partial['attempts'], ['PASS', 'FAIL', 'PASS'])
            self.assertEqual(partial['missing_artifacts']['attempt-2'], sorted(
                name for name in crashed['missing_artifacts']['attempt-2'] if name != 'verdict.txt'))

            failure_repo = Path(temp) / 'failure'
            run('git', 'worktree', 'add', '--detach', str(failure_repo), sha, cwd=repo)
            failed, rejected, failure_path = produce('1002', ['PASS', 'FAIL', 'PASS'], failure_repo)
            self.assertEqual(rejected.returncode, 0, rejected.stderr)
            self.assertEqual(failed['exit_status'], 1)
            shutil.copytree(failure_repo / failure_path, repo / failure_path)
            run('git', 'add', 'docs', cwd=repo)
            run('git', 'commit', '-qm', 'seal failed attempt', cwd=repo)
            with self.assertRaisesRegex(gate.EvidenceError, 'latest required check failed') as caught:
                gate.evaluate(repo, sha, 'pre-merge')
            print(f'NEGATIVE CONTROL failing attempt: {caught.exception}')


if __name__ == '__main__':
    unittest.main()
