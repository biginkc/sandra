import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const WORKFLOW_PATH = '.github/workflows/inbox-electric-image.yml';
const LICENSE_WRAPPER_PATH = '.github/docker/inbox-electric-license.Dockerfile';
const EXPECTED_COMMIT = '0f404200402f918a4b1596bc5c8a53479a435349';
const EXPECTED_TAG = '@core/sync-service@1.8.1';
const EXPECTED_PUBLISH_TOKEN = 'EIMG-R1-PUBLIC-OK';
const EXPECTED_BUILDER_ACTIONS = {
  checkout: 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  login: 'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
  buildx: 'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
  build: 'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
  attest: 'actions/attest-build-provenance@62fc1d596301d0ab9914e1fec14dc5c8d93f65cd',
  upload: 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
};

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const licenseWrapper = readFileSync(LICENSE_WRAPPER_PATH, 'utf8');

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

function stepIndex(parsed, name) {
  const index = buildSteps(parsed).findIndex((candidate) => candidate.name === name);
  assert.notEqual(index, -1, `missing step: ${name}`);
  return index;
}

function assertPublishGuardFailClosed(parsed) {
  const approvalIndex = stepIndex(parsed, 'Require recorded EIMG-R1 public-publish approval');
  for (const name of [
    'Check out pinned upstream Electric source',
    'Log in to GHCR with the workflow token',
    'Build upstream Electric sync-service',
    'Build and push Electric sync-service',
  ]) {
    assert.ok(approvalIndex < stepIndex(parsed, name), `publish guard must precede ${name}`);
  }

  const approval = stepNamed(parsed, 'Require recorded EIMG-R1 public-publish approval');
  const push = stepNamed(parsed, 'Build and push Electric sync-service');
  assert.equal(approval.if, undefined, 'publish guard must use GitHub\'s default success condition');
  assert.equal(approval['continue-on-error'], undefined, 'publish guard failure must stop the job');
  assert.equal(push.if, undefined, 'push must not override the default success condition');
  assert.equal(push['continue-on-error'], undefined, 'push must not ignore an earlier guard failure');
  assert.match(approval.run, /\bexit 1\b/, 'publish guard must have a failing exit path');
}

