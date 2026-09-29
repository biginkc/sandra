import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('analyze_120k.py')


class Analyze120kTests(unittest.TestCase):
    def run_case(self, wall_ms, observed_ms):
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            with (run / 'after-samples.csv').open('w', newline='') as stream:
                writer = csv.writer(stream)
                writer.writerow(['operation', 'ms'])
                for operation in range(6):
                    writer.writerows((f'op-{operation}', 1) for _ in range(2000))
            nodes = ''.join(f'table-{n},{n}\n' for n in range(11))
            (run / 'before-relfilenodes.csv').write_text(nodes)
            (run / 'after-relfilenodes.csv').write_text(nodes)
            (run / '20260929000000_inbox_control_foundation.sql.json').write_text(json.dumps({
                'exit': 0, 'wall_ms': wall_ms,
                'access_exclusive_messages_observed_ms': observed_ms,
            }))
            process = subprocess.run([sys.executable, str(SCRIPT), str(run)], text=True, capture_output=True)
            return process, json.loads((run / 'analysis.json').read_text())

    def test_long_file_short_observed_hold_passes(self):
        process, analysis = self.run_case(900, 200)
        self.assertEqual(process.returncode, 0, process.stdout)
        self.assertEqual(analysis['foundation_file_wall_upper_ms'], 900)
        self.assertEqual(analysis['foundation_access_exclusive_messages_observed_ms'], 200)

    def test_long_observed_hold_fails(self):
        process, analysis = self.run_case(200, 501)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn('foundation lock', ' '.join(analysis['failures']))
        print(f'NEGATIVE CONTROL observed hold: {analysis["failures"]}')


if __name__ == '__main__':
    unittest.main()
