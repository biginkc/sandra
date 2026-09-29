#!/usr/bin/env python3
"""Seal synthetic perf raw evidence for W1's evidence-only pull step."""
import datetime
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
if 'PERF_LOCAL_EXECUTION' in os.environ:
    raise RuntimeError('Local perf execution cannot seal an approval record')
source = Path(sys.argv[1])
lane = sys.argv[2]
if lane not in ('burst', 'perf-120k'):
    raise RuntimeError('Unknown perf lane')
verdict = sys.argv[3]
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch' or os.environ.get('GITHUB_REF_NAME') != 'main':
    raise RuntimeError('Perf record requires a main-branch workflow dispatch')
if os.environ.get('HEAVY_TESTED_SHA') != sha or os.environ.get('HEAVY_LANE') != lane:
    raise RuntimeError('Perf record checkout/lane mismatch')
workflow = '.github/workflows/inbox-heavy-verification.yml'
if os.environ.get('GITHUB_WORKFLOW_REF', '').split('@')[0] != f'biginkc/sandra/{workflow}':
    raise RuntimeError('Perf record workflow mismatch')
if not os.environ.get('GITHUB_RUN_ID', '').isdigit() or not os.environ.get('GITHUB_RUN_ATTEMPT', '').isdigit():
    raise RuntimeError('Perf record run identity missing')
run_id = os.environ['GITHUB_RUN_ID']
relative = Path('docs/performance/inbox-redesign/evidence') / sha / 'pre-merge' / run_id
dest = repo / relative
if dest.exists():
    raise RuntimeError('Run directory already exists')
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip():
    raise RuntimeError('Dirty tree before perf sealing')
text_artifact = re.compile(r'\.(?:json|log|txt|html|csv)$', re.I)
residual_secret = re.compile(rb'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+')
files = [file for file in sorted(source.rglob('*')) if file.is_file()
         and file.name != 'manifest.json' and not any(part.startswith('.') for part in file.relative_to(source).parts)]
for file in files:
    if text_artifact.search(file.name) and residual_secret.search(file.read_bytes()):
        raise RuntimeError(f'Residual secret in run artifact: {file.relative_to(source)}')
dest.mkdir(parents=True)
raw_inflated = {}
artifacts = {}
for file in files:
    rel = file.relative_to(source)
    target = dest / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    data = file.read_bytes()
    if len(data) > 1024 * 1024:
        target = target.with_name(target.name + '.gz')
        with target.open('wb') as stream:
            with gzip.GzipFile(filename='', mode='wb', fileobj=stream, compresslevel=9, mtime=0) as out:
                out.write(data)
        raw_inflated[str(rel)] = hashlib.sha256(data).hexdigest()
    else:
        shutil.copyfile(file, target)
    artifacts[str(target.relative_to(dest))] = hashlib.sha256(target.read_bytes()).hexdigest()
size = sum(f.stat().st_size for f in dest.rglob('*') if f.is_file())
if size > 40 * 1024 * 1024:
    raise RuntimeError(f'Perf run exceeds 40 MiB ({size} bytes)')
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
attempts = []
if lane == 'burst':
    from analyze import analyze
    required = ('runner-hardware.txt', 'verdict.txt', 'burst-summary.json', 'before.json',
                'pg-server.log', 'pg-stat-statements.json', 'client-latencies.csv',
                'backlog.csv', 'writer-distribution.json', 'final-db.json',
                'lock-config-observed.txt', 'analysis.json')
    for n in range(1, 4):
        attempt = source / f'attempt-{n}'
        for name in required:
            if not (attempt / name).is_file():
                raise RuntimeError(f'Burst attempt {n} missing {name}')
        claimed = (attempt / 'verdict.txt').read_text().strip()
        if claimed not in ('PASS', 'FAIL'):
            raise RuntimeError(f'Burst attempt {n} verdict missing or invalid')
        recomputed = analyze(attempt)
        recorded = json.loads((attempt / 'analysis.json').read_text())
        if recorded != recomputed or claimed != recomputed['verdict']:
            raise RuntimeError(f'Burst attempt {n} analysis/verdict mismatch')
        attempts.append(claimed)
    if (verdict == 'PASS') != all(value == 'PASS' for value in attempts):
        raise RuntimeError('Burst aggregate verdict disagrees with attempts')
else:
    analysis = json.loads((source / 'analysis.json').read_text())
    if analysis.get('kind') != lane or analysis.get('verdict') != verdict or not all(k in analysis for k in ('thresholds', 'latencies', 'foundation_file_wall_upper_ms', 'foundation_access_exclusive_messages_observed_ms')):
        raise RuntimeError('120k analysis/verdict mismatch')
script = repo / 'scripts/inbox-ci' / f'{lane}.sh'
manifest = {
    'tested_sha': sha, 'tier': 'pre-merge', 'kind': lane,
    'phase': 'n/a', 'target': 'disposable', 'run_id': run_id,
    'started_at': os.environ.get('PERF_STARTED_AT', now), 'completed_at': now,
    'runner_script_sha256': hashlib.sha256(script.read_bytes()).hexdigest(),
    'github_run_id': os.environ['GITHUB_RUN_ID'], 'github_run_attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
    'workflow_path': workflow, 'workflow_input_sha': sha,
    'event': os.environ['GITHUB_EVENT_NAME'], 'head_branch': os.environ['GITHUB_REF_NAME'], 'lane': lane,
    'artifact_name': f"heavy-{lane}-{sha}-{os.environ['GITHUB_RUN_ID']}-{os.environ['GITHUB_RUN_ATTEMPT']}",
    'clean_tree': {'start': True, 'end_excluding_run_dir': True, 'excluded_path': str(relative)},
    'exit_status': 0 if verdict == 'PASS' else 1, 'verdict': verdict,
    'raw_inflated_sha256': raw_inflated, 'artifacts': artifacts,
    'summary': ('Three synthetic disposable PostgreSQL attempts with runner hardware recorded per attempt. No production equivalence is claimed.'
                if lane == 'burst' else {'thresholds': analysis['thresholds'], 'latencies': analysis['latencies'],
                                         'foundation_file_wall_upper_ms': analysis['foundation_file_wall_upper_ms'],
                                         'foundation_access_exclusive_messages_observed_ms': analysis['foundation_access_exclusive_messages_observed_ms'],
                                         'informational': True, 'production_equivalence': False})
}
if lane == 'burst':
    manifest['attempts'] = attempts
(dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
other = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo, text=True).splitlines()
if any(not line[3:].startswith(str(relative) + '/') for line in other):
    raise RuntimeError('Non-record tree change after perf run')
print(relative)
