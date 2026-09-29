#!/usr/bin/env python3
"""Read-only J5b gate for a specific pending Production workflow run."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile

REPO = 'biginkc/sandra'
HERE = Path(__file__).resolve().parent
WORKFLOW = Path(__file__).resolve().parents[2] / '.github/workflows/db-migrate-prod.yml'


def decision(prod_id, expected_sha, prod, binding, upstream, jobs, waiting, run_workflow_bytes, main_workflow_bytes, expected_workflow_hash, protection):
    errors = []
    def require(ok, message):
        if not ok: errors.append(message)
    require(prod.get('id') == prod_id, 'Production run ID mismatch')
    require(prod.get('event') == 'workflow_run' and prod.get('status') == 'waiting', 'Production run is not waiting on workflow_run')
    require(binding is not None, 'Missing upstream-binding artifact')
    if binding:
        require(binding.get('run_id') == prod_id, 'Artifact own run ID mismatch')
        require(binding.get('run_attempt') == prod.get('run_attempt'), 'Artifact own attempt mismatch')
        for key, source in [('upstream_run_id','id'),('upstream_run_attempt','run_attempt'),('upstream_head_sha','head_sha'),('upstream_event','event'),('upstream_head_branch','head_branch'),('upstream_conclusion','conclusion')]:
            require(binding.get(key) == upstream.get(source), f'Artifact/upstream {key} mismatch')
        require(binding.get('upstream_event') == 'push', 'Upstream was not a push')
        require(binding.get('upstream_head_branch') == 'main', 'Upstream branch was not main')
        require(binding.get('upstream_conclusion') == 'success', 'Upstream did not succeed')
        require(binding.get('upstream_head_sha') == expected_sha, 'Upstream SHA differs from M')
    require(upstream.get('head_sha') == expected_sha, 'Independent upstream SHA differs from M')
    require(upstream.get('event') == 'push' and upstream.get('head_branch') == 'main' and upstream.get('conclusion') == 'success', 'Independent upstream trigger is ineligible')
    require(len(waiting) == 1 and waiting[0].get('id') == prod_id, 'Expected exactly one waiting Production run')
    waiting_jobs = [j for j in jobs if j.get('status') == 'waiting']
    bind = [j for j in jobs if j.get('name') == 'Bind upstream test run']
    require(len(bind) == 1 and bind[0].get('conclusion') == 'success', 'bind-upstream did not succeed')
    require(len(waiting_jobs) == 1 and waiting_jobs[0].get('name') == 'Apply migrations to prod', 'migrate-prod is not the only waiting job')
    require(hashlib.sha256(run_workflow_bytes).hexdigest() == expected_workflow_hash, 'Production run SHA workflow definition hash mismatch')
    require(hashlib.sha256(main_workflow_bytes).hexdigest() == expected_workflow_hash, 'origin/main workflow definition hash mismatch')
    require('ref: ${{ github.event.workflow_run.head_sha }}' in run_workflow_bytes.decode(), 'Workflow checkout is not pinned to upstream SHA')
    reviewers = protection.get('protection_rules', [])
    require(any(r.get('type') == 'required_reviewers' and r.get('reviewers') for r in reviewers), 'Production required reviewers missing')
    require(protection.get('can_admins_bypass') is False, 'Production admin bypass enabled')
    return errors


def api(path, binary=False):
    data = subprocess.check_output(['gh', 'api', f'repos/{REPO}/{path}'])
    return data if binary else json.loads(data)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('production_run_id', type=int)
    p.add_argument('expected_sha', help='tested main SHA M with sealed test-env record')
    args = p.parse_args()
    prod = api(f'actions/runs/{args.production_run_id}')
    artifacts = api(f'actions/runs/{args.production_run_id}/artifacts')['artifacts']
    matches = [a for a in artifacts if a['name'] == 'upstream-binding' and not a.get('expired')]
    binding = None
    if len(matches) == 1:
        archive = zipfile.ZipFile(io.BytesIO(api(f'actions/artifacts/{matches[0]["id"]}/zip', binary=True)))
        binding = json.loads(archive.read('upstream-binding.json'))
    upstream = {}
    if binding:
        upstream = api(f'actions/runs/{binding["upstream_run_id"]}/attempts/{binding["upstream_run_attempt"]}')
    jobs = api(f'actions/runs/{args.production_run_id}/jobs')['jobs']
    waiting_response = api('actions/workflows/db-migrate-prod.yml/runs?status=waiting&per_page=100')
    waiting = waiting_response['workflow_runs']
    run_contents = api(f'contents/.github/workflows/db-migrate-prod.yml?ref={prod["head_sha"]}')
    main_contents = api('contents/.github/workflows/db-migrate-prod.yml?ref=main')
    run_workflow = base64.b64decode(run_contents['content'])
    main_workflow = base64.b64decode(main_contents['content'])
    expected_hash = (HERE / 'prod-workflow-definition.sha256').read_text().strip()
    protection = api('environments/Production')
    errors = decision(args.production_run_id, args.expected_sha, prod, binding, upstream, jobs, waiting, run_workflow, main_workflow, expected_hash, protection)
    if waiting_response.get('total_count') != len(waiting):
        errors.append('Waiting Production run listing is incomplete')
    if errors:
        print('FAIL: ' + '; '.join(errors))
        raise SystemExit(1)
    print(f'PASS: Production run {args.production_run_id} bound to push at {args.expected_sha}; Production approval still requires the sealed test-env record')


if __name__ == '__main__':
    main()
