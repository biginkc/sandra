import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const inboxManifest = JSON.parse(readFileSync('scripts/inbox-ci/inbox-migrations.json', 'utf8'));
const inboxExcludeArgs = inboxManifest.flatMap(entry => ['--exclude-migrations', `${entry.version}_${entry.name}.sql`]).join(' ');

for (const phase of ['pre', 'post']) {
  test(`outbox-${phase} reaches provisioning without a preset disposable flag`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), `outbox-${phase}-`));
    try {
      const stub = (name, source) => {
        const file = path.join(directory, name);
        writeFileSync(file, source);
        chmodSync(file, 0o755);
      };
      stub('git', '#!/bin/sh\nexit 0\n');
      stub('uname', '#!/bin/sh\necho Linux\n');
      stub('node', `#!/bin/sh
if [ "$1" = scripts/inbox-ci/inbox-migrations.mjs ]; then
  printf '%s\\n' ${inboxExcludeArgs}
  exit 0
fi
printf "%s\\n" "$*" >> "$PROVISION_MARKER"
exit 47
`);
      const marker = path.join(directory, 'provisioned');
      const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, HEAVY_LANE: `outbox-${phase}`, CI: '', PROVISION_MARKER: marker };
      delete env.E2E_DISPOSABLE_DATABASE;
      const result = spawnSync('bash', [`scripts/inbox-ci/outbox-${phase}.sh`], { env, encoding: 'utf8' });
      assert.equal(result.status, 47, result.stderr);
      assert.match(readFileSync(marker, 'utf8'), /^scripts\/ci\/provision-disposable-stack\.mjs --api-port 55421 --db-port 55422/m);

      stub('node', '#!/bin/sh\nexit 0\n');
      const missingFlag = spawnSync('bash', [`scripts/inbox-ci/outbox-${phase}.sh`], { env, encoding: 'utf8' });
      assert.equal(missingFlag.status, 1);
      assert.match(missingFlag.stderr, /Provisioner did not publish E2E_DISPOSABLE_DATABASE=1/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
