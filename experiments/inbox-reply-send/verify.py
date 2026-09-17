#!/usr/bin/env python3
"""Bind reported owned-fixture evidence (run.py + concurrency.py) to its exact source; not a SQL rerun."""
import hashlib,json
from pathlib import Path
p=Path(__file__).resolve().parent

manifest=json.loads((p/'evidence.json').read_text())
sources=[p.parent/'inbox-reply-boundary/context.sql',p.parent/'inbox-reply-preparation/recipient.sql',p.parent/'inbox-reply-preparation/batch.sql',p.parent/'inbox-reply-review/setup.sql',p.parent/'inbox-reply-review/public-api.sql',p/'attempts.sql']
for path in sources:
    key=str(path.relative_to(p.parent))
    if hashlib.sha256(path.read_bytes()).hexdigest()!=manifest['sources'][key]:raise SystemExit(f'Stale run.py evidence: {key}')
if hashlib.sha256((p/'run.py').read_bytes()).hexdigest()!=manifest['runner_sha256']:raise SystemExit('Stale evidence: run.py')
if len(manifest['checks'])!=26:raise SystemExit('Expected twenty-six run.py proof groups')

concurrency=json.loads((p/'concurrency-evidence.json').read_text())
for path in sources:
    key=str(path.relative_to(p.parent))
    if hashlib.sha256(path.read_bytes()).hexdigest()!=concurrency['sources_sha256'][key]:raise SystemExit(f'Stale concurrency.py evidence: {key}')
if hashlib.sha256((p/'concurrency-setup.sql').read_bytes()).hexdigest()!=concurrency['setup_sha256']:raise SystemExit('Stale evidence: concurrency-setup.sql')
if hashlib.sha256((p/'concurrency.py').read_bytes()).hexdigest()!=concurrency['runner_sha256']:raise SystemExit('Stale evidence: concurrency.py')
if len(concurrency['checks'])!=26:raise SystemExit('Expected twenty-six concurrency.py proof groups')

# Cross-binding: both evidence files must be reporting on the SAME attempts.sql.
if manifest['sources']['inbox-reply-send/attempts.sql']!=concurrency['sources_sha256']['inbox-reply-send/attempts.sql']:
    raise SystemExit('run.py and concurrency.py evidence disagree on attempts.sql content')

# Lane 1 PR-E: accept()/recover()/operation_status() + dispatch_outbox proof
# (experiments/inbox-reply-send/accept-proof.py, run via --run-owned-fixture).
accept_evidence=json.loads((p/'accept-evidence.json').read_text())
accept_sources=[p.parent/'inbox-reply-boundary/context.sql',p.parent/'inbox-reply-preparation/recipient.sql',p.parent/'inbox-reply-preparation/batch.sql',p.parent/'inbox-reply-review/setup.sql',p.parent/'inbox-reply-review/public-api.sql',p/'attempts.sql',p/'accept.sql',p/'public-api.sql']
for path in accept_sources:
    key=str(path.relative_to(p.parent))
    if hashlib.sha256(path.read_bytes()).hexdigest()!=accept_evidence['sources'][key]:raise SystemExit(f'Stale accept-proof.py evidence: {key}')
if hashlib.sha256((p/'accept-proof.py').read_bytes()).hexdigest()!=accept_evidence['runner_sha256']:raise SystemExit('Stale evidence: accept-proof.py')
if manifest['sources']['inbox-reply-send/attempts.sql']!=accept_evidence['sources']['inbox-reply-send/attempts.sql']:
    raise SystemExit('run.py and accept-proof.py evidence disagree on attempts.sql content')
if len(accept_evidence['checks'])!=23:raise SystemExit('Expected twenty-three accept-proof.py proof groups')

# P2 (round 4, binding note): this file only binds evidence to the exact
# SOURCE bytes (a file-hash check) — it cannot detect an INSTALLED-definition
# mismatch, e.g. a restore in concurrency.py/run.py that reinstalls a stale,
# hand-typed copy of a function body instead of the current candidate in
# attempts.sql. That gap is closed at runtime, not here: concurrency.py's
# restore_fn()/assert_installed() helpers re-extract every restored function
# from attempts.sql and read back pg_get_functiondef() on the live database
# before each positive control, so a stale restore fails loudly inside the
# harness run itself rather than silently passing this hash check.
print('PR-D send-attempt ledger evidence (run.py + concurrency.py) matches its exact source; 52 proof groups bound')
print('PR-E accept/recover/operation_status evidence (accept-proof.py) matches its exact source; 23 proof groups bound')
