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
from urllib.parse import urlsplit


MARKER = "sandra-inbox-release-http-owned-20260917"
PURPOSE = "sandra-inbox-release-runtime"
RESTATE_NAME = "sandra-inbox-release-restate-20260917"
WORKERS = {
    "operation": {
        "name": "sandra-inbox-release-operation-worker-20260917",
        "endpoint": "http://127.0.0.1:9080",
        "enabled": "INBOX_ACTION_WORKER_ENABLED=1",
        "image_id_env": "INBOX_RELEASE_OPERATION_IMAGE_ID",
        "service": "InboxMetadataOperation",
    },
    "reply": {
        "name": "sandra-inbox-release-reply-worker-20260917",
        "endpoint": "http://127.0.0.1:9081",
        "enabled": "INBOX_REPLY_SEND_WORKER_ENABLED=1",
        "image_id_env": "INBOX_RELEASE_REPLY_IMAGE_ID",
        "service": "InboxReplySend",
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


def assert_running_image(state: dict, image_id: str, name: str) -> None:
    # Config.Image is only the tag used to create the container and can move
    # after launch.  The top-level Image field is the immutable image ID
    # actually mounted into this running container.
    if state.get("Image") != image_id:
        raise GuardError(f"worker {name} does not match its immutable running image receipt")


def check_worker(name: str, expected: dict) -> dict:
    state = require_release_container(name)
    env = environment_values(state)
    image_id = os.environ.get(expected["image_id_env"], "")
    if not image_id.startswith("sha256:") or len(image_id) != len("sha256:") + 64:
        raise GuardError(f"{expected['image_id_env']} must contain the immutable built image ID")
    assert_running_image(state, image_id, name)
    if expected["enabled"] not in env:
        raise GuardError(f"worker {name} is not explicitly enabled")
    # The local profile must use the provider double.  A real provider key is
    # deliberately not accepted by this release-only registration helper.
    if "INBOX_ACTION_LOCAL_FIXTURE=1" not in env:
        raise GuardError(f"worker {name} is not in the fixture profile")
    if expected["service"] == "InboxReplySend":
        if "INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE=/app/vendor/test-transport.mjs" not in env:
            raise GuardError("reply worker is missing the exact fixture provider double")
        if any(value.startswith("SENDILLO_API_KEY=") for value in env):
            raise GuardError("reply worker must not carry a provider credential in the fixture profile")
    return {
        "name": name,
        "endpoint": expected["endpoint"],
        "image": state["Config"].get("Image"),
        "image_id": image_id,
        "service": expected["service"],
    }


def http_request(url: str, *, method: str = "GET", payload: dict | None = None, json_body: bool = True) -> tuple[int, object]:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    headers = {"content-type": "application/json"} if body is not None else {}
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=10) as response:
            raw = response.read(2_000_000)
            if not json_body:
                return response.status, None
            return response.status, json.loads(raw or b"{}")
    except HTTPError as exc:
        raw = exc.read(2_000_000)
        if not json_body:
            return exc.code, None
        try:
            detail = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            detail = {"body": "<non-json response>"}
        return exc.code, detail
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise GuardError(f"owned Restate admin request failed: {exc}") from exc


def http_json(url: str, *, method: str = "GET", payload: dict | None = None) -> tuple[int, dict]:
    status, body = http_request(url, method=method, payload=payload)
    if not isinstance(body, dict):
        raise GuardError(f"owned Restate admin returned a non-object JSON response: {url}")
    return status, body


def canonical_root_endpoint(value: object) -> tuple[str, str, int | None, str] | None:
    """Normalize only the optional slash on an HTTP service root.

    Restate's deployment registry returns service roots with a trailing slash
    even when registration accepted the slashless URI.  Host, explicit port,
    scheme, query, fragment, credentials, and every non-root path remain
    significant and are rejected from normalization.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() != "http" or parsed.username or parsed.password:
            return None
        if parsed.hostname is None or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
            return None
        port = parsed.port
    except ValueError:
        return None
    return (parsed.scheme.lower(), parsed.hostname.lower(), port, "/")


def deployment_uri_matches(actual: object, expected: str) -> bool:
    actual_root = canonical_root_endpoint(actual)
    expected_root = canonical_root_endpoint(expected)
    return actual_root is not None and actual_root == expected_root


def deployment_matches(registry: dict, endpoint: str, service: str) -> dict | None:
    deployments = registry.get("deployments")
    if not isinstance(deployments, list):
        raise GuardError("Restate deployment registry has no deployments list")
    for deployment in deployments:
        if not isinstance(deployment, dict) or not deployment_uri_matches(deployment.get("uri"), endpoint):
            continue
        if not deployment.get("id") or not isinstance(deployment.get("sdk_version"), str) or not deployment["sdk_version"]:
            raise GuardError(f"Restate deployment for {endpoint} has no immutable ID/SDK version")
        if deployment.get("http_version") not in {"1.1", "HTTP/1.1"}:
            raise GuardError(f"Restate deployment for {endpoint} is not HTTP/1.1")
        services = deployment.get("services")
        if not isinstance(services, list):
            raise GuardError(f"Restate deployment for {endpoint} has no service inventory")
        match = next((item for item in services if isinstance(item, dict) and item.get("name") == service), None)
        if not isinstance(match, dict) or not isinstance(match.get("revision"), int) or match["revision"] < 1:
            raise GuardError(f"Restate deployment for {endpoint} does not expose service {service} with a revision")
        return {"id": deployment["id"], "sdk_version": deployment["sdk_version"], "revision": match["revision"], "http_version": deployment["http_version"]}
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--register-owned-runtime", action="store_true")
    parser.add_argument("--write", type=Path, help="write redacted registration receipt")
    args = parser.parse_args()
    if args.register_owned_runtime and os.environ.get("INBOX_RELEASE_ALLOW_RUNTIME_MUTATION") != "1":
        raise GuardError("registration requires INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1")
    restate = require_release_container(RESTATE_NAME, image=RESTATE_IMAGE)
    workers = [check_worker(item["name"], item) for item in WORKERS.values()]
    status, _ = http_request("http://127.0.0.1:9070/health", json_body=False)
    if status != 200:
        raise GuardError(f"owned Restate admin is not healthy: HTTP {status}")
    registry_status, registry = http_json("http://127.0.0.1:9070/deployments")
    if registry_status != 200:
        raise GuardError(f"owned Restate deployment registry is unavailable: HTTP {registry_status}")
    registrations = []
    for worker in workers:
        current = deployment_matches(registry, worker["endpoint"], worker["service"])
        if current is not None:
            registrations.append({"endpoint": worker["endpoint"], "service": worker["service"], "state": "already_registered", **current})
            continue
        if args.register_owned_runtime:
            code, body = http_json(
                "http://127.0.0.1:9070/deployments",
                method="POST",
                payload={"uri": worker["endpoint"], "use_http_11": True},
            )
            if code not in {200, 201, 409}:
                raise GuardError(f"Restate registration failed for {worker['name']}: HTTP {code}")
            registry_status, registry = http_json("http://127.0.0.1:9070/deployments")
            if registry_status != 200:
                raise GuardError("Restate deployment registry could not be read after registration")
            verified = deployment_matches(registry, worker["endpoint"], worker["service"])
            if verified is None:
                raise GuardError(f"Restate registration did not expose {worker['service']} at {worker['endpoint']}")
            registrations.append({"endpoint": worker["endpoint"], "service": worker["service"], "state": "registered", "http_status": code, **verified})
        else:
            registrations.append({"endpoint": worker["endpoint"], "service": worker["service"], "state": "not_registered", "http_status": None})
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
