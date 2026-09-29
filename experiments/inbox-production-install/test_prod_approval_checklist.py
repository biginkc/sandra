import importlib.util
import copy
import io
import json
from pathlib import Path
import unittest
import zipfile

p = Path(__file__).with_name('prod-approval-checklist.py')
spec = importlib.util.spec_from_file_location('approval', p)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class ApprovalDecision(unittest.TestCase):
    def setUp(self):
        self.sha = 'a' * 40
        self.workflow = b'ref: ${{ github.event.workflow_run.head_sha }}\n'
        self.main_workflow = self.workflow
        self.digest = __import__('hashlib').sha256(self.workflow).hexdigest()
        self.prod = {'id': 7, 'event': 'workflow_run', 'status': 'waiting', 'run_attempt': 1}
        self.upstream = {'id': 5, 'run_attempt': 2, 'head_sha': self.sha, 'event': 'push', 'head_branch': 'main', 'conclusion': 'success'}
        self.binding = {'run_id': 7, 'run_attempt': 1, 'upstream_run_id': 5, **{'upstream_' + k: v for k, v in self.upstream.items() if k != 'id'}}
        self.jobs = [{'name': 'Bind upstream test run', 'conclusion': 'success', 'status': 'completed'}, {'name': 'Apply migrations to prod', 'status': 'waiting'}]
        self.waiting = [{'id': 7}]
        self.protection = {'can_admins_bypass': False, 'protection_rules': [{'type': 'required_reviewers', 'reviewers': [{'reviewer': {'login': 'biginkc'}}]}]}
    def check(self):
        return a.decision(7, self.sha, self.prod, self.binding, self.upstream, self.jobs, self.waiting, self.workflow, self.main_workflow, self.digest, self.protection)
    def test_valid(self): self.assertEqual(self.check(), [])
    def test_dispatch(self):
        self.upstream['event'] = self.binding['upstream_event'] = 'workflow_dispatch'
        self.assertTrue(self.check())
    def test_wrong_sha(self):
        self.upstream['head_sha'] = self.binding['upstream_head_sha'] = 'b' * 40
        self.assertTrue(self.check())
    def test_missing_artifact(self):
        self.binding = None
        self.assertTrue(self.check())
    def test_two_waiting(self):
        self.waiting.append({'id': 8})
        self.assertTrue(self.check())
    def test_run_sha_drift_fails(self):
        self.workflow += b'# altered\n'
        self.assertIn('Production run SHA workflow definition hash mismatch', self.check())
    def test_main_drift_fails(self):
        self.main_workflow += b'# altered\n'
        self.assertIn('origin/main workflow definition hash mismatch', self.check())


class HandAuthoredAcquisition(unittest.TestCase):
    """Hand-authored synthetic GitHub API fixture; not recorded from GitHub."""
    def setUp(self):
        self.synthetic = json.loads(Path(__file__).with_name('github-approval-api-fixture.json').read_text())
        self.fixture = copy.deepcopy(self.synthetic)

    def fetch(self, path, binary=False):
        run = self.fixture['production_run']
        if path == f'actions/runs/{run["id"]}/attempts/{run["run_attempt"]}/jobs?per_page=100':
            return self.fixture['attempt_jobs']
        if path == f'actions/runs/{run["id"]}/artifacts?per_page=100':
            return self.fixture['artifacts']
        if path == 'actions/artifacts/90/zip':
            blob = io.BytesIO()
            with zipfile.ZipFile(blob, 'w') as archive:
                archive.writestr('upstream-binding.json', json.dumps(self.fixture['binding']))
            return blob.getvalue()
        raise AssertionError(path)

    def acquire(self):
        return a.acquire_binding(self.fixture['production_run'], self.fetch)

    def test_only_correct_binding_passes(self):
        binding, jobs = self.acquire()
        self.assertEqual(binding, self.synthetic['binding'])
        self.assertEqual(len(jobs), 2)

    def test_full_rerun_rejects_earlier_artifact(self):
        self.fixture['production_run']['run_attempt'] = 2
        self.fixture['attempt_jobs']['jobs'][0]['run_attempt'] = 2
        self.fixture['attempt_jobs']['jobs'][0]['started_at'] = '2026-09-28T11:00:00Z'
        self.fixture['attempt_jobs']['jobs'][0]['completed_at'] = '2026-09-28T11:02:00Z'
        with self.assertRaisesRegex(ValueError, 'current-attempt bind job'):
            self.acquire()

    def test_bind_job_missing_run_attempt_fails(self):
        del self.fixture['attempt_jobs']['jobs'][0]['run_attempt']
        with self.assertRaisesRegex(ValueError, 'Bind job missing required run_attempt'):
            self.acquire()

    def test_migration_job_only_rerun_rejects_old_artifact(self):
        self.fixture['production_run']['run_attempt'] = 2
        self.fixture['attempt_jobs']['jobs'] = [self.fixture['attempt_jobs']['jobs'][1]]
        self.fixture['attempt_jobs']['total_count'] = 1
        with self.assertRaisesRegex(ValueError, 'bind-upstream job'):
            self.acquire()

    def test_upstream_rerun_rejected(self):
        binding, jobs = self.acquire()
        workflow = b'ref: ${{ github.event.workflow_run.head_sha }}\n'
        digest = __import__('hashlib').sha256(workflow).hexdigest()
        errors = a.decision(7, 'a' * 40, self.fixture['production_run'], binding,
                            self.fixture['upstream_attempt'], jobs, [{'id': 7}],
                            workflow, workflow, digest,
                            {'can_admins_bypass': False, 'protection_rules': [{'type': 'required_reviewers', 'reviewers': [1]}]},
                            {'id': 5, 'run_attempt': 3})
        self.assertIn('Upstream was rerun after binding', errors)

    def test_duplicate_artifacts_rejected(self):
        self.fixture['artifacts']['artifacts'].append(copy.deepcopy(self.fixture['artifacts']['artifacts'][0]))
        self.fixture['artifacts']['total_count'] = 2
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.acquire()

    def test_stale_artifact_rejected(self):
        self.fixture['artifacts']['artifacts'][0]['created_at'] = '2026-09-28T09:01:00Z'
        with self.assertRaisesRegex(ValueError, 'current-attempt bind job'):
            self.acquire()

    def test_missing_upload_rejected(self):
        self.fixture['artifacts'] = {'total_count': 0, 'artifacts': []}
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            self.acquire()

    def test_failed_upload_rejected(self):
        self.fixture['attempt_jobs']['jobs'][0]['conclusion'] = 'failure'
        with self.assertRaisesRegex(ValueError, 'did not succeed'):
            self.acquire()

    def test_foreign_run_id_rejected(self):
        self.fixture['binding']['run_id'] = 8
        with self.assertRaisesRegex(ValueError, 'payload run/attempt mismatch'):
            self.acquire()

if __name__ == '__main__': unittest.main()
