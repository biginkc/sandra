"""psql boundary for an owned, loopback Supabase perf fixture."""
import os
import subprocess
from urllib.parse import urlparse


def guard():
    if os.environ.get('E2E_DISPOSABLE_DATABASE') != '1':
        raise RuntimeError('Disposable marker missing')
    url = os.environ.get('PERF_DATABASE_URL', '')
    parsed = urlparse(url)
    if parsed.scheme not in ('postgres', 'postgresql') or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username != 'postgres' or parsed.path != '/postgres' or not parsed.port:
        raise RuntimeError('Refusing non-local perf database')
    if any(ref in url for ref in ('ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz')):
        raise RuntimeError('Refusing hosted project ref')
    marker = os.environ.get('PERF_STACK_ID', '')
    if not marker.startswith('sandra-heavy-perf-'):
        raise RuntimeError('Invalid disposable stack identity')
    got = sql('SELECT marker FROM install_fixture.perf_identity')
    if got != marker:
        raise RuntimeError('Wrong disposable database marker')


def sql(query, role='postgres', retry=False):
    if role not in ('postgres', 'supabase_admin'):
        raise RuntimeError('Unexpected SQL role')
    url = os.environ['PERF_DATABASE_URL']
    parsed = urlparse(url)
    if parsed.hostname not in ('127.0.0.1', 'localhost'):
        raise RuntimeError('Refusing non-local perf database')
    result = subprocess.run(['psql', url, '-XqAt', '-v', 'ON_ERROR_STOP=1'], input="SET statement_timeout='120s';SET lock_timeout='2s';" + query, text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"
