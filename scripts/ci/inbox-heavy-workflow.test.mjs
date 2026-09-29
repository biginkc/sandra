import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { hasExactKeys } from '../outbox-db-contract/catalog-sections.mjs';

const workflow = readFileSync('.github/workflows/inbox-heavy-verification.yml', 'utf8');
// Update only after reviewing an intentional main workflow change: git show origin/main:.github/workflows/inbox-heavy-verification.yml | shasum -a 256
const MAIN_WORKFLOW_SHA256 = '3822fdf4f86ee707e9a2bcee81aaeedd41203cbe67a459c33bb7459c3bca554e';
export function assertUnchangedFromMain(source) {
  assert.equal(createHash('sha256').update(source).digest('hex'), MAIN_WORKFLOW_SHA256);
}
test('workflow stays byte-identical to pinned main YAML', () => assertUnchangedFromMain(workflow));
test('workflow drift is refused', () => assert.throws(() => assertUnchangedFromMain(`${workflow}\n`)));
export function validateWorkflow(source) {
  if (/secrets\.(?!GITHUB_TOKEN\b)/i.test(source)) throw new Error('Non-GITHUB_TOKEN secret');
  if (/^\s*environment\s*:/mi.test(source)) throw new Error('Environment binding');
  if (/ncsngxlcyxylaeskiteu|copflsklaefwzipsrjqz/i.test(source)) throw new Error('Hosted project ref');
  if (/\b(?:supabase\s+)?(?:db\s+(?:push|link)|supabase\s+link)\b/i.test(source)) throw new Error('Hosted migration command');
  const lines = source.split('\n');
  let workflowPermissions = false;
  for (let index = 0; index < lines.length; index++) {
    const block = /^([ \t]*)permissions\s*:\s*(.*)$/.exec(lines[index]);
    if (!block) continue;
    const indent = block[1].length;
    if (indent === 0) workflowPermissions = true;
    const entries = [];
    if (block[2]) entries.push(block[2]);
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (!next.trim()) { index++; continue; }
      const nextIndent = /^[ \t]*/.exec(next)[0].length;
      if (nextIndent <= indent) break;
      entries.push(next.trim());
      index++;
    }
    const permissions = Object.fromEntries(entries.map(entry => [entry, true]));
    if (entries.length !== 2 || !hasExactKeys(permissions, ['contents: read', 'packages: read'], value => value === true)) throw new Error('Workflow permissions must be contents: read and packages: read only');
  }
  if (!workflowPermissions) throw new Error('Workflow permissions must be contents: read and packages: read only');
  if (/pull_request_target\s*:/m.test(source)) throw new Error('pull_request_target forbidden');
  if (!/github\.event_name\s*==\s*'pull_request'\s*&&\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(source)) throw new Error('Same-repo PR gate');
  if (!/\[a-z0-9-\]\+/.test(source) || !/test -f "scripts\/inbox-ci\/\$HEAVY_LANE\.sh"/.test(source)) throw new Error('File-resolved lane guard');
  if (!/if:\s*always\(\)/.test(source) || !/github\.event_name/.test(source)) throw new Error('Artifact or event guard');
  const laneSteps = yaml.load(source).jobs.lane.steps;
  const stage = laneSteps.find(step => step.name === 'Stage current run record');
  const upload = laneSteps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  if (stage?.if !== 'always()' || stage.run !== 'node scripts/ci/stage-heavy-artifact.mjs' || upload?.if !== 'always()' || upload.with?.path !== '${{ runner.temp }}/heavy-upload/') throw new Error('Upload must stage the current run directory only');
  if (upload.with['include-hidden-files'] !== true) throw new Error('Upload must include hidden files');
}
test('workflow static guard passes reviewed file', () => assert.doesNotThrow(() => validateWorkflow(workflow)));
test('workflow static guard accepts exact job-level read permissions', () => assert.doesNotThrow(() => validateWorkflow(workflow.replace(/^  static:$/m, '  static:\n    permissions:\n      contents: read\n      packages: read'))));
for (const [label, injected] of [
  ['secret', 'env: ${{ secrets.SUPABASE_ACCESS_TOKEN }}'],
  ['environment', 'environment: Production'],
  ['TEST project', 'ncsngxlcyxylaeskiteu'],
  ['production project', 'copflsklaefwzipsrjqz'],
  ['db push', 'run: supabase db push'],
  ['link', 'run: supabase link'],
]) test(`mutation-first static guard rejects ${label}`, () => assert.throws(() => validateWorkflow(`${workflow}\n${injected}\n`)));
for (const [label, mutated] of [
  ['missing packages read', workflow.replace(/^  packages: read\n/m, '')],
  ['contents write', workflow.replace(/^  contents: read$/m, '  contents: write')],
  ['packages write', workflow.replace(/^  packages: read$/m, '  packages: write')],
  ['id-token', workflow.replace(/^  packages: read$/m, '  packages: read\n  id-token: write')],
  ['pull_request_target', workflow.replace(/^  pull_request:$/m, '  pull_request_target:')],
  ['job-level write permissions', workflow.replace(/^jobs:\s*$/m, 'jobs:\n  injected-job:\n    permissions: {id-token: write, contents: write}')],
  ['job-level multiline write permissions', workflow.replace(/^  static:$/m, '  static:\n    permissions:\n      contents: read\n      packages: read\n      id-token: write')],
  ['whole evidence tree upload', workflow.replace('path: ${{ runner.temp }}/heavy-upload/', 'path: docs/performance/inbox-redesign/evidence/')],
  ['hidden files excluded', workflow.replace('include-hidden-files: true', 'include-hidden-files: false')],
]) test(`mutation-first workflow guard rejects ${label}`, () => assert.throws(() => validateWorkflow(mutated)));
