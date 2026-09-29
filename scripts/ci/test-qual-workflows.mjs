import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const paths = ['.github/workflows/qual-upstream.yml', '.github/workflows/qual-downstream.yml'];

function check(path, source) {
  assert.match(path, /\/qual-(upstream|downstream)\.yml$/);
  assert.doesNotMatch(path, /db-migrate-/);
  assert.doesNotMatch(source, /secrets\s*\./i);
  assert.doesNotMatch(source, /environment\s*:\s*Production\b/i);
  assert.doesNotMatch(source, /\bsupabase\b|\bdb\s+push\b|\bdb\s+link\b/i);
  const flow = yaml.load(source);
  assert.deepEqual(flow.permissions, {});
  assert.equal(Object.keys(flow.jobs).length, path.endsWith('qual-upstream.yml') ? 1 : 2);
  for (const job of Object.values(flow.jobs)) {
    assert.deepEqual(job.permissions, {});
  }
  if (path.endsWith('qual-upstream.yml')) {
    assert.equal(flow.name, 'QUAL Upstream');
    assert.deepEqual(Object.keys(flow.on), ['workflow_dispatch']);
    assert.equal(flow.jobs.ping.environment, undefined);
  } else {
    assert.equal(flow.name, 'QUAL Downstream');
    assert.deepEqual(Object.keys(flow.on), ['workflow_run']);
    assert.deepEqual(flow.on.workflow_run.workflows, ['QUAL Upstream']);
    assert.deepEqual(flow.on.workflow_run.types, ['completed']);
    assert.equal(flow.jobs['bind-upstream'].environment, undefined);
    assert.equal(flow.jobs['qual-gated'].needs, 'bind-upstream');
    assert.equal(flow.jobs['qual-gated'].environment, 'qual-gate');
    assert.match(flow.jobs['qual-gated'].if, /workflow_run\.conclusion\s*==\s*'success'/);
    assert.match(flow.jobs['qual-gated'].if, /workflow_run\.head_branch\s*==\s*'main'/);
    assert.match(flow.jobs['qual-gated'].if, /workflow_run\.event\s*==\s*'workflow_dispatch'/);
    assert.equal(flow.jobs['bind-upstream'].if, undefined);
    for (const name of ['bind-upstream', 'qual-gated']) {
      const steps = flow.jobs[name].steps;
      assert.ok(steps.some(step => step.uses === 'actions/upload-artifact@v4'));
    }
    const gatedSteps = flow.jobs['qual-gated'].steps;
    assert.equal(gatedSteps.length, 2);
    assert.match(gatedSteps[0].run, /echo 'QUAL gated job approved and started'/);
    assert.match(gatedSteps[0].run, /printf 'QUAL gated job completed/);
    assert.equal(gatedSteps[1].uses, 'actions/upload-artifact@v4');
    assert.equal(gatedSteps[1].with.path, 'qual-result.txt');
  }
}

for (const path of paths) {
  test(`QUAL static guard: ${path}`, () => check(path, readFileSync(resolve(root, path), 'utf8')));
}

const upstream = readFileSync(resolve(root, paths[0]), 'utf8');
const downstream = readFileSync(resolve(root, paths[1]), 'utf8');
const mutations = [
    [paths[0], upstream.replace('permissions: {}', 'permissions: { contents: write }'), 'write permission'],
    [paths[0], upstream.replace('permissions: {}', 'permissions: { actions: read }'), 'nonempty permission'],
    [paths[1], downstream.replace('permissions: {}', 'permissions: { contents: read }'), 'downstream permission'],
    [paths[1], downstream.replace('qual-gate', 'Production'), 'production environment'],
    [paths[1], downstream.replace('QUAL Upstream', 'Other Upstream'), 'wrong trigger'],
    [paths[1], downstream.replace('needs: bind-upstream', 'needs: other-job'), 'missing ordering'],
    [paths[1], `${downstream}\n# \${{ secrets.TOKEN }}\n`, 'secret expression'],
    [paths[1], `${downstream}\n# supabase db push\n`, 'database push'],
    [paths[1], downstream.replace("workflow_run.event == 'workflow_dispatch'", "workflow_run.event == 'push'"), 'wrong upstream event'],
    [paths[1], downstream.replace("echo 'QUAL gated job approved and started'", 'curl example.com'), 'gated side effect'],
];
for (const [path, source, label] of mutations) {
  test(`negative control rejects ${label}`, () => {
    assert.throws(() => check(path, source));
  });
}
