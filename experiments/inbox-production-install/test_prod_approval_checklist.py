import importlib.util
from pathlib import Path
import unittest

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

if __name__ == '__main__': unittest.main()
