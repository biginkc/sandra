#!/usr/bin/env python3
"""Evaluate six after-install write latencies and conservative lock bound."""
import csv
import json
import math
import sys
from pathlib import Path

limits = json.loads((Path(__file__).parent / 'thresholds.json').read_text())['single_connection']
run = Path(sys.argv[1])
values = {}
with (run / 'after-samples.csv').open() as f:
    for row in csv.DictReader(f):
        values.setdefault(row['operation'], []).append(float(row['ms']))
failures = []
summary = {}
for operation, samples in values.items():
    ordered = sorted(samples)
    if len(samples) != 2000 or any(not math.isfinite(n) or n < 0 for n in samples):
        failures.append(f'{operation}: invalid sample set')
        continue
    p95 = ordered[math.ceil(len(samples) * .95) - 1]
    p99 = ordered[math.ceil(len(samples) * .99) - 1]
    summary[operation] = {'n': len(samples), 'p95_ms': p95, 'p99_ms': p99}
    if p95 > limits['p95_ms'] or p99 > limits['p99_ms']:
        failures.append(f'{operation}: latency threshold')
if len(values) != 6:
    failures.append('missing write operation')
before_nodes = (run / 'before-relfilenodes.csv').read_text()
after_nodes = (run / 'after-relfilenodes.csv').read_text()
if len(before_nodes.splitlines()) != 11 or before_nodes != after_nodes:
    failures.append('table rewrite or missing relfilenode evidence')
lock = json.loads((run / '20260930040000_inbox_control_foundation.sql.json').read_text())
observed_hold = lock.get('access_exclusive_messages_observed_ms')
if lock['exit'] != 0 or not isinstance(observed_hold, (int, float)) or not math.isfinite(observed_hold) or observed_hold < 0 or observed_hold > limits['foundation_access_exclusive_upper_ms']:
    failures.append('foundation lock upper bound')
result = {'kind': 'perf-120k', 'thresholds': limits, 'latencies': summary, 'foundation_file_wall_upper_ms': lock['wall_ms'], 'foundation_access_exclusive_messages_observed_ms': observed_hold, 'failures': failures, 'verdict': 'FAIL' if failures else 'PASS'}
(run / 'analysis.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
raise SystemExit(bool(failures))
