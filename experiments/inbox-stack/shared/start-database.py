#!/usr/bin/env python3
"""Start/reuse only the explicitly owned, synthetic local T1 database."""
import json
from pathlib import Path
import subprocess
import time

HOST = 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'
NAME = 'sandra-inbox-stack-db'
NETWORK = 'sandra-inbox-stack-t1'
IMAGE = 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
MARKER = 'sandra-inbox-stack-t1-owned-synthetic'
COMMAND = ['postgres', '-c', 'wal_level=logical', '-c', 'max_replication_slots=5',
           '-c', 'max_wal_senders=5', '-c', 'shared_buffers=64MB']

def docker(*args, check=True, input=None):
    return subprocess.run(['docker', '--host', HOST, *args], text=True,
                          capture_output=True, check=check, input=input)

networks = docker('network', 'ls', '--format', '{{.Name}}').stdout.splitlines()
if NETWORK not in networks:
    docker('network', 'create', '--label', 'purpose=sandra-inbox-t1', NETWORK)
network = json.loads(docker('network', 'inspect', NETWORK).stdout)[0]
assert network.get('Labels', {}).get('purpose') == 'sandra-inbox-t1', 'Unknown network'

names = docker('ps', '-a', '--format', '{{.Names}}').stdout.splitlines()
if NAME not in names:
    docker('pull', IMAGE)
    docker('run', '-d', '--name', NAME, '--label', 'purpose=sandra-inbox-t1',
           '--network', NETWORK, '--memory', '384m', '-p', '127.0.0.1:58782:5432',
           '-e', 'POSTGRES_DB=sandra_inbox_t1', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
           IMAGE, *COMMAND)
c = json.loads(docker('inspect', NAME).stdout)[0]
assert c['Config'].get('Labels', {}).get('purpose') == 'sandra-inbox-t1', 'Unknown container'
images = json.loads(docker('image', 'inspect', c['Image']).stdout)
assert any(x.endswith('@' + IMAGE.split('@')[1]) for x in images[0].get('RepoDigests', [])), 'Image mismatch'
assert c['Config']['Cmd'] == COMMAND, 'PostgreSQL config mismatch'
assert c['HostConfig']['Memory'] == 384 * 1024 * 1024, 'Memory limit mismatch'
assert not c['HostConfig']['Privileged'], 'Privileged container is not allowed'
assert c['HostConfig']['PortBindings'] == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '58782'}]}, 'Port mismatch'
assert set(c['NetworkSettings']['Networks']) == {NETWORK}, 'Network mismatch'
if not c['State']['Running']:
    docker('start', NAME)

def sql(statement):
    return docker('exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'sandra_inbox_t1',
                  '-At', '-v', 'ON_ERROR_STOP=1', input=statement)

for _ in range(30):
    if docker('exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'sandra_inbox_t1', check=False).returncode == 0:
        break
    time.sleep(.5)
else:
    raise SystemExit('Owned database did not become ready')

exists = sql("SELECT to_regclass('inbox_t1.fixture_identity') IS NOT NULL;").stdout.strip()
if exists == 'f':
    # Never replace a partially initialized/unrecognized schema.
    assert sql("SELECT count(*) FROM pg_namespace WHERE nspname='inbox_t1';").stdout.strip() == '0', 'Unrecognized existing schema'
    sql(Path(__file__).with_name('setup.sql').read_text())
assert sql('SELECT marker FROM inbox_t1.fixture_identity;').stdout.strip() == MARKER, 'Fixture marker mismatch'
print('Owned synthetic PostgreSQL is ready on 127.0.0.1:58782; existing fixture preserved.')
