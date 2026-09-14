#!/usr/bin/env python3
"""Read-only integrity check; does not rerun the recorded database proof."""
import hashlib,json
from pathlib import Path
p=Path(__file__).resolve().parent
e=json.loads((p/'context-evidence.json').read_text())
for name,key in [('context.sql','source_sha256'),('context-test.py','runner_sha256')]:
 if hashlib.sha256((p/name).read_bytes()).hexdigest()!=e[key]: raise RuntimeError('Stale reply context proof: '+name)
if len(e['checks'])!=8: raise RuntimeError('Incomplete recorded proof')
c=json.loads((p/'context-concurrency-evidence.json').read_text())
for name,key in [('context.sql','source_sha256'),('context-concurrency.py','runner_sha256')]:
 if hashlib.sha256((p/name).read_bytes()).hexdigest()!=c[key]: raise RuntimeError('Stale concurrent reply context proof: '+name)
if len(c['checks'])!=2: raise RuntimeError('Incomplete concurrent proof')
print('Reply context source and rollback proof hashes match; no runtime rerun')
