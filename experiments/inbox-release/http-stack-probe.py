#!/usr/bin/env python3
"""Read-only probe for the isolated local Supabase HTTP fixture."""

from __future__ import annotations

import json
import http.client
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlencode, urlsplit
import urllib.error
import urllib.request


SOCKET = os.environ.get(
    "INBOX_T2_DOCKER_SOCKET",
    "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock",
)
BASE = os.environ.get("INBOX_HTTP_BASE_URL", "http://127.0.0.1:54321")
CONTAINER = "sandra-inbox-release-http-db-20260917"
GATEWAY = "sandra-inbox-release-http-kong-20260917"
REALTIME = "sandra-inbox-release-http-realtime-20260917"
PROJECTION = "sandra-inbox-release-projection-worker-20260917"
AUTH = "sandra-inbox-release-http-auth-20260917"
REST = "sandra-inbox-release-http-rest-20260917"
MARKER = "sandra-inbox-release-http-owned-20260917"
NETWORK = "sandra-inbox-release-http-20260917"
REALTIME_DIGEST = "sha256:3211f8ebd59edcd0aa772186f1c8249c82c6b1ae5565f40dedb7aa93e951fe37"
PROJECTION_DIGEST = "sha256:ddc0a18b7682fa4a4a2e6d33f30477bf7bb65a69f42667b68f0fe3a62d8694b9"
PROJECTION_IMAGE = "sandra-inbox-projection-worker:release-4850f8c"
ORG = os.environ.get("INBOX_HTTP_ORG_ID", "11111111-1111-4111-8111-111111111111")
ROOT = Path(__file__).resolve().parents[2]


def docker(*args: str) -> str:
    return subprocess.check_output(
        ["docker", "--host", SOCKET, *args], cwd=ROOT, text=True
    ).strip()


