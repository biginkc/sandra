"""Execute both outbox lanes with stubbed commands and inspect runner routing."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SHA = "a" * 40


class LaneRoutingTests(unittest.TestCase):
    def run_lane(self, phase, remove_proxy_exports=False):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            commands = {
                "git": f'#!/bin/sh\ncase "$1" in status) exit 0;; rev-parse) echo {SHA};; esac\n',
                "uname": '#!/bin/sh\necho Linux\n',
                "google-chrome": '#!/bin/sh\nexit 0\n',
                "node": '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if sys.argv[1] == 'scripts/ci/provision-disposable-stack.mjs':
    Path(os.environ['GITHUB_ENV']).write_text('E2E_DISPOSABLE_DATABASE=1\\nTEST_SUPABASE_URL=http://127.0.0.1:55421\\nE2E_CI_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres\\n')
    Path(os.environ['PROVISION_ARGS']).write_text(' '.join(sys.argv[2:]))
elif sys.argv[1] == 'scripts/outbox-run-record.mjs':
    values = {key: os.environ.get(key) for key in ('TEST_SUPABASE_URL', 'E2E_CI_SUPABASE_DB_URL', 'HEAVY_PHASE')}
    if values['TEST_SUPABASE_URL'] != 'http://127.0.0.1:54321' or values['E2E_CI_SUPABASE_DB_URL'] != 'postgresql://postgres:postgres@127.0.0.1:54322/postgres':
        sys.exit('runner bypassed fault proxy')
    Path(os.environ['RUNNER_ENV']).write_text(json.dumps(values))
else:
    sys.exit('unexpected node call')
''',
            }
            for name, source in commands.items():
                stub = directory / name
                stub.write_text(source)
                stub.chmod(0o755)
            source = (HERE / f"outbox-{phase}.sh").read_text()
            if remove_proxy_exports:
                source = "\n".join(line for line in source.splitlines() if not line.startswith(("export TEST_SUPABASE_URL=", "export E2E_CI_SUPABASE_DB_URL="))) + "\n"
            lane = directory / "lane.sh"
            lane.write_text(source)
            (directory / "failure-exit.sh").write_text((HERE / "failure-exit.sh").read_text())
            env = dict(os.environ, PATH=f"{directory}:{os.environ['PATH']}", HEAVY_LANE=f"outbox-{phase}", CI="", HEAVY_TESTED_SHA=SHA, GITHUB_RUN_ID="123", GITHUB_ENV=str(directory / "github-env"), PROVISION_ARGS=str(directory / "provision-args"), RUNNER_ENV=str(directory / "runner-env"))
            env.pop("E2E_DISPOSABLE_DATABASE", None)
            result = subprocess.run(["bash", str(lane)], cwd=ROOT, env=env, text=True, capture_output=True)
            args = (directory / "provision-args").read_text() if (directory / "provision-args").exists() else ""
            received = json.loads((directory / "runner-env").read_text()) if (directory / "runner-env").exists() else None
            return result, args, received

    def test_both_lanes_route_runner_through_fault_proxy(self):
        for phase in ("pre", "post"):
            with self.subTest(phase=phase):
                result, args, received = self.run_lane(phase)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(received, {"TEST_SUPABASE_URL": "http://127.0.0.1:54321", "E2E_CI_SUPABASE_DB_URL": "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "HEAVY_PHASE": phase})
                self.assertIn("--api-port 55421 --db-port 55422", args)
                self.assertEqual("--exclude-migrations 2026093002*" in args, phase == "pre")
                broken, _, received = self.run_lane(phase, remove_proxy_exports=True)
                self.assertNotEqual(broken.returncode, 0)
                self.assertIn("runner bypassed fault proxy", broken.stderr)
                self.assertIsNone(received)


if __name__ == "__main__":
    unittest.main()
