import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/inbox-heavy-verification.yml', 'utf8');
export function validateWorkflow(source) {
  if (/secrets\.(?!GITHUB_TOKEN\b)/i.test(source)) throw new Error('Non-GITHUB_TOKEN secret');
  if (/^\s*environment\s*:/mi.test(source)) throw new Error('Environment binding');
  if (/ncsngxlcyxylaeskiteu|copflsklaefwzipsrjqz/i.test(source)) throw new Error('Hosted project ref');
  if (/\b(?:supabase\s+)?(?:db\s+(?:push|link)|supabase\s+link)\b/i.test(source)) throw new Error('Hosted migration command');
  const permissions = source.match(/^permissions:\s*\n((?:^[ \t]+[^\n]*\n)*)/m)?.[1];
  if (!permissions || permissions.trim().split('\n').map(line => line.trim()).sort().join('\n') !== 'contents: read\npackages: read') throw new Error('Workflow permissions must be contents: read and packages: read only');
  if (/pull_request_target\s*:/m.test(source)) throw new Error('pull_request_target forbidden');
  if (!/github\.event_name\s*==\s*'pull_request'\s*&&\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(source)) throw new Error('Same-repo PR gate');
  if (!/\[a-z0-9-\]\+/.test(source) || !/test -f "scripts\/inbox-ci\/\$HEAVY_LANE\.sh"/.test(source)) throw new Error('File-resolved lane guard');
  if (!/if:\s*always\(\)/.test(source) || !/github\.event_name/.test(source)) throw new Error('Artifact or event guard');
}
test('workflow static guard passes reviewed file', () => assert.doesNotThrow(() => validateWorkflow(workflow)));
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
]) test(`mutation-first workflow guard rejects ${label}`, () => assert.throws(() => validateWorkflow(mutated)));
