import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const WORKFLOW_PATH = '.github/workflows/inbox-electric-image.yml';
const EXPECTED_COMMIT = '0f404200402f918a4b1596bc5c8a53479a435349';
const EXPECTED_TAG = '@core/sync-service@1.8.1';
const EXPECTED_BUILDER_ACTIONS = {
  checkout: 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  login: 'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
  buildx: 'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
  build: 'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
  attest: 'actions/attest-build-provenance@62fc1d596301d0ab9914e1fec14dc5c8d93f65cd',
  upload: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
};

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

function parseWorkflow(source) {
  return yaml.load(source);
}

function collectUses(value, result = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectUses(entry, result);
  } else if (value && typeof value === 'object') {
    if (typeof value.uses === 'string') result.push(value.uses);
    for (const entry of Object.values(value)) collectUses(entry, result);
  }
  return result;
}

function buildSteps(parsed) {
  return parsed.jobs.build.steps;
}

function stepNamed(parsed, name) {
  const step = buildSteps(parsed).find((candidate) => candidate.name === name);
  assert.ok(step, `missing step: ${name}`);
  return step;
}

function assertWorkflow(source) {
  const parsed = parseWorkflow(source);
  const build = stepNamed(parsed, 'Build and push Electric sync-service');

  assert.deepEqual(parsed.on ?? parsed.true, { workflow_dispatch: {} }, 'workflow must be dispatch-only');
  assert.match(source, /if \[\[ "\$\{GITHUB_REF\}" != 'refs\/heads\/main' \]\]; then[\s\S]*?exit 1/);
  assert.match(source, /repository:\s+electric-sql\/electric/);
  assert.match(source, new RegExp(`ref:\\s+${EXPECTED_COMMIT}`));
  assert.doesNotMatch(source, /inputs\./, 'the upstream commit must not be an input');

  assert.match(source, /git rev-parse HEAD/);
  assert.match(source, /git ls-remote "\$UPSTREAM_REPO" 'refs\/tags\/@core\/sync-service@1\.8\.1\^\{\}'/);
  assert.match(source, /\[\[ "\$tag_commit" == "\$EXPECTED_COMMIT" \]\]/);
  assert.match(source, /@core\/sync-service@1\.8\.1/);

  const actionUses = collectUses(parsed);
  assert.ok(actionUses.length > 0, 'workflow must use actions');
  for (const action of actionUses) assert.match(action, /@[0-9a-f]{40}$/i, `action is not pinned: ${action}`);
  for (const action of Object.values(EXPECTED_BUILDER_ACTIONS)) assert.ok(actionUses.includes(action), `missing expected pinned action: ${action}`);

  assert.doesNotMatch(source, /\blatest\b/i, 'mutable latest tag is forbidden');
  assert.equal(build.with.context, './electric/packages/sync-service');
  assert.equal(build.with.file, './electric/packages/sync-service/Dockerfile');
  assert.match(build.with['build-contexts'], /^electric-telemetry=\.\/electric\/packages\/electric-telemetry$/m);
  assert.match(build.with['build-args'], /^ELECTRIC_VERSION=1\.8\.1$/m);
  assert.equal(build.with.platforms, 'linux/amd64');
  assert.equal(build.with.push, true);
  assert.equal(build.with.tags, 'ghcr.io/biginkc/inbox-electric:1.8.1-0f40420');

  const attestation = stepNamed(parsed, 'Attest image build provenance');
  assert.equal(attestation.uses, EXPECTED_BUILDER_ACTIONS.attest);
  assert.equal(attestation.with['push-to-registry'], true);
}

test('Electric image workflow baseline passes all source, supply-chain, and build guards', () => {
  assert.doesNotThrow(() => assertWorkflow(workflow));
});

const mutations = [
  ['fixed source commit', (source) => source.replaceAll(EXPECTED_COMMIT, 'd'.repeat(40))],
  ['tag check', (source) => source.replace(
    `tag_commit="$(git ls-remote "$UPSTREAM_REPO" 'refs/tags/${EXPECTED_TAG}^{}' | awk 'NR == 1 { print $1 }')"`,
    "tag_commit='not-checked'",
  )],
  ['action SHA pin', (source) => source.replace(EXPECTED_BUILDER_ACTIONS.checkout, 'actions/checkout@v5')],
  ['mutable latest tag', (source) => source.replace('inbox-electric:1.8.1-0f40420', 'inbox-electric:latest')],
  ['extra platform', (source) => source.replace('platforms: linux/amd64', 'platforms: linux/amd64,linux/arm64')],
  ['attestation step', (source) => source.replace(EXPECTED_BUILDER_ACTIONS.attest, EXPECTED_BUILDER_ACTIONS.upload)],
  ['main ref guard', (source) => source.replace(
    'if [[ "${GITHUB_REF}" != \'refs/heads/main\' ]]; then',
    'if false; then',
  )],
];

for (const [label, mutate] of mutations) {
  test(`natural mutation is rejected: ${label}`, () => {
    const mutated = mutate(workflow);
    assert.notEqual(mutated, workflow, `${label} mutator must change the workflow`);
    assert.throws(() => assertWorkflow(mutated));
  });
}
