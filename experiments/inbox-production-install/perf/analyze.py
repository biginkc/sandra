#!/usr/bin/env python3
"""Evaluate the D7-M3 burst using server execution logs and §17 thresholds."""
import argparse
import csv
import json
import math
import re
from pathlib import Path

THRESHOLDS = json.loads((Path(__file__).parent / 'thresholds.json').read_text())


def percentile(values, fraction):
    if not values:
        raise ValueError('No latency samples')
    if any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError('Invalid latency sample')
    return sorted(values)[math.ceil(len(values) * fraction) - 1]


def evaluate(result, limits=THRESHOLDS['burst']):
    failures = []
    if result.get('lock_logging') != {'log_lock_waits': 'on', 'deadlock_timeout': '10ms'}:
        failures.append('lock logging not live at 10ms')
    counts = result['counts']
    for kind, expected in [('update', limits['updates_per_s'] * limits['duration_s']), ('inbound', limits['inbound_per_s'] * limits['duration_s'])]:
        for field in ('scheduled', 'completed'):
            if counts[field].get(kind) != expected:
                failures.append(f'{field}.{kind} != {expected}')
        if counts['failed'].get(kind) != 0:
            failures.append(f'failed.{kind}')
        observed = result['server'].get(kind, {})
        if observed.get('n') != expected:
            failures.append(f'server.{kind}.n != {expected}')
        for key, limit in [('p95_ms', limits['server_p95_ms']), ('p99_ms', limits['server_p99_ms'])]:
            value = observed.get(key)
            if value is None or value > limit:
                failures.append(f'server.{kind}.{key} > {limit}')
    if result['error_count'] != 0 or counts['worker']['errors'] != 0:
        failures.append('client or worker errors')
    if counts['worker']['parent'] <= 0 or counts['worker']['finish'] <= 0 or counts['worker']['parent_sources'] != 60:
        failures.append('worker coverage missing')
    if result['deadlocks_delta'] > limits['max_deadlocks']:
        failures.append('deadlocks')
    for code in ('40001', '55P03'):
        if result['error_codes'].get(code, 0) > limits[f'max_{code}']:
            failures.append(code)
    wait = result['max_lock_wait_log_ms']
    if wait is None or wait > limits['max_lock_wait_ms']:
        failures.append('lock wait unmeasured or over limit')
    drain = result['backlog']['drain_first_zero_s']
    if drain is None or drain > limits['drain_s'] or result['backlog']['at_end']['dirty_pending'] != 0 or result['backlog']['at_end']['maintained_queue'] != 0:
        failures.append('capture backlog did not drain')
    if result.get('final_db') != {'inbound': limits['inbound_per_s'] * limits['duration_s'], 'unknown': 2 * limits['duration_s'], 'total': 147000 + limits['inbound_per_s'] * limits['duration_s']}:
        failures.append('final database reconciliation')
    if result.get('pg_stat_calls') != {'update': limits['updates_per_s'] * limits['duration_s'], 'inbound': limits['inbound_per_s'] * limits['duration_s']}:
        failures.append('pg_stat_statements call reconciliation')
    if result['paired_gaps']['n'] != 3 * limits['duration_s'] or result['paired_gaps']['over_50ms'] != 0:
        failures.append('same-conversation pair cadence')
    result['failures'] = failures
    result['verdict'] = 'FAIL' if failures else 'PASS'
    return result


def analyze(directory):
    summary = json.loads((directory / 'burst-summary.json').read_text())
    before = json.loads((directory / 'before.json').read_text())
    config_path = directory / 'lock-config-observed.txt'
    config = config_path.read_text().splitlines() if config_path.exists() else []
    lock_logging = dict(zip(('log_lock_waits', 'deadlock_timeout'), config)) if len(config) == 2 else None
    client = {'update': [], 'inbound': []}
    inbound = []
    with (directory / 'client-latencies.csv').open() as f:
        for row in csv.DictReader(f):
            client[row['kind']].append(float(row['wall_ms']))
            if row['kind'] == 'inbound':
                inbound.append(row)
    server = {'update': [], 'inbound': []}
    locks = []
    for line in (directory / 'pg-server.log').open(errors='replace'):
        match = re.search(r'duration: ([0-9.]+) ms\s+execute <unnamed>: (.+)', line)
        if match:
            query = match.group(2)
            kind = 'update' if query.startswith('UPDATE public.messages SET status=') else 'inbound' if query.startswith('INSERT INTO public.messages(id,org_id,conversation_id') else None
            if kind:
                server[kind].append(float(match.group(1)))
        match = re.search(r'acquired .* after ([0-9.]+) ms', line)
        if match:
            locks.append(float(match.group(1)))
    backlog = []
    with (directory / 'backlog.csv').open() as f:
        backlog = [{key: float(value) for key, value in row.items()} for row in csv.DictReader(f)]
    after = [row for row in backlog if row['elapsed_s'] >= THRESHOLDS['burst']['duration_s']]
    pairs = []
    for second in range(THRESHOLDS['burst']['duration_s']):
        for base in (0, 200, 400):
            match = [row for row in inbound if any(abs(float(row['scheduled_ms']) - (second * 1000 + base + offset)) < 1 for offset in (0, 25))]
            if len(match) == 2:
                pairs.append(abs(float(match[0]['started_ms']) - float(match[1]['started_ms'])))
    final = json.loads((directory / 'final-db.json').read_text())
    statements = json.loads((directory / 'pg-stat-statements.json').read_text())
    pg_stat_calls = {'update': 0, 'inbound': 0}
    for statement in statements:
        query = statement['query']
        if query.startswith('UPDATE public.messages SET status='):
            pg_stat_calls['update'] += int(statement['calls'])
        elif query.startswith('INSERT INTO public.messages(id,org_id,conversation_id'):
            pg_stat_calls['inbound'] += int(statement['calls'])
    result = {'final_db': final, 'pg_stat_calls': pg_stat_calls, 'counts': summary['counts'], 'error_count': len(summary['errors']), 'error_codes': {}, 'server': {}, 'client': {},
              'backlog': {'at_end': backlog[-1] if backlog else None, 'drain_first_zero_s': next((row['elapsed_s'] - 120 for row in after if row['dirty_pending'] == 0 and row['maintained_queue'] == 0), None)},
              'deadlocks_delta': (backlog[-1]['deadlocks'] - float(before['before']['deadlocks'])) if backlog else None,
              'lock_logging': lock_logging,
              'max_lock_wait_log_ms': max(locks, default=0), 'lock_log_events': len(locks),
              'paired_gaps': {'n': len(pairs), 'max_ms': max(pairs, default=None), 'over_50ms': sum(gap > 50 for gap in pairs)}}
    for error in summary['errors']:
        code = error['code']
        result['error_codes'][code] = result['error_codes'].get(code, 0) + 1
    for label, values in [('server', server), ('client', client)]:
        for kind, samples in values.items():
            result[label][kind] = {'n': len(samples), 'p50_ms': percentile(samples, .5) if samples else None, 'p95_ms': percentile(samples, .95) if samples else None, 'p99_ms': percentile(samples, .99) if samples else None}
    if not backlog:
        raise ValueError('No backlog samples')
    return evaluate(result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('run_dir', type=Path)
    args = parser.parse_args()
    output = analyze(args.run_dir)
    (args.run_dir / 'analysis.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(output, indent=2))
    raise SystemExit(0 if output['verdict'] == 'PASS' else 1)
