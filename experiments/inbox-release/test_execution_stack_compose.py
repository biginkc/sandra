#!/usr/bin/env python3
"""Prove the release compose env resolves and both worker seams start.

The proof imports the real worker configuration functions and request-handler
factories with injected endpoint dependencies. It does not open a database,
invoke Restate, contact a provider, or mutate a fixture.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
COMPOSE = HERE / "execution-stack-compose.yml"


def compose_command() -> list[str] | None:
    docker = shutil.which("docker")
    if docker:
        probe = subprocess.run([docker, "compose", "version"], capture_output=True, text=True, check=False)
        if probe.returncode == 0:
            return [docker, "compose"]
    legacy = shutil.which("docker-compose")
    return [legacy] if legacy else None


class ExecutionStackComposeTests(unittest.TestCase):
    def test_compose_pins_the_release_electric_stream_id(self) -> None:
        compose_source = COMPOSE.read_text()
        env_example = (HERE / "full-stack.env.example").read_text()
        self.assertIn("ELECTRIC_REPLICATION_STREAM_ID: inbox_release_20260917", compose_source)
        self.assertNotIn("ELECTRIC_REPLICATION_STREAM_ID: ${", compose_source)
        self.assertIn("ELECTRIC_REPLICATION_STREAM_ID=inbox_release_20260917", env_example)

    def test_compose_env_loads_and_both_workers_start_with_versioned_paths(self) -> None:
        compose = compose_command()
        node = shutil.which("node")
        if node is None:
            self.fail("node is required for the compose worker-start proof")
        candidate_image = next(
            service["image"]
            for service in json.loads((HERE.parent.parent / "deployment/inbox/candidate.json").read_text())["services"]
            if service["name"] == "inbox-electric"
        )
        with tempfile.TemporaryDirectory(prefix="sandra-inbox-compose-test-") as temp:
            root = Path(temp)
            key = root / "restate-key.pem"
            key.write_text("fixture-key\n")
            runtime_env = root / "runtime.env"
            runtime_env.write_text(
                "\n".join([
                    'INBOX_RESTATE_IDENTITY_KEYS=["publickeyv1_' + "A" * 43 + '"]',
                    "INBOX_ACTION_DATABASE_URL=postgres://inbox_action_worker:fixture@127.0.0.1:54322/postgres",
                    "INBOX_REPLY_SEND_DATABASE_URL=postgres://inbox_reply_send_worker:fixture@127.0.0.1:54322/postgres",
                    "",
                ])
            )
            projection_env = root / "projection.env"
            projection_env.write_text("INBOX_PROJECTION_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:54322/postgres\n")
            generation_a = "a" * 64
            generation_b = "b" * 64
            compose_env = root / "compose.env"
            compose_env.write_text(
                "\n".join(
                    [
                        f"INBOX_RESTATE_PRIVATE_KEY_FILE={key}",
                        f"INBOX_ELECTRIC_IMAGE={candidate_image}",
                        "INBOX_ELECTRIC_DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:54322/postgres",
                        "ELECTRIC_MANUAL_TABLE_PUBLISHING=true",
                        f"INBOX_RELEASE_RUNTIME_ENV_FILE={runtime_env}",
                        f"INBOX_RELEASE_PROJECTION_ENV_FILE={projection_env}",
                        "INBOX_RELAY_TOKEN=fixture-token-012345678901234567890123456789",
                        f"INBOX_RELEASE_OPERATION_REGISTRATION_PATH=/runtime/{generation_a}",
                        f"INBOX_RELEASE_REPLY_REGISTRATION_PATH=/runtime/{generation_b}",
                        "",
                    ]
                )
            )
            supplied = {
                line.split("=", 1)[0]: line.split("=", 1)[1]
                for line in compose_env.read_text().splitlines()
                if line and "=" in line
            }
            self.assertEqual(supplied["INBOX_RELEASE_OPERATION_REGISTRATION_PATH"], f"/runtime/{generation_a}")
            self.assertEqual(supplied["INBOX_RELEASE_REPLY_REGISTRATION_PATH"], f"/runtime/{generation_b}")
            resolved_services = None
            if compose is not None:
                result = subprocess.run(
                    [*compose, "--env-file", str(compose_env), "-f", str(COMPOSE), "--profile", "full-runtime", "config", "--format", "json"],
                    cwd=HERE.parent.parent,
                    capture_output=True,
                    text=True,
                    env={**os.environ, "LC_ALL": "C"},
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr[-2000:])
                resolved = json.loads(result.stdout)
                resolved_services = {
                    "electric": resolved["services"]["electric"]["image"],
                    "operation-worker": resolved["services"]["operation-worker"]["environment"],
                    "reply-send-worker": resolved["services"]["reply-send-worker"]["environment"],
                }

            proof = subprocess.run(
                [node, str(HERE / "worker-compose-proof.mjs")],
                input=json.dumps({
                    "compose_path": str(COMPOSE),
                    "supplied_env": supplied,
                    "resolved_services": resolved_services,
                }),
                capture_output=True,
                text=True,
                cwd=HERE.parent.parent,
                env={**os.environ, "LC_ALL": "C"},
                check=False,
            )
            self.assertEqual(proof.returncode, 0, proof.stderr[-4000:])
            if resolved_services is not None:
                self.assertEqual(resolved_services["electric"], candidate_image)
            self.assertIn('"configurationAccepted":true', proof.stdout)
            self.assertIn('"databaseAccepted":true', proof.stdout)
            self.assertIn('"routingAccepted":true', proof.stdout)


if __name__ == "__main__":
    unittest.main()
