"""Explicitly owned T1 proof: built relay -> pinned Electric -> synthetic projection."""

import hashlib
import http.client
import json
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

P = Path(__file__).resolve().parent
import sys

sys.path.insert(0, str(P.parents[1] / "experiments/inbox-production-install"))
from electric_image_contract import CandidateError, EIMG_SOURCE_COMMIT, load_electric_pin


D = ["docker", "--host", "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock"]
FIXTURE_LABEL = "com.bmh.inbox-fixture=sandra-inbox-hosting-candidate-owned"
NETWORK = "sandra-inbox-stack-t1"
SANDRA_IMAGE_SOURCE_COMMIT = "bfef883408f09ef447aa048e25117ec502b926fb"
ELECTRIC_SOURCE_COMMIT = EIMG_SOURCE_COMMIT


def docker(*args):
    return subprocess.check_output(D + list(args), text=True).strip()


def need(value, label):
    if not value:
        raise RuntimeError(label)


def sql(query):
    return docker(
        "exec",
        "sandra-inbox-stack-db",
        "psql",
        "-U",
        "postgres",
        "-d",
        "sandra_inbox_t1",
        "-XqAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        query,
    )


def discover_owned(name):
    ids = docker("ps", "-aq", "--filter", f"name=^{name}$", "--filter", f"label={FIXTURE_LABEL}")
    key, value = FIXTURE_LABEL.split("=", 1)
    matches = []
    for container_id in ids.splitlines():
        state = json.loads(docker("inspect", container_id))[0]
        if state["Name"] == "/" + name and state["Config"].get("Labels", {}).get(key) == value:
            matches.append((container_id, state))
    need(len(matches) == 1, f"Expected one owned container {name}, found {len(matches)}")
    return matches[0]


need(
    sql("SELECT current_database()||'|'||marker FROM inbox_t1.fixture_identity")
    == "sandra_inbox_t1|sandra-inbox-stack-t1-owned-synthetic",
    "Wrong T1 database",
)
try:
    candidate = load_electric_pin(require_ready=True)
except CandidateError as exc:
    raise RuntimeError(str(exc)) from exc
electric_image = json.loads(docker("image", "inspect", candidate.image))[0]
need(candidate.repository_digest in electric_image.get("RepoDigests", []), "Electric image is not the pinned repository digest")
network = json.loads(docker("network", "inspect", NETWORK))[0]
need(network.get("Labels", {}).get("purpose") == "sandra-inbox-t1", "Wrong Electric network")
image = json.loads(docker("image", "inspect", "sandra-inbox-sync-relay:20260913"))[0]
need(image["Config"].get("Labels", {}).get("com.bmh.inbox-fixture") == "sandra-inbox-hosting-candidate-owned", "Wrong relay image owner")

suffix = uuid.uuid4().hex[:12]
schema = "inbox_relay_" + suffix
container = "sandra-inbox-relay-proof-" + suffix
electric_name = "sandra-inbox-relay-electric-" + suffix
o, c = str(uuid.uuid4()), str(uuid.uuid4())
token = secrets.token_urlsafe(40)
electric_secret = secrets.token_urlsafe(40)
cid = None
electric_id = None
result = None
stream = "relay_" + suffix
publication = "electric_publication_" + stream
slot = "electric_slot_" + stream

