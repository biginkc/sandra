#!/usr/bin/env python3
"""Prove the release compose env resolves and both worker entrypoints start.

The child processes use the workers' explicit routing-test mode, so this test
does not open a database, invoke Restate, contact a provider, or mutate a
fixture. The compose CLI still performs the real env-file interpolation.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent
COMPOSE = HERE / "execution-stack-compose.yml"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def status(url: str) -> int:
    try:
        with urlopen(url, timeout=0.5) as response:
            return response.status
    except HTTPError as exc:
        return exc.code
    except URLError:
        return None


def compose_command() -> list[str] | None:
    docker = shutil.which("docker")
    if docker:
        probe = subprocess.run([docker, "compose", "version"], capture_output=True, text=True, check=False)
        if probe.returncode == 0:
            return [docker, "compose"]
    legacy = shutil.which("docker-compose")
    return [legacy] if legacy else None


class ExecutionStackComposeTests(unittest.TestCase):
    def test_compose_env_loads_and_both_workers_start_with_versioned_paths(self) -> None:
        compose = compose_command()
        node = shutil.which("node")
        if node is None:
            self.fail("node is required for the compose worker-start proof")
        with tempfile.TemporaryDirectory(prefix="sandra-inbox-compose-test-") as temp:
            root = Path(temp)
            key = root / "restate-key.pem"
            key.write_text("fixture-key\n")
            runtime_env = root / "runtime.env"
            runtime_env.write_text("INBOX_RESTATE_IDENTITY_KEYS=[]\n")
            projection_env = root / "projection.env"
            projection_env.write_text("INBOX_PROJECTION_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:54322/postgres\n")
            generation_a = "a" * 64
            generation_b = "b" * 64
            compose_env = root / "compose.env"
            compose_env.write_text(
                "\n".join(
                    [
                        f"INBOX_RESTATE_PRIVATE_KEY_FILE={key}",
                        "INBOX_ELECTRIC_DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:54322/postgres",
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
                operation_env = resolved["services"]["operation-worker"]["environment"]
                reply_env = resolved["services"]["reply-send-worker"]["environment"]
            else:
                # Some developer machines have Docker Engine without Compose.
                # Check the same required interpolation explicitly, then use
                # those resolved values for the process-level start proof.
                source = COMPOSE.read_text()
                operation_marker = "${INBOX_RELEASE_OPERATION_REGISTRATION_PATH:?"
                reply_marker = "${INBOX_RELEASE_REPLY_REGISTRATION_PATH:?"
                self.assertIn(operation_marker, source)
                self.assertIn(reply_marker, source)
                operation_env = {"INBOX_RESTATE_REGISTRATION_PATH": f"/runtime/{generation_a}"}
                reply_env = {"INBOX_RESTATE_REGISTRATION_PATH": f"/runtime/{generation_b}"}
            self.assertEqual(operation_env["INBOX_RESTATE_REGISTRATION_PATH"], f"/runtime/{generation_a}")
            self.assertEqual(reply_env["INBOX_RESTATE_REGISTRATION_PATH"], f"/runtime/{generation_b}")

            children = []
            try:
                for worker, worker_env, default_port in (
                    ("operation", operation_env, 9080),
                    ("reply", reply_env, 9081),
                ):
                    port = free_port() or default_port
                    env = {**os.environ, **{str(k): str(v) for k, v in worker_env.items() if v is not None}}
                    env.update({"INBOX_WORKER_ROUTING_TEST": "1", "PORT": str(port), "INBOX_WORKER_BIND": "127.0.0.1", "LC_ALL": "C"})
                    process = subprocess.Popen([node, str(HERE.parent / ("inbox-operation-worker" if worker == "operation" else "inbox-reply-send-worker") / "server.mjs")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    children.append((worker, process, port))
                deadline = time.monotonic() + 5
                for worker, process, port in children:
                    while time.monotonic() < deadline and process.poll() is None:
                        if status(f"http://127.0.0.1:{port}/livez") == 200:
                            break
                        time.sleep(0.05)
                    self.assertIsNone(process.poll(), f"{worker} worker exited before startup")
                    self.assertEqual(status(f"http://127.0.0.1:{port}/livez"), 200, worker)
            finally:
                for _worker, process, _port in children:
                    if process.poll() is None:
                        process.terminate()
                for _worker, process, _port in children:
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