def request(path: str, *, method: str = "GET", body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    payload = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BASE + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def raw_status(path: str) -> int:
    req = urllib.request.Request(BASE + path, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def raw_url_status(url: str) -> int:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def realtime_websocket_status() -> int:
    """Perform the Phoenix WebSocket upgrade through the owned gateway.

    A successful HTTP health route does not prove subscriptions work. The
    gateway must preserve the Realtime ``/socket`` upstream prefix and return
    the WebSocket 101 upgrade response. The optional anon key is read from the
    environment and never included in evidence output.
    """
    target = urlsplit(BASE)
    if target.scheme != "http" or not target.hostname:
        raise RuntimeError("HTTP fixture WebSocket probe requires an http URL")
    query = {"vsn": "1.0.0"}
    anon_key = os.environ.get("INBOX_HTTP_ANON_KEY")
    if anon_key:
        query["apikey"] = anon_key
    connection = http.client.HTTPConnection(target.hostname, target.port or 80, timeout=10)
    try:
        connection.request(
            "GET",
            "/realtime/v1/websocket?" + urlencode(query),
            headers={
                "Connection": "Upgrade",
                "Upgrade": "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": secrets.token_urlsafe(16),
            },
        )
        response = connection.getresponse()
        response.read(256)
        return response.status
    finally:
        connection.close()


def main() -> int:
    inspect = json.loads(docker("inspect", CONTAINER))[0]
    labels = inspect.get("Config", {}).get("Labels", {})
    if labels.get("purpose") != "sandra-inbox-release-http" or labels.get("owner") != "release-infra" or labels.get("marker") != MARKER:
        raise RuntimeError("HTTP fixture ownership marker mismatch")
    if inspect.get("State", {}).get("Status") != "running":
        raise RuntimeError("HTTP fixture database is not running")
    if inspect.get("HostConfig", {}).get("Memory") != 805306368 or inspect.get("HostConfig", {}).get("NanoCpus") != 1000000000:
        raise RuntimeError("HTTP fixture database resource bound drift")
    bindings = inspect.get("HostConfig", {}).get("PortBindings", {}).get("5432/tcp", [])
    if bindings != [{"HostIp": "127.0.0.1", "HostPort": "54322"}]:
        raise RuntimeError(f"HTTP fixture database binding drift: {bindings!r}")
    gateway = json.loads(docker("inspect", GATEWAY))[0]
    gateway_labels = gateway.get("Config", {}).get("Labels", {})
    if gateway_labels.get("purpose") != "sandra-inbox-release-http" or gateway_labels.get("owner") != "release-infra" or gateway_labels.get("marker") != MARKER:
        raise RuntimeError("HTTP fixture gateway ownership marker mismatch")
    if gateway.get("State", {}).get("Status") != "running":
        raise RuntimeError("HTTP fixture gateway is not running")
    gateway_bindings = gateway.get("HostConfig", {}).get("PortBindings", {}).get("8000/tcp", [])
    if gateway_bindings != [{"HostIp": "127.0.0.1", "HostPort": "54321"}]:
        raise RuntimeError(f"HTTP fixture gateway binding drift: {gateway_bindings!r}")
    for name, memory, cpus, alias in ((AUTH, 268435456, 250000000, "auth"), (REST, 134217728, 250000000, "rest")):
        service = json.loads(docker("inspect", name))[0]
        service_labels = service.get("Config", {}).get("Labels", {})
        if service_labels.get("purpose") != "sandra-inbox-release-http" or service_labels.get("owner") != "release-infra" or service_labels.get("marker") != MARKER:
            raise RuntimeError(f"HTTP fixture service ownership marker mismatch: {name}")
        if service.get("State", {}).get("Status") != "running":
            raise RuntimeError(f"HTTP fixture service is not running: {name}")
        if service.get("HostConfig", {}).get("Memory") != memory or service.get("HostConfig", {}).get("NanoCpus") != cpus:
            raise RuntimeError(f"HTTP fixture service resource bound drift: {name}")
        networks = service.get("NetworkSettings", {}).get("Networks", {})
        if set(networks) != {NETWORK} or alias not in networks[NETWORK].get("Aliases", []):
            raise RuntimeError(f"HTTP fixture service network drift: {name}")
    realtime_raw = docker("inspect", REALTIME)
    realtime = json.loads(realtime_raw)[0]
    realtime_labels = realtime.get("Config", {}).get("Labels", {})
    if realtime_labels.get("purpose") != "sandra-inbox-release-http" or realtime_labels.get("owner") != "release-infra" or realtime_labels.get("marker") != MARKER:
        raise RuntimeError("HTTP fixture Realtime ownership marker mismatch")
    if realtime.get("State", {}).get("Status") != "running":
        raise RuntimeError("HTTP fixture Realtime is not running")
    if realtime.get("HostConfig", {}).get("NetworkMode") != NETWORK or set(realtime.get("NetworkSettings", {}).get("Networks", {})) != {NETWORK}:
        raise RuntimeError("HTTP fixture Realtime network drift")
    if realtime.get("HostConfig", {}).get("Memory") != 402653184 or realtime.get("HostConfig", {}).get("NanoCpus") != 500000000:
        raise RuntimeError("HTTP fixture Realtime resource bound drift")
    if realtime.get("HostConfig", {}).get("PortBindings"):
        raise RuntimeError("HTTP fixture Realtime must remain internal-only")
    image_ref = realtime.get("Config", {}).get("Image")
    image_inspect = json.loads(docker("image", "inspect", image_ref))[0]
    if not any(ref.endswith("@" + REALTIME_DIGEST) for ref in image_inspect.get("RepoDigests", [])):
        raise RuntimeError("HTTP fixture Realtime image digest drift")
    projection = json.loads(docker("inspect", PROJECTION))[0]
    projection_labels = projection.get("Config", {}).get("Labels", {})
    if projection_labels.get("purpose") != "sandra-inbox-release-runtime" or projection_labels.get("owner") != "release-infra" or projection_labels.get("marker") != MARKER or projection_labels.get("component") != "projection-worker":
        raise RuntimeError("HTTP fixture projection ownership marker mismatch")
    if projection.get("State", {}).get("Status") != "running":
        raise RuntimeError("HTTP fixture projection worker is not running")
    if projection.get("HostConfig", {}).get("NetworkMode") != "host" or projection.get("HostConfig", {}).get("PortBindings"):
        raise RuntimeError("HTTP fixture projection worker must use host loopback without published bindings")
    if projection.get("HostConfig", {}).get("Memory") != 268435456 or projection.get("HostConfig", {}).get("NanoCpus") != 250000000:
        raise RuntimeError("HTTP fixture projection resource bound drift")
    projection_image = projection.get("Config", {}).get("Image")
    if projection_image != PROJECTION_IMAGE:
        raise RuntimeError("HTTP fixture projection image tag drift")
    projection_image_inspect = json.loads(docker("image", "inspect", projection_image))[0]
    if projection_image_inspect.get("Id") != PROJECTION_DIGEST:
        raise RuntimeError("HTTP fixture projection image digest drift")
    identity = docker(
        "exec", CONTAINER, "psql", "-XqAt", "-U", "postgres", "-d", "postgres",
        "-c", "SELECT current_database()||'|'||(SELECT marker FROM install_fixture.identity)||'|'||(SELECT serving_enabled FROM inbox_control.rollout);",
    )
    expected = "postgres|sandra-inbox-http-owned-synthetic-20260917|true"
    if identity != expected:
        raise RuntimeError(f"HTTP fixture identity mismatch: {identity!r}")
    health, _ = request("/auth/v1/health")
    if health != 200:
        raise RuntimeError(f"Auth health failed: {health}")
    openapi, _ = request("/rest/v1/")
    if openapi != 200:
        raise RuntimeError(f"PostgREST probe failed: {openapi}")
    realtime_websocket = realtime_websocket_status()
    if realtime_websocket != 101:
        raise RuntimeError(
            "Realtime WebSocket upgrade failed: "
            f"expected 101 from /realtime/v1/websocket, got {realtime_websocket}"
        )
    projection_health_status = raw_url_status("http://127.0.0.1:59081/health")
    if projection_health_status != 200:
        raise RuntimeError(f"Projection worker health failed: {projection_health_status}")
    result: dict = {"status": "PASS", "identity": identity, "base_url": BASE, "binding": "api:54321<->db:54322", "auth": "healthy", "rest": "openapi", "realtime": "running", "realtime_websocket": 101, "projection": "healthy", "bounded_services": ["db", "auth", "rest", "realtime", "projection", "gateway"]}
    email = os.environ.get("INBOX_HTTP_USER_EMAIL")
    password = os.environ.get("INBOX_HTTP_USER_PASSWORD")
    if email and password:
        status, auth = request("/auth/v1/token?grant_type=password", method="POST", body={"email": email, "password": password})
        if status != 200 or not auth.get("access_token"):
            raise RuntimeError(f"synthetic auth login failed: {status}")
        token = auth["access_token"]
        status, authority = request("/rest/v1/rpc/inbox_authorize_sync", method="POST", body={"org_id": ORG}, token=token)
        if status != 200 or authority.get("org_id") != ORG:
            raise RuntimeError(f"authenticated authority RPC failed: {status}")
        status, counts = request("/rest/v1/rpc/inbox_counts_v2", method="POST", body={"org_id": ORG, "filter": {"view": "all"}}, token=token)
        if status != 200 or not isinstance(counts.get("counts"), dict):
            raise RuntimeError(f"authenticated counts RPC failed: {status}")
        result["authenticated_rpc"] = "PASS"
        result["synthetic_counts"] = counts["counts"]
    else:
        result["authenticated_rpc"] = "BLOCKED: credentials not supplied"
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
