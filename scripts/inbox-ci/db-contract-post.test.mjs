import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('POST keeps PRE rehearsal evidence through mutations and removes it on exit', () => {
  const source = readFileSync(new URL('./db-contract-post.sh', import.meta.url), 'utf8');
  const cleanup = source.match(/^db_contract_cleanup\(\) \{.*$/m)?.[0];
  const trap = source.match(/^trap 'heavy_lane_exit.* EXIT$/m)?.[0];
  const tail = source.slice(source.indexOf('mutations="${RUNNER_TEMP'));
  assert.ok(cleanup && trap && tail.startsWith('mutations='));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'db-contract-post-order-'));
  try {
    const marker = path.join(dir, 'observed');
    const shell = `set -euo pipefail
lane_env=''
rehearsal_dir="$(mktemp -d)"
export HEAVY_PRE_READONLY_OUTPUT="$rehearsal_dir/pre-readonly.json"
printf evidence > "$HEAVY_PRE_READONLY_OUTPUT"
heavy_lane_exit() { local code="$1"; "$2"; return "$code"; }
${cleanup}
${trap}
node() { [[ -f "$HEAVY_PRE_READONLY_OUTPUT" ]] && printf present > "$MARKER"; }
${tail}
`;
    const run = spawnSync('bash', ['-c', shell], { encoding: 'utf8', env: { ...process.env, HEAVY_TESTED_SHA: 'test', RUNNER_TEMP: dir, MARKER: marker } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'present');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
