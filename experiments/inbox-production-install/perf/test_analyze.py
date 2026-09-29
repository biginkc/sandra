import copy
import csv
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from analyze import analyze, evaluate, percentile, THRESHOLDS
from perf_db import guard


class AnalyzeTests(unittest.TestCase):
    def test_database_guard_negative_controls(self):
        good = {'E2E_DISPOSABLE_DATABASE': '1', 'PERF_DATABASE_URL': 'postgresql://postgres:postgres@127.0.0.1:65432/postgres', 'PERF_STACK_ID': 'sandra-heavy-perf-1-1-1'}
        with patch.dict(os.environ, good, clear=True), patch('perf_db.sql', return_value=good['PERF_STACK_ID']):
            guard()
        for name, change in [('missing_disposable', {'E2E_DISPOSABLE_DATABASE': '0'}), ('hosted', {'PERF_DATABASE_URL': 'postgresql://postgres:postgres@ncsngxlcyxylaeskiteu.supabase.co:5432/postgres'}), ('wrong_role', {'PERF_DATABASE_URL': 'postgresql://readonly:x@127.0.0.1:65432/postgres'}), ('wrong_marker', {'PERF_STACK_ID': 'other'})]:
            with self.subTest(name=name), patch.dict(os.environ, {**good, **change}, clear=True), patch('perf_db.sql', return_value=good['PERF_STACK_ID']):
                with self.assertRaises(RuntimeError) as caught:
                    guard()
                print(f'NEGATIVE CONTROL {name}: {caught.exception}')

    def good(self):
        limits = THRESHOLDS['burst']
        return {
            'counts': {'scheduled': {'update': 10200, 'inbound': 2400}, 'completed': {'update': 10200, 'inbound': 2400}, 'failed': {'update': 0, 'inbound': 0}, 'worker': {'errors': 0, 'parent': 60, 'finish': 12000, 'parent_sources': 60}},
            'server': {'update': {'n': 10200, 'p95_ms': limits['server_p95_ms'], 'p99_ms': limits['server_p99_ms']}, 'inbound': {'n': 2400, 'p95_ms': 3, 'p99_ms': 5}},
            'client': {'update': {'n': 10200}, 'inbound': {'n': 2400}},
            'error_count': 0, 'error_codes': {}, 'deadlocks_delta': 0, 'max_lock_wait_log_ms': 20,
            'lock_logging': {'log_lock_waits': 'on', 'deadlock_timeout': '10ms'},
            'backlog': {'drain_first_zero_s': 2, 'at_end': {'elapsed_s': 180, 'dirty_pending': 0, 'maintained_queue': 0}, 'coverage': {'start_s': 0, 'end_s': 180, 'max_gap_s': 1}},
            'final_db': {'inbound': 2400, 'unknown': 240, 'total': 149400},
            'pg_stat_calls': {'update': 10200, 'inbound': 2400},
            'paired_gaps': {'n': 360, 'over_50ms': 0},
        }

    def test_nearest_rank(self):
        self.assertEqual(percentile([5, 1, 4, 2, 3], .5), 3)
        self.assertEqual(percentile([5, 1, 4, 2, 3], .95), 5)
        with self.assertRaises(ValueError):
            percentile([], .95)

    def test_thresholds_and_mutation_controls(self):
        good = self.good()
        self.assertEqual(evaluate(copy.deepcopy(good))['verdict'], 'PASS')
        mutations = {
            'latency_p95': lambda x: x['server']['update'].update(p95_ms=15.001),
            'latency_p99': lambda x: x['server']['inbound'].update(p99_ms=50.001),
            'missing_server_samples': lambda x: x['server']['update'].update(n=10199),
            'deadlock': lambda x: x.update(deadlocks_delta=1),
            'serialization': lambda x: x['error_codes'].update({'40001': 1}),
            'lock_wait': lambda x: x.update(max_lock_wait_log_ms=501),
            'missing_lock_logging': lambda x: x.pop('lock_logging'),
            'disabled_lock_logging': lambda x: x['lock_logging'].update(log_lock_waits='off'),
            'slow_lock_logging': lambda x: x['lock_logging'].update(deadlock_timeout='1s'),
            'undrained': lambda x: x['backlog'].update(drain_first_zero_s=None),
            'pair_cadence': lambda x: x['paired_gaps'].update(n=359),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                sample = copy.deepcopy(good)
                mutate(sample)
                actual = evaluate(sample)
                print(f'NEGATIVE CONTROL {name}: {actual["verdict"]} {actual["failures"]}')
                self.assertEqual(actual['verdict'], 'FAIL')

    def test_incomplete_client_and_backlog_controls(self):
        mutations = {
            'missing_update_client_samples': lambda x: x['client']['update'].update(n=0),
            'missing_inbound_client_samples': lambda x: x['client']['inbound'].update(n=2399),
            'truncated_backlog': lambda x: x['backlog']['coverage'].update(end_s=121),
            'backlog_gap': lambda x: x['backlog']['coverage'].update(max_gap_s=3),
            'missing_end_observation': lambda x: x['backlog']['at_end'].update(elapsed_s=179),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                result = self.good()
                mutate(result)
                scored = evaluate(result)
                print(f'NEGATIVE CONTROL {name}: {scored["verdict"]} {scored["failures"]}')
                self.assertEqual(scored['verdict'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
