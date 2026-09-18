#!/usr/bin/env python3
"""Register the two reviewed worker endpoints with the owned Restate node.

The default mode is read-only inspection.  Registration requires both the
explicit ``--register-owned-runtime`` flag and
``INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1``.  Every inspected container must
carry the release marker and exact pinned image; this helper never starts,
stops, pulls, or removes a container and never prints credentials.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MARKER = "sandra-inbox-release-http-owned-20260917"
PURPOSE = "sandra-inbox-release-runtime"
RESTATE_NAME = "sandra-inbox-release-restate-20260917"
WORKERS = {
    "operation": {
        "name": "sandra-inbox-release-operation-worker-20260917",
        "endpoint": "http://127.0.0.1:9080",
        "enabled": "INBOX_ACTION_WORKER_ENABLED=1",
    },
    "reply": {
        "name": "sandra-inbox-release-reply-worker-20260917",
        "endpoint": "http://127.0.0.1:9081",
        "enabled": "INBOX_REPLY_SEND_WORKER_ENABLED=1",
    },
}
RESTATE_IMAGE = (
    "docker.restate.dev/restatedev/restate@sha256:"
    "675b85e7bf674f9dfda04a391fa33e850650d57e464b694ca8df5866acad95cc"
)


class GuardError(RuntimeError):
    pass


def docker_base() -> list[str]:
    host = os.environ.get("INBOX_RELEASE_DOCKER_HOST", "")
    if not host:
        raise GuardError("INBOX_RELEASE_DOCKER_HOST must name the explicitly owned daemon")
    return ["docker", "--host", host]


def docker(*args: str) -> str:
    try:
        result = subprocess.run(
            [*docker_base(), *args],
            text=True,
            capture_output=True,
            check=False,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GuardError(f"owned Docker inspection unavailable: {exc}") from exc
    if result.returncode:
        raise GuardError(f"owned Docker inspection failed: {result.stderr[-600:]}")
    return result.stdout.strip()


def inspect(name: str) -> dict:
    try:
        value = json.loads(docker("inspect", name))
    except (json.JSONDecodeError, GuardError) as exc:
        raise GuardError(f"cannot inspect required owned container {name}: {exc}") from exc
    if len(value) != 1:
        raise GuardError(f"container inspection returned an unexpected count for {name}")
    return value[0]


def require_release_container(name: str, *, image: str | None = None) -> dict:
    state = inspect(name)
    labels = state.get("Config", {}).get("Labels") or {}
    if labels.get("purpose") != PURPOSE or labels.get("owner") != "release-infra" or labels.get("marker") != MARKER:
        raise GuardError(f"container {name} has the wrong release ownership labels")
    if state.get("State", {}).get("Running") is not True:
        raise GuardError(f"container {name} is not running")
    if image is not None and state.get("Config", {}).get("Image") != image:
        raise GuardError(f"container {name} is not the pinned release image")
    if state.get("HostConfig", {}).get("NetworkMode") != "host":
        raise GuardError(f"container {name} must use the reviewed host network")
    return state


def environment_values(state: dict) -> set[str]:
    return set(state.get("Config", {}).get("Env") or [])


def check_worker(name: str, expected: dict) -> dict:
    state = require_release_container(name)
    env = environment_values(state)
    if expected["enabled"] not in env:
        raise GuardError(f"worker {name} is not explicitly enabled")
    # The local profile must use the provider double.  A real provider key is
    # deliberately not accepted by this release-only registration helper.
    if "INBOX_ACTION_LOCAL_FIXTURE=1" not in env:
        raise GuardError(f"worker {name} is not in the fixture profile")
    return {"name": name, "endpoint": expected["endpoint"], "image": state["Config"].get("Image")}


def http_json(url: str, *, method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    headers = {"content-type": "application/json"} if body is not None else {}
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=10) as response:
            raw = response.read(2_000_000)
            return response.status, json.loads(raw or b"{}")
    except HTTPError as exc:
        raw = exc.read(2_000_000)
        try:
            detail = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            detail = {"body": "<non-json response>"}
        return exc.code, detail
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise GuardError(f"owned Restate admin request failed: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--register-owned-runtime", action="store_true")
    parser.add_argument("--write", type=Path, help="write redacted registration receipt")
    args = parser.parse_args()
    if args.register_owned_runtime and os.environ.get("INBOX_RELEASE_ALLOW_RUNTIME_MUTATION") != "1":
        raise GuardError("registration requires INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1")
    restate = require_release_container(RESTATE_NAME, image=RESTATE_IMAGE)
    workers = [check_worker(item["name"], item) for item in WORKERS.values()]
    status, health = http_json("http://127.0.0.1:9070/health")
    if status != 200:
        raise GuardError(f"owned Restate admin is not healthy: HTTP {status}")
    registrations = []
    for worker in workers:
        if args.register_owned_runtime:
            code, body = http_json(
                "http://127.0.0.1:9070/deployments",
                method="POST",
                payload={"uri": worker["endpoint"], "use_http_11": True},
            )
            if code not in {200, 201, 409}:
                raise GuardError(f"Restate registration failed for {worker['name']}: HTTP {code}")
            registrations.append({"endpoint": worker["endpoint"], "http_status": code})
        else:
            registrations.append({"endpoint": worker["endpoint"], "http_status": None})
    receipt = {
        "status": "REGISTERED" if args.register_owned_runtime else "READY_TO_REGISTER",
        "restate_container": restate["Name"].lstrip("/"),
        "restate_health_status": status,
        "worker_endpoints": registrations,
        "marker": MARKER,
        "credentials_logged": False,
        "limits": ["owned release HTTP fixture only", "no provider traffic", "no customer sends"],
    }
    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GuardError as exc:
        print(f"runtime registration blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