try:
    # Electric 1.8.1 derives these names from ELECTRIC_REPLICATION_STREAM_ID and creates both
    # artifacts during replication setup. See upstream commit 0f404200:
    # application.ex#L98-L116, connection_setup.ex#L150-L161 and #L258-L261.
    # https://github.com/electric-sql/electric/blob/0f404200402f918a4b1596bc5c8a53479a435349/packages/sync-service/lib/electric/application.ex#L98-L116
    # https://github.com/electric-sql/electric/blob/0f404200402f918a4b1596bc5c8a53479a435349/packages/sync-service/lib/electric/postgres/replication_client/connection_setup.ex#L150-L161
    # https://github.com/electric-sql/electric/blob/0f404200402f918a4b1596bc5c8a53479a435349/packages/sync-service/lib/electric/postgres/replication_client/connection_setup.ex#L258-L261
    sql(
        f"CREATE SCHEMA {schema};CREATE TABLE {schema}.projection(org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,name text,context text,preview text,time_label text,outcome_label text,assigned_label text,unread boolean,PRIMARY KEY(org_id,target_kind,target_id));ALTER TABLE {schema}.projection REPLICA IDENTITY FULL;INSERT INTO {schema}.projection VALUES('{o}','known_conversation','{c}','Synthetic relay proof','Owned','Hello','Now','None','Unassigned',true);"
    )
    need(
        sql(
            f"SELECT NOT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='{publication}') AND NOT EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='{slot}')"
        )
        == "t",
        "Temporary Electric publication or slot already exists",
    )
    electric_id = docker(
        "run",
        "-d",
        "--name",
        electric_name,
        "--label",
        FIXTURE_LABEL,
        "--network",
        NETWORK,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "-e",
        "DATABASE_URL=postgres://postgres:postgres@sandra-inbox-stack-db:5432/sandra_inbox_t1?sslmode=disable",
        "-e",
        "ELECTRIC_INSECURE=true",
        "-e",
        "ELECTRIC_DB_POOL_SIZE=2",
        "-e",
        "ELECTRIC_MANUAL_TABLE_PUBLISHING=true",
        "-e",
        "ELECTRIC_REPLICATION_STREAM_ID=" + stream,
        "-e",
        "ELECTRIC_LONG_POLL_TIMEOUT=8000",
        "-e",
        "ELECTRIC_TELEMETRY=false",
        candidate.image,
    )
    electric_id, electric_state = discover_owned(electric_name)
    need(electric_state["Config"]["Image"] == candidate.image, "Electric container image changed")
    for _ in range(60):
        if (
            sql(
                f"SELECT EXISTS(SELECT 1 FROM pg_publication WHERE pubname='{publication}' AND pubinsert AND pubupdate AND pubdelete AND pubtruncate) AND EXISTS(SELECT 1 FROM pg_replication_slots WHERE slot_name='{slot}' AND plugin='pgoutput' AND active)"
            )
            == "t"
        ):
            break
        time.sleep(0.25)
    else:
        raise RuntimeError("Electric-created publication/active slot unavailable")
    sql(f"ALTER PUBLICATION {publication} ADD TABLE {schema}.projection;")
    electric_ip = electric_state["NetworkSettings"]["Networks"][NETWORK]["IPAddress"]
    cid = docker(
        "run",
        "-d",
        "--name",
        container,
        "--label",
        FIXTURE_LABEL,
        "--network",
        NETWORK,
        "--add-host",
        "inbox-electric.railway.internal:" + electric_ip,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "512m",
        "--cpus",
        "0.5",
        "-p",
        "127.0.0.1::3000",
        "-e",
        "INBOX_RELAY_UPSTREAM=http://inbox-electric.railway.internal:3000/",
        "-e",
        "INBOX_RELAY_TOKEN=" + token,
        "-e",
        "INBOX_ELECTRIC_SECRET=" + electric_secret,
        "-e",
        "INBOX_RELAY_PROJECTION_TABLE=" + schema + ".projection",
        image["Id"],
    )
    cid, state = discover_owned(container)
    port = state["NetworkSettings"]["Ports"]["3000/tcp"][0]
    need(port["HostIp"] == "127.0.0.1" and state["Config"]["User"] == "node", "Unsafe relay binding/user")
    base = "http://127.0.0.1:" + port["HostPort"]

    def request(path, authorized=True):
        request_headers = {"Authorization": "Bearer " + token} if authorized else {}
        request = urllib.request.Request(base + path, headers=request_headers)
        try:
            with urllib.request.urlopen(request, timeout=16) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    # The pinned Electric image is linux/amd64 while this owned Colima fixture
    # runs linux/arm64 with emulation; allow its HTTP listener to become ready.
    for _ in range(60):
        try:
            if request("/health", False)[0] == 200:
                break
        except (urllib.error.URLError, http.client.HTTPException):
            pass
        time.sleep(0.25)
    else:
        raise RuntimeError("Relay readiness failed")

    from urllib.parse import urlencode

    query = urlencode(
        {
            "table": schema + ".projection",
            "columns": "org_id,target_kind,target_id,name,context,preview,time_label,outcome_label,assigned_label,unread",
            "replica": "default",
            "offset": "-1",
            "where": "org_id=$1",
            "params[1]": o,
        }
    )
    need(request("/v1/shape?" + query, False)[0] == 401, "Unauthenticated relay request admitted")
    status, headers, body = request("/v1/shape?" + query)
    need(status == 200, "Real shape status " + str(status) + ": " + body.decode()[:200])
    messages = json.loads(body)
    rows = [m["value"] for m in messages if m.get("headers", {}).get("operation") == "insert"]
    need(len(rows) == 1 and rows[0]["org_id"] == o and rows[0]["target_id"] == c, "Wrong synthetic row")
    need(token.encode() not in body, "Secret leaked")
    lower_headers = {key.lower(): value for key, value in headers.items()}
    from urllib.parse import parse_qs

    polling = parse_qs(query)
    polling = {key: values[0] for key, values in polling.items()}
    polling.update({"offset": lower_headers["electric-offset"], "handle": lower_headers["electric-handle"], "live": "true"})
    began = time.monotonic()
    quiet_status, _, _ = request("/v1/shape?" + urlencode(polling))
    elapsed = time.monotonic() - began
    need(quiet_status in [200, 204] and 6.5 < elapsed < 12, "Idle long-poll timeout mismatch: " + str((quiet_status, elapsed)))
    result = {
        "checks": [
            "built nonroot/read-only/capped relay reaches actual pinned Electric readiness",
            "Electric itself created the derived publication and active pgoutput replication slot",
            "unauthenticated real shape request denied",
            "authenticated actual Electric shape returns exact owned canonical projection row",
            "configured8000ms idle poll completes below relay14s deadline",
        ],
        "image_id": image["Id"],
        "electric_image": candidate.repository_digest,
        "electric_upstream_commit": ELECTRIC_SOURCE_COMMIT,
        "node_version": docker("exec", cid, "node", "--version"),
        "source_sha256": hashlib.sha256((P / "server.mjs").read_bytes()).hexdigest(),
        "dockerfile_sha256": hashlib.sha256((P / "Dockerfile").read_bytes()).hexdigest(),
        "runner_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "rows": rows,
        "idle_poll_seconds": round(elapsed, 3),
        "idle_poll_status": quiet_status,
        "source_commit": SANDRA_IMAGE_SOURCE_COMMIT,
        "upstream_commit": ELECTRIC_SOURCE_COMMIT,
        "workflow": {
            "source_commit": SANDRA_IMAGE_SOURCE_COMMIT,
            "upstream_commit": ELECTRIC_SOURCE_COMMIT,
            "workflow_path": ".github/workflows/inbox-electric-image.yml",
            "attestation": candidate.attestation,
        },
        "limits": ["owned T1 fixture only; no Railway provision or production proof", "no end-to-end browser latency claim"],
    }
