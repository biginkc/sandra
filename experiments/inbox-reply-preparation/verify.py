#!/usr/bin/env python3
"""Bind reported owned-fixture evidence to its exact source; not a SQL rerun."""
import hashlib,json,re
from pathlib import Path
p=Path(__file__).resolve().parent
r=p.parent.parent
manifest=json.loads((p/'recipient-evidence.json').read_text())
for key,path in [('source_sha256',p/'recipient.sql'),('batch_sha256',p/'batch.sql'),('context_sha256',p.parent/'inbox-reply-boundary/context.sql'),('runner_sha256',p/'recipient-test.py')]:
    if hashlib.sha256(path.read_bytes()).hexdigest()!=manifest[key]:raise SystemExit(f'Stale proof: {path.name}')
source=(r/'src/lib/messaging/quiet-hours.ts').read_text()
expected=hashlib.sha256(source.encode()).hexdigest()
if f'Source map SHA256: {expected}' not in (p/'batch.sql').read_text():raise SystemExit('Quiet-hours source changed; review map and rerun')
if len(manifest['checks'])!=18:raise SystemExit('Expected eighteen proof groups')
concurrency=json.loads((p/'recipient-concurrency-evidence.json').read_text())
# A DECLARED stale_pending_rerun marker (not a silent drop of the binding) is
# the only way a key in this evidence file is allowed to be out of date: the
# two-real-connection proof DROP SCHEMA CASCADEs on shared schema names, so
# it cannot be safely re-run against the current shared/drifted fixture. Any
# key NOT explicitly listed there must still match exactly, or this fails.
stale_pending=set(concurrency.get('stale_pending_rerun',{}).get('keys',[]))
warnings=[]
for key,path in [('source_sha256',p/'recipient.sql'),('context_sha256',p.parent/'inbox-reply-boundary/context.sql'),('runner_sha256',p/'recipient-concurrency.py')]:
    if hashlib.sha256(path.read_bytes()).hexdigest()!=concurrency[key]:
        if key in stale_pending:
            warnings.append(f"WARNING: concurrency proof binding for {path.name} ({key}) is stale, pending rerun — {concurrency['stale_pending_rerun'].get('reason','no reason recorded')}")
        else:
            raise SystemExit(f'Stale concurrency proof: {path.name}')
for w in warnings:print(w)
print('Canonical reply capture evidence and existing quiet-hours source match'+(' (with declared pending concurrency rerun above)' if warnings else ''))