function assertWorkflow(source) {
  const parsed = parseWorkflow(source);
  const approval = stepNamed(parsed, 'Require recorded EIMG-R1 public-publish approval');
  const setupBuildx = stepNamed(parsed, 'Set up Docker Buildx');
  const repoCheckout = stepNamed(parsed, 'Check out this Sandra repository at the workflow SHA');
  const upstreamCheckout = stepNamed(parsed, 'Check out pinned upstream Electric source');
  const stageLicenses = stepNamed(parsed, 'Stage upstream license files');
  const upstreamBuild = stepNamed(parsed, 'Build upstream Electric sync-service');
  const build = stepNamed(parsed, 'Build and push Electric sync-service');
  const upstreamLicenseFiles = stepNamed(parsed, 'Record upstream image license paths before wrapper COPY');

  assertPublishGuardFailClosed(parsed);

  assert.deepEqual(parsed.on ?? parsed.true, { workflow_dispatch: {} }, 'workflow must be dispatch-only');
  assert.equal(approval.env.INBOX_ELECTRIC_PUBLISH_OK, '${{ vars.INBOX_ELECTRIC_PUBLISH_OK }}');
  assert.equal(approval.env.INBOX_ELECTRIC_VISIBILITY, '${{ vars.INBOX_ELECTRIC_VISIBILITY }}');
  assert.match(approval.run, /publish_ok="\$\{INBOX_ELECTRIC_PUBLISH_OK:-\}"/);
  assert.match(approval.run, new RegExp(`\\[\\[ "\\$publish_ok" != '${EXPECTED_PUBLISH_TOKEN}' \\]\\]`));
  assert.match(approval.run, /\[\[ -n "\$visibility" && "\$visibility" != 'public' \]\]/);
  assert.match(source, /if \[\[ "\$\{GITHUB_REF\}" != 'refs\/heads\/main' \]\]; then[\s\S]*?exit 1/);
  assert.equal(repoCheckout.uses, EXPECTED_BUILDER_ACTIONS.checkout);
  assert.equal(repoCheckout.with.ref, '${{ github.sha }}');
  assert.equal(repoCheckout.with['persist-credentials'], false);
  assert.equal(repoCheckout.with.path, '.');
  assert.equal(repoCheckout.with.repository, undefined, 'root checkout must use the current repository');
  assert.equal(upstreamCheckout.with.path, 'electric');
  assert.equal(upstreamCheckout.with['persist-credentials'], false);
  assert.notEqual(repoCheckout.with.path, upstreamCheckout.with.path, 'the two checkouts must not share a path');
  assert.ok(
    stepIndex(parsed, 'Require dispatch from main') < stepIndex(parsed, 'Check out this Sandra repository at the workflow SHA'),
    'Sandra checkout must follow the main-ref guard',
  );
  assert.ok(
    stepIndex(parsed, 'Require recorded EIMG-R1 public-publish approval') < stepIndex(parsed, 'Check out this Sandra repository at the workflow SHA'),
    'Sandra checkout must follow the publish-approval guard',
  );
  assert.ok(
    stepIndex(parsed, 'Check out this Sandra repository at the workflow SHA') < stepIndex(parsed, 'Check out pinned upstream Electric source'),
    'Sandra checkout must precede the upstream checkout',
  );
  assert.match(source, /repository:\s+electric-sql\/electric/);
  assert.match(source, new RegExp(`ref:\\s+${EXPECTED_COMMIT}`));
  assert.doesNotMatch(source, /inputs\./, 'the upstream commit must not be an input');

  assert.match(source, /git rev-parse HEAD/);
  assert.match(source, /git rev-parse '@core\/sync-service@1\.8\.1\^\{commit\}'/);
  assert.match(source, /git ls-remote "\$UPSTREAM_REPO" 'refs\/tags\/@core\/sync-service@1\.8\.1\^\{\}'/);
  assert.match(source, /\[\[ "\$tag_commit" == "\$EXPECTED_COMMIT" \]\]/);
  assert.match(source, /@core\/sync-service@1\.8\.1/);
  assert.doesNotMatch(source, /^\s+result:\s+process\.env\.TAG_CHECK_RESULT$/m, 'tag_check_result must appear once in evidence');

  assert.equal(stageLicenses['working-directory'], 'electric');
  assert.match(stageLicenses.run, /cp LICENSE \.inbox-electric-licenses\/LICENSE/);
  assert.match(stageLicenses.run, /if \[\[ -f NOTICE \]\]/);
  assert.match(stageLicenses.run, /cp NOTICE \.inbox-electric-licenses\/NOTICE/);
  assert.equal(setupBuildx.with.driver, 'docker', 'the local wrapper image must be reusable by the second build');

  const actionUses = collectUses(parsed);
  assert.ok(actionUses.length > 0, 'workflow must use actions');
  for (const action of actionUses) assert.match(action, /@[0-9a-f]{40}$/i, `action is not pinned: ${action}`);
  for (const action of Object.values(EXPECTED_BUILDER_ACTIONS)) assert.ok(actionUses.includes(action), `missing expected pinned action: ${action}`);

  assert.doesNotMatch(source, /\blatest\b/i, 'mutable latest tag is forbidden');
  assert.equal(upstreamBuild.with.context, './electric/packages/sync-service');
  assert.equal(upstreamBuild.with.file, './electric/packages/sync-service/Dockerfile');
  assert.match(upstreamBuild.with['build-contexts'], /^electric-telemetry=\.\/electric\/packages\/electric-telemetry$/m);
  assert.match(upstreamBuild.with['build-args'], /^ELECTRIC_VERSION=1\.8\.1$/m);
  assert.equal(upstreamBuild.with.load, true);
  assert.equal(upstreamBuild.with.platforms, 'linux/amd64');
  assert.equal(upstreamBuild.with.tags, 'inbox-electric-upstream:1.8.1-0f40420');
  assert.equal(upstreamLicenseFiles.id, 'upstream-license-files');
  assert.ok(stepIndex(parsed, 'Build upstream Electric sync-service') < stepIndex(parsed, 'Record upstream image license paths before wrapper COPY'));
  assert.ok(stepIndex(parsed, 'Record upstream image license paths before wrapper COPY') < stepIndex(parsed, 'Build and push Electric sync-service'));
  assert.match(upstreamLicenseFiles.run, /docker export/);
  assert.match(upstreamLicenseFiles.run, /tar -tf/);
  assert.match(upstreamLicenseFiles.run, /grep -Fxq "\$path"/);
  assert.match(upstreamLicenseFiles.run, /echo "\$\{output_name\}=\$\{status\}" >> "\$GITHUB_OUTPUT"/);

  assert.equal(build.with.context, './electric');
  assert.equal(build.with.file, '.github/docker/inbox-electric-license.Dockerfile');
  assert.match(build.with['build-contexts'], /^upstream-electric=docker-image:\/\/inbox-electric-upstream:1\.8\.1-0f40420$/m);
  assert.equal(build.with.platforms, 'linux/amd64');
  assert.equal(build.with.push, true);
  assert.equal(build.with.tags, 'ghcr.io/biginkc/inbox-electric:1.8.1-0f40420');
  assert.match(source, /UPSTREAM_LICENSE: \$\{\{ steps\.upstream-license-files\.outputs\.license \}\}/);
  assert.match(source, /UPSTREAM_NOTICE: \$\{\{ steps\.upstream-license-files\.outputs\.notice \}\}/);
  assert.match(source, /upstream_image_files_before_wrapper_copy/);
  assert.match(source, /'\/LICENSE': process\.env\.UPSTREAM_LICENSE/);
  assert.match(source, /'\/NOTICE': process\.env\.UPSTREAM_NOTICE/);

  const repoCheckoutIndex = stepIndex(parsed, 'Check out this Sandra repository at the workflow SHA');
  const wrapperBuildIndex = stepIndex(parsed, 'Build and push Electric sync-service');
  const stepsThatReferenceRootCheckoutPaths = buildSteps(parsed)
    .map((step, index) => [step, index])
    .filter(([step]) => {
      const serialized = JSON.stringify(step);
      return serialized.includes(LICENSE_WRAPPER_PATH) || serialized.includes('.inbox-electric-licenses/');
    });
  assert.ok(stepsThatReferenceRootCheckoutPaths.length > 0, 'workflow must reference the wrapper and staged license paths');
  for (const [, index] of stepsThatReferenceRootCheckoutPaths) {
    assert.ok(repoCheckoutIndex < index, 'Sandra checkout must precede every wrapper or staged-license path reference');
  }
  assert.ok(repoCheckoutIndex < wrapperBuildIndex, 'Sandra checkout must precede the wrapper build');

  assert.match(licenseWrapper, /^FROM upstream-electric$/m);
  assert.deepEqual(
    licenseWrapper.match(/^COPY\s+.*\s+\/licenses\/.*$/gm),
    ['COPY .inbox-electric-licenses/ /licenses/'],
    'the wrapper must have one final COPY into /licenses',
  );

  const attestation = stepNamed(parsed, 'Attest image build provenance');
  assert.equal(attestation.uses, EXPECTED_BUILDER_ACTIONS.attest);
  assert.equal(attestation.with['push-to-registry'], true);
}

