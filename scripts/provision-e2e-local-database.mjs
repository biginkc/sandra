import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import path from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
  throw new Error('Disposable E2E provisioning requires a GitHub runner');
}
const workdir = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'sandra-e2e-'));
function publish(name, value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid environment value');
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}
// Publish before startup so always-cleanup can find a partially started stack.
publish('E2E_LOCAL_WORKDIR', workdir);
const run = (...args) => execFileSync('supabase', args, { stdio: ['ignore', 'pipe', 'inherit'] });
run('init', '--workdir', workdir);
cpSync('supabase/migrations', path.join(workdir, 'supabase/migrations'), { recursive: true });
run('start', '--workdir', workdir);
const status = JSON.parse(run('status', '--workdir', workdir, '--output', 'json').toString());
if (status.API_URL !== 'http://127.0.0.1:54321' || status.DB_URL !== 'postgresql://postgres:postgres@127.0.0.1:54322/postgres') {
  throw new Error('Unexpected disposable stack endpoints');
}
for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY']) {
  if (typeof status[key] !== 'string' || !status[key] || /[\r\n]/.test(status[key])) throw new Error('Invalid local key');
  console.log(`::add-mask::${status[key]}`);
}
// Preserve FINAL_OWNER_GUARD during exact-run account deletion. This separate
// stack-owned baseline survives principal cleanup and is removed with the DB.
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await admin.auth.admin.createUser({
  email: `e2e-baseline-${randomUUID()}@example.invalid`,
  password: randomUUID() + randomUUID(),
  email_confirm: true,
  app_metadata: { purpose: 'disposable-e2e-baseline' },
});
if (error || !data.user) throw new Error('Disposable baseline owner creation failed');
const { error: membershipError } = await admin.from('memberships').upsert({
  user_id: data.user.id,
  org_id: '00000000-0000-0000-0000-000000000bbb',
  role: 'owner',
}, { onConflict: 'user_id,org_id' });
if (membershipError) throw new Error('Disposable baseline owner membership failed');
publish('E2E_DISPOSABLE_DATABASE', '1');
publish('TEST_SUPABASE_URL', status.API_URL);
publish('TEST_SUPABASE_ANON_KEY', status.ANON_KEY);
publish('TEST_SUPABASE_SERVICE_ROLE_KEY', status.SERVICE_ROLE_KEY);
publish('E2E_CI_SUPABASE_DB_URL', status.DB_URL);
