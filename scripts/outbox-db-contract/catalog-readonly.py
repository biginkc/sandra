#!/usr/bin/env python3
"""Run the migration-owned catalog fingerprint with a repeatable-read assertion.

The migration branch supplies catalog_fingerprint.py and its scope manifest after
rebase. No copy of either file lives in this workstream.
"""
import importlib.util
import os
import re
import ssl
import hashlib
from pathlib import Path
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[2] / 'experiments/inbox-production-install/catalog_fingerprint.py'
if not SOURCE.is_file():
    raise SystemExit('CATALOG_TOOL_UNAVAILABLE: rebase migrations branch')
spec = importlib.util.spec_from_file_location('catalog_fingerprint', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = subprocess.run
HOSTED = os.environ.get('INBOX_CATALOG_HOSTED_TLS') == '1'
PIN = '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa'
if HOSTED:
    if (os.environ.get('PGSSLMODE') != 'verify-full' or
            os.environ.get('PGSSLROOTCERT') in (None, '', 'system') or
            os.environ.get('PGSSLMINPROTOCOLVERSION') != 'TLSv1.2' or
            os.environ.get('PGGSSENCMODE') != 'disable'):
        raise SystemExit('CATALOG_TLS_CONFIG_REFUSED')
    try:
        pem = Path(os.environ['PGSSLROOTCERT']).read_text()
        if pem.count('-----BEGIN CERTIFICATE-----') != 1:
            raise ValueError('exclusive CA required')
        digest = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
    except Exception as exc:
        raise SystemExit('CATALOG_TLS_CA_INVALID') from exc
    if digest != PIN:
        raise SystemExit('CATALOG_TLS_CA_PIN_MISMATCH')


def parse_conninfo(text):
    ssl_line = re.search(r'^SSL connection \(protocol: (TLSv1\.[23]), cipher: ([^,\n]+)', text, re.M)
    if not ssl_line or not re.search(r'^You are connected to database ', text, re.M):
        raise RuntimeError('CATALOG_TLS_EVIDENCE_MISSING')
    return ssl_line.group(1), ssl_line.group(2)


def guarded_run(*args, **kwargs):
    sql = kwargs.get('input', '')
    marker = 'BEGIN READ ONLY;\nSHOW transaction_read_only;'
    if marker not in sql:
        raise RuntimeError('Catalog transaction opening changed; review adapter')
    kwargs['input'] = ('\\conninfo\n' if HOSTED else '') + sql.replace(marker, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSHOW transaction_isolation;\nSHOW transaction_read_only;', 1)
    result = original(*args, **kwargs)
    if HOSTED:
        parse_conninfo(result.stdout)
        result.stdout = '\n'.join(line for line in result.stdout.splitlines() if not line.startswith(('You are connected to database ', 'SSL connection ('))) + '\n'
    lines = result.stdout.splitlines()
    if len(lines) < 4 or lines[0] != 'BEGIN' or lines[1] != 'repeatable read' or lines[2] != 'on':
        raise RuntimeError('READ_PRECONDITION_FAILED: catalog isolation/read-only assertion')
    result.stdout = '\n'.join([lines[0]] + lines[2:]) + '\n'
    return result


module.subprocess.run = guarded_run
sys.argv = [str(SOURCE)]
module.main()
