#!/usr/bin/env python3
"""Seal synthetic perf raw evidence for W1's evidence-only pull step."""
import datetime
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
source = Path(sys.argv[1])
lane = sys.argv[2]
if lane != 'burst':
    raise RuntimeError('Only burst is a sealed approval kind')
verdict = sys.argv[3]
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
run_id = f"{os.environ['GITHUB_RUN_ID']}_{os.environ['GITHUB_RUN_ATTEMPT']}_{lane}"
relative = Path('docs/performance/inbox-redesign/evidence') / sha / 'pre-merge' / run_id
dest = repo / relative
if dest.exists():
    raise RuntimeError('Run directory already exists')
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=repo, text=True).strip():
    raise RuntimeError('Dirty tree before perf sealing')
dest.mkdir(parents=True)
raw_inflated = {}
artifacts = {}
for file in sorted(source.rglob('*')):
    if not file.is_file():
        continue
    rel = file.relative_to(source)
    if rel.name == 'manifest.json' or any(part.startswith('.') for part in rel.parts):
        continue
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
attempts = [(source / f'attempt-{n}' / 'verdict.txt').read_text().strip() for n in range(1, 4)]
if (verdict == 'PASS') != all(value == 'PASS' for value in attempts):
    raise RuntimeError('Burst aggregate verdict disagrees with attempts')
script = repo / 'scripts/inbox-ci' / f'{lane}.sh'
manifest = {
    'tested_sha': sha, 'tier': 'pre-merge', 'kind': 'burst',
    'phase': 'n/a', 'target': 'disposable', 'run_id': run_id,
    'started_at': os.environ.get('PERF_STARTED_AT', now), 'completed_at': now,
    'runner_script_sha256': hashlib.sha256(script.read_bytes()).hexdigest(),
    'fault_proxy_script_sha256': hashlib.sha256((repo / 'e2e/inbox-acceptance/fault-proxy.mjs').read_bytes()).hexdigest(),
    'github_run_id': os.environ['GITHUB_RUN_ID'], 'github_run_attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
    'clean_tree': {'start': True, 'end_excluding_run_dir': True, 'excluded_path': str(relative)},
    'exit_status': 0 if verdict == 'PASS' else 1, 'verdict': verdict,
    'raw_inflated_sha256': raw_inflated, 'artifacts': artifacts,
    'attempts': attempts,
    'summary': 'Three synthetic disposable PostgreSQL attempts with runner hardware recorded per attempt. No production equivalence is claimed.'
}
(dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
other = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=repo, text=True).splitlines()
if any(not line[3:].startswith(str(relative) + '/') for line in other):
    raise RuntimeError('Non-record tree change after perf run')
print(relative)