test('both checkout trees provide every workflow-referenced build path', () => {
  const parsed = parseWorkflow(workflow);
  const stageLicenses = stepNamed(parsed, 'Stage upstream license files');
  const upstreamBuild = stepNamed(parsed, 'Build upstream Electric sync-service');
  const build = stepNamed(parsed, 'Build and push Electric sync-service');
  const workspace = mkdtempSync(join(tmpdir(), 'inbox-electric-image-workspace-'));

  try {
    mkdirSync(join(workspace, '.github/docker'), { recursive: true });
    writeFileSync(join(workspace, build.with.file), licenseWrapper);

    const upstreamRoot = join(workspace, 'electric');
    mkdirSync(join(upstreamRoot, 'packages/sync-service'), { recursive: true });
    mkdirSync(join(upstreamRoot, 'packages/electric-telemetry'), { recursive: true });
    writeFileSync(join(upstreamRoot, 'packages/sync-service/Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(upstreamRoot, 'LICENSE'), 'upstream license\n');
    writeFileSync(join(upstreamRoot, 'NOTICE'), 'upstream notice\n');
    mkdirSync(join(upstreamRoot, '.inbox-electric-licenses'));
    writeFileSync(join(upstreamRoot, '.inbox-electric-licenses/LICENSE'), 'upstream license\n');
    writeFileSync(join(upstreamRoot, '.inbox-electric-licenses/NOTICE'), 'upstream notice\n');

    const referencedPaths = [
      resolve(workspace, stageLicenses['working-directory']),
      resolve(workspace, upstreamBuild.with.context),
      resolve(workspace, upstreamBuild.with.file),
      resolve(workspace, 'electric/packages/electric-telemetry'),
      resolve(workspace, build.with.context),
      resolve(workspace, build.with.file),
      resolve(workspace, 'electric/.inbox-electric-licenses'),
    ];

    for (const path of referencedPaths) {
      assert.ok(existsSync(path), `workflow-referenced path must exist in simulated workspace: ${path}`);
    }

    assert.ok(
      existsSync(resolve(workspace, 'electric/.inbox-electric-licenses/LICENSE')),
      'staged upstream LICENSE must remain inside the upstream checkout',
    );
    assert.ok(
      existsSync(resolve(workspace, '.github/docker/inbox-electric-license.Dockerfile')),
      'wrapper Dockerfile must remain inside the root checkout',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Electric image workflow baseline passes all source, supply-chain, and build guards', () => {
  assert.doesNotThrow(() => assertWorkflow(workflow));
});

const approvalStep = stepNamed(parseWorkflow(workflow), 'Require recorded EIMG-R1 public-publish approval');

function runApprovalGuard(overrides = {}) {
  const env = { ...process.env };
  delete env.INBOX_ELECTRIC_PUBLISH_OK;
  delete env.INBOX_ELECTRIC_VISIBILITY;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return spawnSync('bash', ['-c', approvalStep.run], { env, encoding: 'utf8' });
}

test('recorded public-publish guard rejects missing and blank approval variables', () => {
  for (const [label, env] of [['missing', {}], ['blank', { INBOX_ELECTRIC_PUBLISH_OK: '' }]]) {
    const result = runApprovalGuard(env);
    assert.notEqual(result.status, 0, `${label} approval variable must fail the guard`);
  }
});

test('recorded public-publish guard accepts the exact token and public visibility', () => {
  assert.equal(runApprovalGuard({ INBOX_ELECTRIC_PUBLISH_OK: EXPECTED_PUBLISH_TOKEN }).status, 0);
  assert.equal(runApprovalGuard({
    INBOX_ELECTRIC_PUBLISH_OK: EXPECTED_PUBLISH_TOKEN,
    INBOX_ELECTRIC_VISIBILITY: 'public',
  }).status, 0);
  assert.notEqual(runApprovalGuard({
    INBOX_ELECTRIC_PUBLISH_OK: EXPECTED_PUBLISH_TOKEN,
    INBOX_ELECTRIC_VISIBILITY: 'private',
  }).status, 0);
});

test('a failed publish guard cannot reach the image push step', () => {
  const parsed = parseWorkflow(workflow);
  assertPublishGuardFailClosed(parsed);
  assert.notEqual(runApprovalGuard().status, 0, 'missing approval must fail before any downstream step can run');
});

function movePublishGuardAfterPush(source) {
  const guardBlock = source.match(
    /      # Set INBOX_ELECTRIC_PUBLISH_OK[\s\S]*?(?=      - name: Check out pinned upstream Electric source\n)/,
  )?.[0];
  assert.ok(guardBlock, 'publish guard block must be present');
  const withoutGuard = source.replace(guardBlock, '');
  return withoutGuard.replace('      - name: Validate pushed image digest\n', `${guardBlock}      - name: Validate pushed image digest\n`);
}

function findSandraCheckoutBlock(source) {
  const block = source.match(
    /      - name: Check out this Sandra repository at the workflow SHA\n[\s\S]*?(?=      - name: Check out pinned upstream Electric source\n)/,
  )?.[0];
  assert.ok(block, 'Sandra checkout block must be present');
  return block;
}

function removeSandraCheckout(source) {
  return source.replace(findSandraCheckoutBlock(source), '');
}

function moveSandraCheckoutAfterWrapperBuild(source) {
  const block = findSandraCheckoutBlock(source);
  const withoutCheckout = source.replace(block, '');
  return withoutCheckout.replace(
    '      - name: Validate pushed image digest\n',
    `${block}      - name: Validate pushed image digest\n`,
  );
}

function dropSandraPersistCredentials(source) {
  const block = findSandraCheckoutBlock(source);
  const withoutPersistCredentials = block.replace('          persist-credentials: false\n', '');
  assert.notEqual(withoutPersistCredentials, block, 'Sandra checkout persist-credentials mutator must change the block');
  return source.replace(block, withoutPersistCredentials);
}

const mutations = [
  ['fixed source commit', (source) => source.replaceAll(EXPECTED_COMMIT, 'd'.repeat(40))],
  ['local release tag check', (source) => source.replace(
    `local_tag_commit="$(git rev-parse '${EXPECTED_TAG}^{commit}')"`,
    'local_tag_commit="$EXPECTED_COMMIT"',
  )],
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
  ['recorded publish guard', (source) => source.replace(
    /      # Set INBOX_ELECTRIC_PUBLISH_OK[\s\S]*?(?=      - name: Check out pinned upstream Electric source\n)/,
    '',
  )],
  ['publish guard after push', movePublishGuardAfterPush],
  ['publish guard with if condition', (source) => source.replace(
    '      - name: Require recorded EIMG-R1 public-publish approval\n',
    '      - name: Require recorded EIMG-R1 public-publish approval\n        if: always()\n',
  )],
  ['publish guard with continue-on-error', (source) => source.replace(
    '      - name: Require recorded EIMG-R1 public-publish approval\n',
    '      - name: Require recorded EIMG-R1 public-publish approval\n        continue-on-error: true\n',
  )],
  ['Sandra repository checkout', removeSandraCheckout],
  ['Sandra repository checkout after wrapper build', moveSandraCheckoutAfterWrapperBuild],
  ['Sandra repository checkout credentials', dropSandraPersistCredentials],
];

for (const [label, mutate] of mutations) {
  test(`natural mutation is rejected: ${label}`, () => {
    const mutated = mutate(workflow);
    assert.notEqual(mutated, workflow, `${label} mutator must change the workflow`);
    assert.throws(() => assertWorkflow(mutated));
  });
}