finally:
    if cid:
        state = json.loads(docker("inspect", cid))[0]
        need(state["Name"] == "/" + container and state["Config"].get("Labels", {}).get("com.bmh.inbox-fixture") == "sandra-inbox-hosting-candidate-owned", "Cleanup identity changed")
        if state["State"]["Running"]:
            docker("stop", "-t", "2", cid)
        docker("rm", cid)
    if electric_id:
        state = json.loads(docker("inspect", electric_id))[0]
        need(state["Name"] == "/" + electric_name and state["Config"].get("Labels", {}).get("com.bmh.inbox-fixture") == "sandra-inbox-hosting-candidate-owned", "Electric cleanup identity changed")
        if state["State"]["Running"]:
            docker("stop", "-t", "2", electric_id)
        docker("rm", electric_id)
        sql(f"SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='{slot}' AND database=current_database() AND NOT active;")
        sql(f"DROP PUBLICATION IF EXISTS {publication};")
        need(sql(f"SELECT count(*) FROM pg_replication_slots WHERE slot_name='{slot}'") == "0", "Temporary slot remained")
    if sql(f"SELECT to_regclass('{schema}.projection') IS NOT NULL") == "t":
        need(sql(f"SELECT count(*)=1 AND bool_and(org_id='{o}'::uuid) FROM {schema}.projection") == "t", "Cleanup rows changed")
        sql(f"DROP TABLE {schema}.projection;DROP SCHEMA {schema};")

if result is not None:
    result["cleanup"] = "Exact owned relay/Electric containers, slot/publication and synthetic table/schema removed; existing Electric and DB preserved"
    (P / "runtime-evidence.json").write_text(json.dumps(result, indent=2) + "\n")
    print("Five built relay/real Electric runtime groups passed; owned cleanup verified")
