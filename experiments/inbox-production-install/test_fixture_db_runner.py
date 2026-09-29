import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

P = Path(__file__).with_name('fixture_db.py')


def load(env):
    spec = importlib.util.spec_from_file_location('fixture_db_for_test', P)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, env, clear=True):
        spec.loader.exec_module(module)
    return module


class ScratchFixtureTest(unittest.TestCase):
    def setUp(self):
        self.env = {
            'INBOX_SCRATCH_MODE': '1',
            'INBOX_SCRATCH_DOCKER_SOCKET': 'unix:///var/run/docker.sock',
            'INBOX_SCRATCH_CONTAINER': 'supabase_db_sandbox',
            'INBOX_SCRATCH_DATABASE': 'postgres',
            'INBOX_SCRATCH_MARKER_TOKEN': 'synthetic-marker',
            'GITHUB_ACTIONS': 'true',
        }

    def test_runner_target_and_marker(self):
        f = load(self.env)
        with patch.object(f.subprocess, 'check_output', return_value=json.dumps([{'State': {'Running': True}}])), patch.object(f, 'sql', return_value='synthetic-marker'):
            f.guard()
        for change in [
            {'INBOX_SCRATCH_CONTAINER': 'sandra-inbox-projection-t2-db'},
            {'INBOX_SCRATCH_CONTAINER': 'supabase_db_sandra'},
            {'INBOX_SCRATCH_DATABASE': 'sandra_inbox_install_20260913'},
            {'INBOX_SCRATCH_DOCKER_SOCKET': 'unix:///tmp/colima/docker.sock'},
        ]:
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                load({**self.env, **change})

    def test_missing_environment_fails(self):
        for key in ('INBOX_SCRATCH_DOCKER_SOCKET', 'INBOX_SCRATCH_CONTAINER', 'INBOX_SCRATCH_DATABASE', 'INBOX_SCRATCH_MARKER_TOKEN'):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'requires all'):
                load({k: v for k, v in self.env.items() if k != key})

    def test_marker_and_container_mutations_fail(self):
        f = load(self.env)
        for info, marker in [({'State': {'Running': False}}, 'synthetic-marker'), ({'State': {'Running': True}}, 'wrong-marker')]:
            with self.subTest(info=info, marker=marker), patch.object(f.subprocess, 'check_output', return_value=json.dumps([info])), patch.object(f, 'sql', return_value=marker), self.assertRaises(RuntimeError):
                f.guard()
        with patch.object(f.subprocess, 'check_output', return_value=json.dumps([{'State': {'Running': True}}])), patch.object(f, 'sql', side_effect=RuntimeError('relation missing')), self.assertRaisesRegex(RuntimeError, 'marker missing or unreadable'):
            f.guard()


if __name__ == '__main__':
    unittest.main()
