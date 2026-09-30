#!/usr/bin/env python3
"""Run the migration-owned catalog fingerprint with a repeatable-read assertion.

The migration branch supplies catalog_fingerprint.py and its scope manifest after
rebase. No copy of either file lives in this workstream.
"""
import importlib.util
import base64
import os
import re
import ssl
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parents[2] / 'experiments/inbox-production-install/catalog_fingerprint.py'
if not SOURCE.is_file():
    raise SystemExit('CATALOG_TOOL_UNAVAILABLE: rebase migrations branch')
spec = importlib.util.spec_from_file_location('catalog_fingerprint', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = subprocess.run
HOSTED = os.environ.get('INBOX_CATALOG_HOSTED_TLS') == '1'
LOCAL_TLS = os.environ.get('INBOX_CATALOG_LOCAL_TLS') == '1'
EVIDENCE = HOSTED or LOCAL_TLS
PIN = '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa'
PEM_BLOCK = re.compile(r'-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----')
CERTIFICATE = re.compile(r'(-----BEGIN CERTIFICATE-----\r?\n([\s\S]*?)\r?\n-----END CERTIFICATE-----)', re.S)
TABLE_FIELDS = {
    'Database', 'Client User', 'Host', 'Server Port', 'Options', 'Protocol Version',
    'Password Used', 'GSSAPI Authenticated', 'Backend PID', 'SSL Connection',
    'Superuser', 'Hot Standby', 'SSL Library', 'SSL Protocol', 'SSL Key Bits',
    'SSL Cipher', 'SSL Compression', 'ALPN', 'Host Address',
}


def exclusive_ca(path):
    try:
        text = Path(path).read_bytes().decode('ascii')
        blocks = PEM_BLOCK.findall(text)
        if len(blocks) != 1:
            raise ValueError('single CA required')
        match = CERTIFICATE.search(text)
        if not match:
            raise ValueError('single CA required')
        if len(blocks) == 1 and (text[:match.start()].strip() or text[match.end():].strip()):
            raise ValueError('single CA required')
        encoded = re.sub(r'\r?\n', '', match.group(2))
        if not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', encoded):
            raise ValueError('invalid certificate encoding')
        der = base64.b64decode(encoded, validate=True)
        if base64.b64encode(der).decode('ascii') != encoded:
            raise ValueError('invalid certificate encoding')
        pem = ssl.DER_cert_to_PEM_cert(der)
        if match.group(1).encode('ascii') != pem.rstrip('\r\n').encode('ascii'):
            raise ValueError('non-canonical certificate')
        return pem, hashlib.sha256(der).hexdigest()
    except Exception as exc:
        raise SystemExit('CATALOG_TLS_CA_INVALID') from exc


def install_exclusive_ca():
    if not EVIDENCE:
        return None
    pem, digest = exclusive_ca(os.environ['PGSSLROOTCERT'])
    if HOSTED and digest != PIN:
        raise SystemExit('CATALOG_TLS_CA_PIN_MISMATCH')
    fd, path = tempfile.mkstemp(prefix='sandra-catalog-ca-', suffix='.pem')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            fd = None
            handle.write(pem.encode('ascii'))
        os.environ['PGSSLROOTCERT'] = path
        return path
    except Exception:
        if fd is not None:
            os.close(fd)
        Path(path).unlink(missing_ok=True)
        raise


if EVIDENCE:
    if (os.environ.get('PGSSLMODE') != 'verify-full' or
            os.environ.get('PGSSLROOTCERT') in (None, '', 'system') or
            os.environ.get('PGSSLMINPROTOCOLVERSION') != 'TLSv1.2' or
            os.environ.get('PGGSSENCMODE') != 'disable'):
        raise SystemExit('CATALOG_TLS_CONFIG_REFUSED')
    if LOCAL_TLS and os.environ.get('PGHOST') not in ('127.0.0.1', 'localhost', '::1'):
        raise SystemExit('CATALOG_TLS_CONFIG_REFUSED')
def parse_conninfo(text):
    lines = text.splitlines()
    if 'BEGIN' in lines:
        lines = lines[:lines.index('BEGIN')]
    old_connection = re.fullmatch(
        r'You are connected to database "[^"\r\n]+" as user "[^"\r\n]+" '
        r'(?:on host "[^"\r\n]+"(?: \(address "[^"\r\n]+"\))?|'
        r'on address "[^"\r\n]+"|via socket in "[^"\r\n]+") at port "[0-9]+"\.',
        lines[0],
    ) if len(lines) == 2 else None
    old_ssl = re.fullmatch(
        r'SSL connection \(protocol: (TLSv1\.[23]), cipher: ([^,\r\n]+), '
        r'compression: (?:on|off), ALPN: (?:none|[^)\r\n]+)\)',
        lines[1],
    ) if len(lines) == 2 else None
    if old_connection and old_ssl:
        return old_ssl.group(1), old_ssl.group(2)
    if not lines or any(not re.fullmatch(r'[A-Za-z][A-Za-z ]*\|[^\r\n]*', line) for line in lines):
        raise RuntimeError('CATALOG_TLS_EVIDENCE_MISSING')
    table = {}
    for line in lines:
        key, value = line.split('|', 1)
        if key not in TABLE_FIELDS or key in table:
            raise RuntimeError('CATALOG_TLS_EVIDENCE_MISSING')
        table[key] = value
    expected = TABLE_FIELDS | {'Host Address'} if 'Host Address' in table else TABLE_FIELDS
    if set(table) != expected or table.get('SSL Connection') != 'true':
        raise RuntimeError('CATALOG_TLS_EVIDENCE_MISSING')
    protocol, cipher = table.get('SSL Protocol'), table.get('SSL Cipher')
    if protocol not in ('TLSv1.2', 'TLSv1.3') or not cipher:
        raise RuntimeError('CATALOG_TLS_EVIDENCE_MISSING')
    return protocol, cipher


def guarded_run(*args, **kwargs):
    sql = kwargs.get('input', '')
    marker = 'BEGIN READ ONLY;\nSHOW transaction_read_only;'
    if marker not in sql:
        raise RuntimeError('Catalog transaction opening changed; review adapter')
    kwargs['input'] = ('\\conninfo\n' if EVIDENCE else '') + sql.replace(marker, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSHOW transaction_isolation;\nSHOW transaction_read_only;', 1)
    result = original(*args, **kwargs)
    if EVIDENCE:
        parse_conninfo(result.stdout)
        lines = result.stdout.splitlines()
        if 'BEGIN' not in lines:
            raise RuntimeError('CATALOG_TLS_EVIDENCE_MISSING')
        result.stdout = '\n'.join(lines[lines.index('BEGIN'):]) + '\n'
    lines = result.stdout.splitlines()
    if len(lines) < 4 or lines[0] != 'BEGIN' or lines[1] != 'repeatable read' or lines[2] != 'on':
        raise RuntimeError('READ_PRECONDITION_FAILED: catalog isolation/read-only assertion')
    result.stdout = '\n'.join([lines[0]] + lines[2:]) + '\n'
    return result


module.subprocess.run = guarded_run
sys.argv = [str(SOURCE)]
temp_ca = install_exclusive_ca()
try:
    os.environ['LC_ALL'] = 'C'
    module.main()
finally:
    if temp_ca:
        Path(temp_ca).unlink(missing_ok=True)
